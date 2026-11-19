import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError, identifier, type ServiceClientRegistration } from './schema';
import type { Grants } from './grants';
import type { MetadataStore } from './store';

const recordSchema = z.object({ version: z.literal(1), connectionID: identifier, clientID: identifier, userID: identifier,
    clientFingerprint: z.string().regex(/^[a-f0-9]{64}$/), digest: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
    /** Last successful bearer authentication; persisted at most once per minute. */
    lastUsedAt: z.number().int().positive().optional() }).strict();
const digest = (value: string) => createHash('sha256').update(value).digest();
export const isServiceAuthorization = (value: unknown) => typeof value === 'string' && /^Bearer\s+hsvc1\./i.test(value);

/** One 256-bit bearer per approved grant. Only its digest is durable; lost delivery is never replayed. */
export class ServiceTokens {
    constructor(private store: MetadataStore, private grants: Grants, private clients: ServiceClientRegistration[], private now = Date.now) {}
    static delete(store: MetadataStore, id: string) { store.delete(`service-token:${id}`); store.delete(`service-usage:${id}`); }
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
            // Older Controls strictly validate the credential record. Move usage first so a crash can resume migration.
            const {lastUsedAt, ...credential} = parsed.data;
            if (lastUsedAt !== undefined) {
                const key = `service-usage:${credential.connectionID}`;
                this.store.set(key, Math.max(lastUsedAt, this.store.get<number>(key) ?? 0));
                this.store.set(`service-token:${credential.connectionID}`, credential);
            }
        }
    }
    metadata(id: string) {
        const record = this.record(id);
        const lastUsedAt = record && this.store.get<number>(`service-usage:${id}`);
        return record ? { issued: true, issuedAt: record.issuedAt, expiresAt: record.expiresAt, ...(lastUsedAt ? {lastUsedAt} : {}) } : { issued: false };
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
    /** In-place renewal keeps the delivered bearer; align its record with the new grant expiry. */
    syncExpiry(id: string, expiresAt: number) {
        const record = this.record(id);
        if (!record || record.expiresAt === expiresAt) return;
        this.store.set(`service-token:${id}`, { ...record, expiresAt });
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
        this.touch(record.connectionID);
        return { registration, grantID: c.id };
    }
    /** Usage bookkeeping never blocks an authenticated call and never mutates the grant. */
    private touch(id: string) {
        const key = `service-usage:${id}`, now = this.now();
        try {
            const previous = this.store.get<number>(key);
            if (previous === null || now - previous >= 60000) this.store.set(key, now);
        } catch { /* Best-effort usage metadata. */ }
    }
}
