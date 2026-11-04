import { createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { hash } from '../journal';
import { ApiError, type Registration, type ServiceClientRegistration } from './schema';
import { MetadataStore } from './store';

export type Identity = { id: string; privateKey: KeyObject };
export type ProofIdentity = Identity | { id: string; sign: (bytes: Buffer) => Promise<Buffer> };
export function canonicalBody(value: unknown): string {
    if (value === undefined) return '';
    // Sign exactly the JSON wire value (undefined object fields are omitted).
    const walk = (v: any): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
        : Array.isArray(v) ? `[${v.map(walk).join(',')}]`
        : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
    return walk(JSON.parse(JSON.stringify(value)));
}

const message = (kind: string, id: string, grant: string, time: string, nonce: string, method: string, path: string, body: unknown) =>
    ['happy-control-v1', kind, id, grant, time, nonce, method.toUpperCase(), path, hash(canonicalBody(body))].join('\n');

/** A service has no signing private key. Its non-secret generation pins operator identity changes. */
export const serviceClientFingerprint = (client: ServiceClientRegistration) => hash(canonicalBody({ mode: 'service-token-v1', ...client }));

/** Ed25519 proof-of-possession. No browser cookies or Happy bearer accepted here. */
export function signedHeaders(identity: Identity, kind: 'client' | 'worker', method: string, path: string, body?: unknown, grantID = '', now = Date.now()) {
    const time = String(now), nonce = randomUUID();
    const signature = sign(null, Buffer.from(message(kind, identity.id, grantID, time, nonce, method, path, body)), identity.privateKey).toString('base64url');
    return { authorization: `HappyProof ${kind}.${identity.id}.${grantID || '-'}.${time}.${nonce}.${signature}` };
}
/** Signer-only provider support. No key export is needed by REST/worker/MCP. */
export async function proofHeaders(identity: ProofIdentity, kind: 'client' | 'worker', method: string, path: string, body?: unknown, grantID = '', now = Date.now()) {
    if ('privateKey' in identity) return signedHeaders(identity, kind, method, path, body, grantID, now);
    const time = String(now), nonce = randomUUID();
    const signature = (await identity.sign(Buffer.from(message(kind, identity.id, grantID, time, nonce, method, path, body)))).toString('base64url');
    return { authorization: `HappyProof ${kind}.${identity.id}.${grantID || '-'}.${time}.${nonce}.${signature}` };
}
export function verifyProof(header: unknown, expectedKind: 'client' | 'worker', method: string, path: string, body: unknown,
    registrations: Registration[], store: MetadataStore, now: number) {
    if (typeof header !== 'string' || header.length > 2048 || !header.startsWith('HappyProof ')) throw new ApiError('AUTH_REQUIRED', 401);
    const parts = header.slice(11).split('.');
    if (parts.length !== 6) throw new ApiError('INVALID_PROOF', 401);
    const [kind, id, grant, time, nonce, signature] = parts;
    const registration = registrations.find(r => r.id === id);
    if (kind !== expectedKind || !registration || !/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > 30000
        || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce) || (grant !== '-' && !/^[A-Za-z0-9_-]{1,128}$/.test(grant))) throw new ApiError('INVALID_PROOF', 401);
    const key = createPublicKey(registration.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(message(kind, id, grant === '-' ? '' : grant, time, nonce, method, path, body)), key, Buffer.from(signature, 'base64url'))) throw new ApiError('INVALID_PROOF', 401);
    // Persist a replay tombstone before accepting. Restarts do not reset proof replay protection.
    if (!store.claim(`proof:${kind}:${id}:${nonce}`, { expiresAt: Number(time) + 30000 })) throw new ApiError('PROOF_REPLAY', 409);
    return { registration, grantID: grant === '-' ? '' : grant };
}

/** Normal owner approval only; never persist or reuse this bearer for automation work. */
export function happyOwnerVerifier(relayUrl: string) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ApiError('INVALID_RELAY_URL');
    return async (authorization: string | undefined): Promise<string> => {
        if (!authorization?.startsWith('Bearer ')) throw new ApiError('OWNER_AUTH_REQUIRED', 401);
        try {
            const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/account/profile`, {
                headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(10000) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
            });
            if (!response.ok) throw new Error('owner rejected');
            const data = await response.json() as { id?: unknown };
            if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) throw new Error('bad profile');
            return data.id;
        } catch { throw new ApiError('OWNER_AUTH_REQUIRED', 401); }
    };
}
