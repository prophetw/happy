import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { callerConfigSchema, hostConfigSchema, type CallerConfig } from './config';
import { executeControlCall, readControlRequest, restCallerMain } from './caller';
import type { SecretProvider } from './secrets';

async function callerFixture() {
    // Same cross-package fixture boundary as production.test.ts; production rootDir stays src.
    const { fixtureRig } = await import(resolve('examples/rest-fixture.ts'));
    const rig = await fixtureRig(); const grant = await rig.connect(); await rig.startWorker();
    const credentials = join(rig.dir, 'caller-credentials'); mkdirSync(credentials, { mode: 0o700 });
    const passphrase = 'short-lived-caller-fixture-only';
    const encrypted = join(rig.dir, 'caller.encrypted.pem');
    writeFileSync(encrypted, rig.clientIdentity.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }), { mode: 0o600 });
    writeFileSync(join(credentials, 'caller-passphrase'), passphrase, { mode: 0o600 });
    const config: CallerConfig = { version: 1, role: 'caller', endpoint: 'https://control.fixture/happy-control/v1',
        registration: rig.clientRegistration, identityRef: 'caller', grantID: grant,
        secrets: { type: 'encrypted-pkcs8-credentials', credentialsDirectory: credentials,
            keys: { caller: { encryptedPKCS8: encrypted, passphraseCredential: 'caller-passphrase' } } } };
    const path = join(rig.dir, 'caller.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    // Real signed REST/worker/receipt over loopback; this does not claim native TLS integration.
    const fetchFixture: typeof fetch = (url, options) => {
        const target = new URL(String(url)); return fetch(rig.address + target.pathname + target.search, options);
    };
    return { rig, config, path, passphrase, fetchFixture,
        call: (tool: string, input: unknown) => restCallerMain(['--config', path], { tool, input }, { fetch: fetchFixture }) };
}

