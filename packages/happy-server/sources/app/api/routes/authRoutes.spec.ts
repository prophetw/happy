import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import nacl from 'tweetnacl';
import type { AddressInfo } from 'node:net';
import type { Fastify } from '../types';

const { state, dbMock, shutdownCallbacks } = vi.hoisted(() => {
    const state = {
        knownPublicKeys: new Map<string, string>(),
        terminal: { id: 'terminal-request', response: null as string | null, responseAccountId: null as string | null },
        account: { id: 'account-request', response: null as string | null, responseAccountId: null as string | null },
    };
    const requestTable = (kind: 'terminal' | 'account') => ({
        upsert: vi.fn(async () => state[kind]),
        findUnique: vi.fn(async () => state[kind]),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(state[kind], data)),
    });
    const dbMock = {
        account: {
            findUnique: vi.fn(async ({ where }: { where: { publicKey: string } }) => {
                const id = state.knownPublicKeys.get(where.publicKey);
                return id ? { id } : null;
            }),
            update: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
            upsert: vi.fn(async () => ({ id: 'new-account' })),
        },
        terminalAuthRequest: requestTable('terminal'),
        accountAuthRequest: requestTable('account'),
    };
    return { state, dbMock, shutdownCallbacks: [] as Array<() => Promise<void>> };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/utils/log', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/shutdown', () => ({
    shutdownSignal: new AbortController().signal,
    onShutdown: (_name: string, callback: () => Promise<void>) => {
        shutdownCallbacks.push(callback);
        return () => {};
    },
}));

import { auth } from '@/app/auth/auth';
import { authRoutes } from './authRoutes';
import { enableAuthentication } from '../utils/enableAuthentication';
import { startSocket } from '../socket';
import { activityCache } from '@/app/presence/sessionCache';

const allowedKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const outsiderKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8));
const pairingKey = Buffer.from(nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)).publicKey).toString('base64');

function loginPayload(key: nacl.SignKeyPair) {
    const challenge = nacl.randomBytes(32);
    return {
        publicKey: Buffer.from(key.publicKey).toString('base64'),
        challenge: Buffer.from(challenge).toString('base64'),
        signature: Buffer.from(nacl.sign.detached(challenge, key.secretKey)).toString('base64'),
    };
}

