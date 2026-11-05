import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError, identifier, type ServiceClientRegistration } from './schema';
import type { Grants } from './grants';
import type { MetadataStore } from './store';

const recordSchema = z.object({ version: z.literal(1), connectionID: identifier, clientID: identifier, userID: identifier,
    clientFingerprint: z.string().regex(/^[a-f0-9]{64}$/), digest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive() }).strict();
const digest = (value: string) => createHash('sha256').update(value).digest();
export const isServiceAuthorization = (value: unknown) => typeof value === 'string' && /^Bearer\s+hsvc1\./i.test(value);

/** One 256-bit bearer per approved grant. Only its digest is durable; lost delivery is never replayed. */
export class ServiceTokens {
    constructor(private store: MetadataStore, private grants: Grants, private clients: ServiceClientRegistration[], private now = Date.now) {}
    static delete(store: MetadataStore, id: string) { store.delete(`service-token:${id}`); }
    private record(id: string) {
        const raw = this.store.get<unknown>(`service-token:${id}`);
        if (raw === null) return null;
        const parsed = recordSchema.safeParse(raw);
        if (!parsed.success || parsed.data.connectionID !== id) throw new ApiError('STORE_UNAVAILABLE', 503);
        return parsed.data;
    }
    validateStore() {
        for (const raw of this.store.list<unknown>('service-token:')) {
            const parsed = recordSchema.safeParse(raw);
            if (!parsed.success || !this.record(parsed.data.connectionID)) throw new ApiError('STORE_UNAVAILABLE', 503);
        }
    }
    metadata(id: string) {
        const record = this.record(id);
        return record ? { issued: true, issuedAt: record.issuedAt, expiresAt: record.expiresAt } : { issued: false };
    }
    issue(id: string, userID: string) {
        const c = this.grants.owner(id, userID);
        if (c.credentialMode !== 'service-token-v1') throw new ApiError('SERVICE_TOKEN_MODE_REQUIRED', 403);
        this.grants.active(id, c.clientID);
        const token = `hsvc1.${id}.${randomBytes(32).toString('base64url')}`;
        const record = { version: 1, connectionID: id, clientID: c.clientID, userID, clientFingerprint: c.clientFingerprint,
            digest: digest(token).toString('hex'), issuedAt: this.now(), expiresAt: c.expiresAt };
        if (!this.store.claim(`service-token:${id}`, record)) throw new ApiError('SERVICE_TOKEN_ALREADY_ISSUED', 409);
        return { connectionID: id, token, expiresAt: c.expiresAt };
    }
    authenticate(header: unknown) {
        if (typeof header !== 'string' || header.length > 256) throw new ApiError('INVALID_SERVICE_TOKEN', 401);
        const match = /^Bearer (hsvc1\.([A-Za-z0-9_-]{1,128})\.[A-Za-z0-9_-]{43})$/.exec(header);
        if (!match) throw new ApiError('INVALID_SERVICE_TOKEN', 401);
        const record = this.record(match[2]);
        if (!record || !timingSafeEqual(digest(match[1]), Buffer.from(record.digest, 'hex'))) throw new ApiError('INVALID_SERVICE_TOKEN', 401);
        const c = this.grants.active(record.connectionID, record.clientID);
        const registration = this.clients.find(client => client.id === record.clientID && client.userID === record.userID);
        if (!registration || c.credentialMode !== 'service-token-v1' || c.userID !== record.userID || c.clientFingerprint !== record.clientFingerprint
            || c.expiresAt !== record.expiresAt) throw new ApiError('INVALID_SERVICE_TOKEN', 401);
        if (this.now() >= record.expiresAt) throw new ApiError('GRANT_EXPIRED', 403);
        return { registration, grantID: c.id };
    }
}