describe('fixed REST caller used by the assistant execution channel', () => {
    it('connection enrollment uses only configured scope and never picks another approved grant', async () => {
        const f = await callerFixture();
        try {
            const config: CallerConfig = { ...f.config, grantID: undefined, connectionScope: {
                workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], sessionIDs: [], expiresAt: Date.now() + 60000 } };
            expect((await executeControlCall(config, { tool: 'happy_machines', input: {} })).error.code).toBe('CONTROL_OWNER_APPROVAL_REQUIRED');
            expect((await executeControlCall(config, { tool: 'happy_request_connection', input: { methods: ['sessions.cancel'] } })).ok).toBe(false);
            const pending = await executeControlCall(config, { tool: 'happy_request_connection', input: {} }, { fetch: f.fetchFixture });
            expect(pending.ok).toBe(true);
            const id = pending.data.id;
            const consent = await f.rig.ownerRequest(`/connections/${id}/consent`);
            expect(consent.body.data.methods).toEqual(['machines.list']);
            await f.rig.ownerRequest(`/connections/${id}/approve`, 'POST', { digest: consent.body.data.digest, challenge: consent.body.data.challenge });
            expect((await executeControlCall({ ...config, grantID: id }, { tool: 'happy_machines', input: {} }, { fetch: f.fetchFixture })).ok).toBe(true);
            expect((await executeControlCall({ ...config, grantID: id }, { tool: 'happy_cancel', input: { sessionID: 'existing', requestID: 'not-allowed' } }, { fetch: f.fetchFixture })).ok).toBe(false);
        } finally { await f.rig.close(); }
    });
    it('keeps the default one-hour policy and requires explicit finite configuration for longer grants', () => {
        const config = { version: 1, role: 'host', listen: { host: '127.0.0.1', port: 9010 }, origin: 'https://control.fixture', relayURL: 'https://control.fixture/home-relay', stateDirectory: '/fixture/state', clients: [], workers: [] };
        expect(hostConfigSchema.parse(config).maxGrantMs).toBe(3600000);
        expect(hostConfigSchema.parse({ ...config, maxGrantMs: 7 * 86400000 }).maxGrantMs).toBe(7 * 86400000);
        expect(hostConfigSchema.safeParse({ ...config, maxGrantMs: 7 * 86400000 + 1 }).success).toBe(false);
    });
    it('loads only an encrypted, pinned identity and reuses task/send/cursor/result/cancel contracts', async () => {
        const f = await callerFixture();
        try {
            const task = { requestID: 'caller-task', machineID: 'machineA', projectID: 'projectA' };
            const created = await f.call('happy_create_task', task);
            expect(created.ok).toBe(true); expect(created.data.state).toBe('confirmed');
            const sessionID = created.data.sessionID;
            expect((await f.call('happy_create_task', task)).data.sessionID).toBe(sessionID);
            expect(f.rig.spawnCount).toBe(1);
            expect((await f.call('happy_send', { requestID: 'caller-send', sessionID, text: 'Isolated fixture instruction' })).data.state).toBe('queued');
            await f.rig.waitForSubmitted('', 'caller-send',()=>f.call('happy_request_status',{requestID:'caller-send'}));
            f.rig.complete(sessionID);
            expect((await f.call('happy_events', { sessionID, after_seq: 0, limit: 100 })).data.nextCursor).toBeGreaterThan(0);
            expect((await f.call('happy_result', { sessionID, turnID: 'turn1' })).data.outcome).toBe('completed');
            const cancel = await f.call('happy_cancel', { sessionID, requestID: 'caller-cancel' });
            expect(cancel.data.state).toBe('cancel_requested'); expect(cancel.data.process).toBe('unknown');
            expect(JSON.stringify(created)).not.toContain(f.passphrase);
        } finally { await f.rig.close(); }
    });
    it('a lost mutation response is unknown and the same requestID resolves without duplicate spawn', async () => {
        const f = await callerFixture(); let lost = false;
        try {
            const args = { requestID: 'caller-lost', machineID: 'machineA', projectID: 'projectA' };
            const fetchLost: typeof fetch = async (url, options) => {
                const result = await f.fetchFixture(url, options);
                if (!lost && String(url).endsWith('/tasks')) { lost = true; await result.arrayBuffer(); throw new Error('fixture lost reply'); }
                return result;
            };
            const result = await executeControlCall(f.config, { tool: 'happy_create_task', input: args }, { fetch: fetchLost });
            expect(result).toMatchObject({ version: 1, ok: false, error: { retryable: false }, data: { state: 'unknown', requestID: args.requestID } });
            const receipt = await f.call('happy_request_status', { requestID: args.requestID });
            expect(receipt.ok).toBe(true); expect(receipt.data.state).toBe('confirmed');
            expect((await f.call('happy_create_task', args)).data.sessionID).toBe(receipt.data.sessionID);
            expect(f.rig.spawnCount).toBe(1);
        } finally { await f.rig.close(); }
    });
    it('revocation remains fail closed through the direct caller', async () => {
        const f = await callerFixture();
        try {
            await f.rig.ownerRequest(`/connections/${f.config.grantID}`, 'DELETE');
            expect((await f.call('happy_machines', {})).error.code).toBe('GRANT_REVOKED');
        } finally { await f.rig.close(); }
    });
    it('rejects arbitrary tools, methods, endpoint overrides and bad JSON before loading credentials', async () => {
        const f = await callerFixture(); let loads = 0;
        const provider: SecretProvider = { identity: async () => { loads++; return f.rig.clientIdentity; }, close: async () => {} };
        try {
            for (const request of [{ tool: 'shell', input: {} }, { tool: '__proto__', input: {} },
                { tool: 'happy_machines', input: { url: 'https://other.invalid' } }, { tool: 'happy_machines', input: {}, method: 'DELETE' }]) {
                expect((await executeControlCall(f.config, request, { provider })).ok).toBe(false);
            }
            expect(loads).toBe(0);
            expect(callerConfigSchema.safeParse({ ...f.config, endpoint: 'https://user:password@other.invalid/happy-control/v1' }).success).toBe(false);
            await expect(readControlRequest(Readable.from(['{not-json']))).rejects.toMatchObject({ code: 'CONTROL_INPUT_INVALID' });
            await expect(readControlRequest(Readable.from([Buffer.alloc(512 * 1024 + 1)]))).rejects.toMatchObject({ code: 'CONTROL_INPUT_TOO_LARGE' });
        } finally { await f.rig.close(); }
    });
    it('provider failure and close failure expose neither diagnostics nor secrets', async () => {
        const f = await callerFixture(); const secret = 'fixture-private-diagnostic-value';
        try {
            const unavailable: SecretProvider = { identity: async () => { throw new Error(secret); }, close: async () => {} };
            const result = await executeControlCall(f.config, { tool: 'happy_machines', input: {} }, { provider: unavailable });
            expect(result).toMatchObject({ ok: false, error: { code: 'CONTROL_CREDENTIAL_UNAVAILABLE' } });
            expect(JSON.stringify(result)).not.toContain(secret);
            const cleanup: SecretProvider = { identity: async () => f.rig.clientIdentity, close: async () => { throw new Error(secret); } };
            const uncertain = await executeControlCall(f.config, { tool: 'happy_create_task', input: { requestID: 'cleanup-task', machineID: 'machineA', projectID: 'projectA' } }, { provider: cleanup, fetch: f.fetchFixture });
            expect(uncertain).toMatchObject({ ok: false, data: { state: 'unknown', requestID: 'cleanup-task' }, error: { code: 'CONTROL_CREDENTIAL_CLEANUP_FAILED' } });
            expect(JSON.stringify(uncertain)).not.toContain(secret);
            expect((await f.call('happy_request_status', { requestID: 'cleanup-task' })).data.state).toBe('confirmed');
        } finally { await f.rig.close(); }
    });
});