describe('private relay account access', () => {
    let app: Fastify;
    let allowedToken: string;
    let outsiderToken: string;
    let allowedGithubToken: string;
    let outsiderGithubToken: string;

    beforeAll(async () => {
        vi.stubEnv('HANDY_MASTER_SECRET', 'isolated-relay-access-test-master-secret');
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', '*');
        // Keep the auth cache cleanup timer out of these short-lived fixtures.
        vi.useFakeTimers();
        await auth.init();
        vi.useRealTimers();
        allowedToken = await auth.createToken('allowed-account');
        outsiderToken = await auth.createToken('outsider-account');
        allowedGithubToken = await auth.createGithubToken('allowed-account');
        outsiderGithubToken = await auth.createGithubToken('outsider-account');
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', 'allowed-account');
        vi.stubEnv('REDIS_URL', '');
        state.knownPublicKeys.clear();
        state.knownPublicKeys.set(Buffer.from(allowedKey.publicKey).toString('hex').toUpperCase(), 'allowed-account');
        state.knownPublicKeys.set(Buffer.from(outsiderKey.publicKey).toString('hex').toUpperCase(), 'outsider-account');
        state.terminal.response = state.account.response = null;
        state.terminal.responseAccountId = state.account.responseAccountId = null;

        app = fastify().withTypeProvider() as unknown as Fastify;
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        authRoutes(app);
        app.get('/protected', { preHandler: app.authenticate }, async request => ({ userId: request.userId }));
        await app.ready();
    });

    afterEach(async () => {
        for (const close of shutdownCallbacks.splice(0)) await close();
        await app.close();
    });

    afterAll(() => {
        activityCache.shutdown();
        vi.unstubAllEnvs();
    });

    it('permits the allowlisted account to log in with its signed challenge', async () => {
        const result = await app.inject({ method: 'POST', url: '/v1/auth', payload: loginPayload(allowedKey) });
        expect(result.statusCode).toBe(200);
        const protectedResult = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${result.json().token}` } });
        expect(protectedResult.json()).toEqual({ userId: 'allowed-account' });
    });

    it.each(['existing outsider', 'new account'])('rejects a valid signed login from an %s', async kind => {
        const key = kind === 'existing outsider' ? outsiderKey : nacl.sign.keyPair();
        const result = await app.inject({ method: 'POST', url: '/v1/auth', payload: loginPayload(key) });
        expect(result.statusCode).toBe(403);
        expect(result.json()).not.toHaveProperty('token');
        expect(dbMock.account.upsert).not.toHaveBeenCalled();
        expect(dbMock.account.update).not.toHaveBeenCalled();
    });

    it('still verifies the allowlisted account signature', async () => {
        const payload = loginPayload(allowedKey);
        payload.signature = Buffer.alloc(64).toString('base64');
        const result = await app.inject({ method: 'POST', url: '/v1/auth', payload });
        expect(result.statusCode).toBe(401);
    });

    it('denies an explicitly empty allowlist, including already cached tokens', async () => {
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', '');
        const result = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${allowedToken}` } });
        expect(result.statusCode).toBe(401);
        await expect(auth.createToken('allowed-account')).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects outsider tokens issued before the restriction, both cached and uncached', async () => {
        for (const uncached of [false, true]) {
            if (uncached) auth.invalidateToken(outsiderToken);
            const result = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${outsiderToken}` } });
            expect(result.statusCode).toBe(401);
        }
    });

    it('accepts comma-separated account IDs with whitespace', async () => {
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', ' allowed-account , another-account ');
        const result = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${allowedToken}` } });
        expect(result.statusCode).toBe(200);
    });

    it('rejects old OAuth state tokens belonging to an account outside the allowlist', async () => {
        expect(await auth.verifyGithubToken(allowedGithubToken)).toEqual({ userId: 'allowed-account' });
        expect(await auth.verifyGithubToken(outsiderGithubToken)).toBeNull();
    });

    it.each(['terminal', 'account'] as const)('keeps the allowed account %s pairing flow working', async kind => {
        const requestUrl = kind === 'terminal' ? '/v1/auth/request' : '/v1/auth/account/request';
        const responseUrl = kind === 'terminal' ? '/v1/auth/response' : '/v1/auth/account/response';
        const pending = await app.inject({ method: 'POST', url: requestUrl, payload: { publicKey: pairingKey } });
        expect(pending.json()).toEqual({ state: 'requested' });
        const approval = await app.inject({
            method: 'POST', url: responseUrl,
            headers: { authorization: `Bearer ${allowedToken}` },
            payload: { publicKey: pairingKey, response: 'encrypted-pairing-response' },
        });
        expect(approval.statusCode).toBe(200);
        const paired = await app.inject({ method: 'POST', url: requestUrl, payload: { publicKey: pairingKey } });
        expect(paired.statusCode).toBe(200);
        expect(paired.json().state).toBe('authorized');
        const protectedResult = await app.inject({ url: '/protected', headers: { authorization: `Bearer ${paired.json().token}` } });
        expect(protectedResult.json()).toEqual({ userId: 'allowed-account' });
    });

    it.each(['terminal', 'account'] as const)('does not issue a %s pairing token for an outsider account', async kind => {
        state[kind].response = 'previously-approved-pairing';
        state[kind].responseAccountId = 'outsider-account';
        const url = kind === 'terminal' ? '/v1/auth/request' : '/v1/auth/account/request';
        const result = await app.inject({ method: 'POST', url, payload: { publicKey: pairingKey } });
        expect(result.statusCode).toBe(403);
        expect(result.json()).not.toHaveProperty('token');
    });

    it.each([undefined, '*'])('preserves public-server registration when configured with %s', async value => {
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', value);
        const result = await app.inject({ method: 'POST', url: '/v1/auth', payload: loginPayload(nacl.sign.keyPair()) });
        expect(result.statusCode).toBe(200);
        expect(result.json().token).toBeTypeOf('string');
    });

    it.each(['allowed-account,', '*,allowed-account', 'allowed account'])('rejects malformed configuration %s at startup', async value => {
        vi.stubEnv('HAPPY_ALLOWED_ACCOUNT_IDS', value);
        await expect(auth.init()).rejects.toThrow('HAPPY_ALLOWED_ACCOUNT_IDS');
    });

    it('rejects outsider Socket.IO authentication while permitting the allowlisted account', async () => {
        await app.listen({ port: 0, host: '127.0.0.1' });
        startSocket(app);
        const port = (app.server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/v1/updates/?EIO=4&transport=polling`;
        async function connect(token: string) {
            const open = await fetch(base);
            const sid = JSON.parse((await open.text()).slice(1)).sid;
            await fetch(`${base}&sid=${sid}`, { method: 'POST', body: `40${JSON.stringify({ token })}` });
            return (await fetch(`${base}&sid=${sid}`)).text();
        }
        expect(await connect(outsiderToken)).toContain('44{"message":"Invalid authentication token"}');
        expect(await connect(allowedToken)).toMatch(/^40\{/);
    });
});
