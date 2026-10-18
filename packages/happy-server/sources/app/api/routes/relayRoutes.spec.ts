import { beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Fastify } from '../types';

const { records, table } = vi.hoisted(() => {
    const records = new Map<string, any>();
    const table = {
        findUnique: vi.fn(async ({ where }: any) => records.get(where.id) ?? null),
        create: vi.fn(async ({ data }: any) => {
            const record = { ...data, seq: 0, metadataVersion: 0, agentStateVersion: 0 };
            records.set(data.id, record);
            return record;
        }),
        update: vi.fn(async ({ where, data }: any) => {
            const previous = records.get(where.id);
            const record = { ...previous, ...data, metadataVersion: previous.metadataVersion + 1, agentStateVersion: previous.agentStateVersion + 1 };
            records.set(where.id, record);
            return record;
        }),
    };
    return { records, table };
});
vi.mock('@/storage/db', () => ({ db: { $transaction: (run: any) => run({ session: table }) } }));
vi.mock('@/storage/seq', () => ({ allocateUserSeq: async () => 1 }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: { emitUpdate: vi.fn() }, buildNewSessionUpdate: (session: any) => session }));
vi.mock('@/app/presence/sessionCache', () => ({ activityCache: { resumeSessionUpdates: vi.fn() } }));
import { relayRoutes } from './relayRoutes';

const payload = { metadata: 'encrypted-metadata', agentState: 'encrypted-permission-request', dataEncryptionKey: null };
async function request(accountId = 'owner') {
    const app = fastify().withTypeProvider() as unknown as Fastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (req: any) => { req.userId = accountId; });
    relayRoutes(app);
    const response = await app.inject({ method: 'PUT', url: '/v1/relay/sessions/live-session', payload });
    await app.close();
    return response;
}

describe('registering a live session on another relay', () => {
    beforeEach(() => { records.clear(); vi.clearAllMocks(); });
    it('preserves the session identity and outstanding permission state without copying history', async () => {
        const response = await request();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: 'live-session', seq: 0, metadataVersion: 0, agentStateVersion: 0 });
        expect(records.get('live-session')).toMatchObject({ accountId: 'owner', ...payload, dataEncryptionKey: undefined });
    });
    it('does not replace a different account’s session', async () => {
        records.set('live-session', { id: 'live-session', accountId: 'someone-else' });
        const response = await request();
        expect(response.statusCode).toBe(409);
        expect(table.update).not.toHaveBeenCalled();
    });
    it('refreshes the live snapshot when switching back without deleting messages', async () => {
        records.set('live-session', { id: 'live-session', accountId: 'owner', seq: 23, metadataVersion: 5, agentStateVersion: 8 });
        const response = await request();
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ id: 'live-session', seq: 23, metadataVersion: 6, agentStateVersion: 9 });
    });
});
