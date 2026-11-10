import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { signedHeaders, canonicalBody } from './auth';
import { ProofClient } from './client';
import { ScopedWorker } from './worker';
import { callControlTool, startTask, toolContracts } from './mcp';

const fixturePath = new URL('../../../examples/rest-fixture.ts', import.meta.url).pathname;
const rigs: any[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(r => r.close())); });
async function setup(options: Record<string, unknown> = {}) {
    const { fixtureRig } = await import(fixturePath); const rig = await fixtureRig(options); rigs.push(rig); return rig;
}
const base = '/happy-control/v1';
const localOrigin = 'http://localhost:8989';
const create = (r: any, grant: string, requestID = 'create1') => r.client.request('POST', '/tasks', { requestID, machineID: 'machineA', projectID: 'projectA' }, grant);

it('creates and dispatches work through the real HTTP worker while preserving a dirty original checkout', async () => {
    const r = await setup(), grant = await r.connect();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: r.project, stdio: 'ignore' });
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(r.project, 'baseline'), 'original'); git('add', 'baseline'); git('commit', '-qm', 'base');
    writeFileSync(join(r.project, 'baseline'), 'preserve staged edit'); git('add', 'baseline');
    const index = readFileSync(join(r.project, '.git', 'index')); await r.startWorker();
    const input = { requestID: 'dirty-create', machineID: 'machineA', projectID: 'projectA', execution: { mode: 'integration', resources: ['service:fixture'] } };
    const created = await r.client.request('POST', '/tasks', input, grant); expect(created.ok).toBe(true);
    const send = { requestID: 'dirty-send', text: 'continue the original work' };
    const sent = await r.client.request('POST', `/sessions/${created.data.sessionID}/messages`, send, grant); expect(sent.ok).toBe(true);
    await r.client.request('POST', `/sessions/${created.data.sessionID}/messages`, send, grant);
    const end = Date.now() + 3000; while (!r.sendCount && Date.now() < end) await new Promise(done => setTimeout(done, 20));
    expect(r.spawnCount).toBe(1); expect(r.sendCount).toBe(1);
    expect(readFileSync(join(r.project, 'baseline'), 'utf8')).toBe('preserve staged edit');
    expect(readFileSync(join(r.project, '.git', 'index'))).toEqual(index);
});

describe('independent approval/authentication', () => {
    it('rejects browser cookies and Happy bearer for control; denies pre-approval calls', async () => {
        const r = await setup();
        expect((await r.gateway.app.inject({ method: 'GET', url: `${base}/machines`, headers: { cookie: 'auth_credentials=fixture', authorization: 'Bearer fixture-owner-A' } })).statusCode).toBe(401);
        const p = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], expiresAt: Date.now()+60000 });
        expect((await r.client.request('GET', '/machines', undefined, p.data.id)).error.code).toBe('GRANT_NOT_APPROVED');
    });
    it('binds approval to user, immutable scope digest, and a one-time challenge', async () => {
        const r = await setup();
        const p = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], expiresAt: Date.now()+60000 });
        const id = p.data.id, view = await r.ownerRequest(`/connections/${id}/consent`);
        expect((await r.ownerRequest(`/connections/${id}/consent`, 'GET', undefined, 'B')).status).toBe(404);
        expect((await r.ownerRequest(`/connections/${id}/approve`, 'POST', { digest: '0'.repeat(64), challenge: view.body.data.challenge })).status).toBe(409);
        const payload = { digest: view.body.data.digest, challenge: view.body.data.challenge };
        expect((await r.ownerRequest(`/connections/${id}/approve`, 'POST', { ...payload, methods: ['tasks.create'] })).status).toBe(400);
        expect((await r.ownerRequest(`/connections/${id}/approve`, 'POST', payload)).status).toBe(200);
        expect((await r.ownerRequest(`/connections/${id}/approve`, 'POST', payload)).body.error.code).toBe('APPROVAL_REPLAY');
    });
    it('denies cross-user, project, machine, method, existing-session and prefix access', async () => {
        const r = await setup(), restricted = await r.connect({ methods: ['machines.list'] });
        expect((await create(r, restricted)).error.code).toBe('SCOPE_DENIED');
        const other = new ProofClient(`${r.address}${base}`, r.otherIdentity, 'client', { allowLoopback: true });
        expect((await other.request('GET', '/machines', undefined, restricted)).error.code).toBe('SCOPE_DENIED');
        expect((await other.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], expiresAt: Date.now()+60000 })).error.code).toBe('SCOPE_DENIED');
        const grant = await r.connect();
        for (const change of [{ machineID: 'other' }, { projectID: 'other' }]) expect((await r.client.request('POST', '/tasks', { requestID: 'bad', machineID: 'machineA', projectID: 'projectA', ...change }, grant)).error.code).toBe('SCOPE_DENIED');
        for (const id of ['existing','foreign','ex']) expect((await r.client.request('GET', `/sessions/${id}/status`, undefined, grant)).error.code).toBe('SCOPE_DENIED');
    });
    it('lists the approved project scope without a worker call or an additional method', async () => {
        const r = await setup({ multipleProjects: true }), grant = await r.connect({ methods: ['tasks.create'] });
        const connection = await r.client.request('GET', `/connections/${grant}`, undefined, grant);
        expect(connection.data.projects).toEqual([{ id: 'projectA', directory: r.project }]);
        const projects = await r.client.request('GET', '/projects', undefined, grant);
        expect(projects).toMatchObject({ version: 1, ok: true, data: { projects: [{ projectID: 'projectA', directory: r.project }] } });
        expect(JSON.stringify(projects)).not.toContain(r.projectB);
        expect((await r.client.request('GET', '/projects?limit=1', undefined, grant)).error.code).toBe('INVALID_REQUEST');
        expect(r.spawnCount).toBe(0);
    });
    it('permits only explicit existing sessions in the bound project', async () => {
        const r = await setup(), grant = await r.connect({ sessionIDs: ['existing'] }); await r.startWorker();
        expect((await r.client.request('GET', '/sessions/existing/status', undefined, grant)).ok).toBe(true);
        const denied = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['sessions.send'], sessionIDs: ['foreign'], expiresAt: Date.now()+60000 });
        expect(denied.error.code).toBe('SCOPE_DENIED');
    });
    it('enforces worker-local user, machine, project and method policy independently', async () => {
        const r = await setup(), grant = await r.connect(), c = r.gateway.grants.get(grant);
        const job = { id: 'job1', workerID: 'worker', grantID: grant, deadline: Date.now()+60000, command: { version: 1, method: 'tasks.create', requestID: 'rogue', machineID: 'machineA', projectID: 'projectA' } };
        for (const registration of [{ ...r.registration, userID: 'other' }, { ...r.registration, machineID: 'other' }, { ...r.registration, projects: [] }, { ...r.registration, methods: ['machines.list'] }]) {
            await expect(new ScopedWorker(registration, r.transport, join(r.dir, 'rogue'), async () => c, Date.now, undefined, undefined, join(r.dir, 'queue')).execute(job)).rejects.toThrow();
        }
        expect(r.spawnCount).toBe(0);
    });
    it('expires pending/approved grants and persists revocation through reconnect/restart', async () => {
        let time = Date.now(); const r = await setup({ clock: () => time });
        const grant = await r.connect({ expiresAt: time+1000 }); time += 1001;
        expect((await r.client.request('GET', '/machines', undefined, grant)).error.code).toBe('GRANT_EXPIRED');
        const live = await r.connect(); await r.ownerRequest(`/connections/${live}`, 'DELETE');
        await r.restartGateway(); await r.startWorker();
        expect((await r.client.request('GET', '/machines', undefined, live)).error.code).toBe('GRANT_REVOKED');
        const p = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], expiresAt: time+360000 });
        const view = await r.ownerRequest(`/connections/${p.data.id}/consent`); time += 300001;
        expect((await r.ownerRequest(`/connections/${p.data.id}/approve`, 'POST', { digest: view.body.data.digest, challenge: view.body.data.challenge })).body.error.code).toBe('CONNECTION_EXPIRED');
    });
    it('rejects replay across restart and signed body/path tampering', async () => {
        const r = await setup(), grant = await r.connect(), route = `${base}/machines`;
        const headers = signedHeaders(r.clientIdentity, 'client', 'GET', route, undefined, grant);
        expect((await r.gateway.app.inject({ method: 'GET', url: route, headers })).statusCode).toBe(503);
        expect((await r.gateway.app.inject({ method: 'GET', url: route, headers })).statusCode).toBe(409);
        await r.restartGateway(); expect((await r.gateway.app.inject({ method: 'GET', url: route, headers })).statusCode).toBe(409);
        const path = `${base}/tasks`, body = { requestID: 'x', machineID: 'machineA', projectID: 'projectA' };
        const signed = signedHeaders(r.clientIdentity, 'client', 'POST', path, body, grant);
        expect((await r.gateway.app.inject({ method: 'POST', url: path, headers: signed, payload: { ...body, requestID: 'tampered' } })).statusCode).toBe(401);
        expect((await r.gateway.app.inject({ method: 'POST', url: `${base}/connections`, headers: signed, payload: body })).statusCode).toBe(401);
        expect(canonicalBody({ z: undefined, a: { n: undefined, b: 1 } })).toBe('{"a":{"b":1}}');
    });
    it('rejects foreign origins, incompatible workers, and oversized requests', async () => {
        const r = await setup();
        expect((await r.gateway.app.inject({ method: 'GET', url: `${base}/connections`, headers: { origin: 'https://evil.invalid', authorization: 'Bearer fixture-owner-A' } })).statusCode).toBe(403);
        expect((await r.workerClient.request('POST', '/worker/poll', { protocol: 0 })).error.code).toBe('UNSUPPORTED_PROTOCOL');
        expect((await r.gateway.app.inject({ method: 'POST', url: `${base}/tasks`, payload: 'x'.repeat(300000), headers: { 'content-type': 'application/json' } })).statusCode).toBeGreaterThanOrEqual(400);
    });
    it('allows an exact additional browser origin for preflight and real owner approval without bypassing authentication', async () => {
        const r = await setup({ additionalBrowserOrigins: [localOrigin] });
        let ownerCalls = 0; const verifyOwner = r.gatewayOptions.verifyOwner;
        r.gatewayOptions.verifyOwner = async (authorization: string | undefined) => { ownerCalls++; return verifyOwner(authorization); };
        const pending = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], expiresAt: Date.now()+60000 });
        const preflight = await r.gateway.app.inject({ method: 'OPTIONS', url: `${base}/connections/${pending.data.id}/approve`, headers: {
            origin: localOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
        } });
        expect(preflight.statusCode).toBe(204); expect(preflight.body).toBe('');
        expect(preflight.headers).toMatchObject({ 'access-control-allow-origin': localOrigin, vary: 'Origin',
            'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'Authorization, Content-Type' });
        expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
        expect(ownerCalls).toBe(0); expect(r.gateway.grants.get(pending.data.id).state).toBe('pending');
        const compatibility = await r.gateway.app.inject({ method: 'GET', url: `${base}/compatibility`, headers: { origin: localOrigin } });
        expect(compatibility.statusCode).toBe(200); expect(compatibility.headers['access-control-allow-origin']).toBe(localOrigin);
        expect(compatibility.headers.vary).toBe('Origin'); expect(compatibility.headers['access-control-allow-credentials']).toBeUndefined();
        const consent = await r.ownerRequest(`/connections/${pending.data.id}/consent`, 'GET', undefined, 'A', localOrigin);
        expect(consent.status).toBe(200); expect(consent.headers['access-control-allow-origin']).toBe(localOrigin);
        const approved = await r.ownerRequest(`/connections/${pending.data.id}/approve`, 'POST', { digest: consent.body.data.digest, challenge: consent.body.data.challenge }, 'A', localOrigin);
        expect(approved.status).toBe(200); expect(approved.body.data.state).toBe('approved'); expect(ownerCalls).toBe(2);
        const invalid = await r.gateway.app.inject({ method: 'GET', url: `${base}/connections`, headers: { origin: localOrigin, authorization: 'Bearer invalid' } });
        expect(invalid.statusCode).toBe(503); expect(invalid.headers['access-control-allow-origin']).toBe(localOrigin); expect(ownerCalls).toBe(3);
        expect((await r.ownerRequest('/connections')).status).toBe(200);
    });
    it('keeps additional browser origins disabled by default and rejects malformed or multiple origins', async () => {
        const r = await setup();
        for (const origin of [localOrigin, 'https://evil.invalid', 'null', 'https://good.invalid https://evil.invalid']) {
            for (const method of ['OPTIONS', 'GET']) {
                const response = await r.gateway.app.inject({ method, url: `${base}/compatibility`, headers: { origin, 'access-control-request-method': 'GET' } });
                expect(response.statusCode).toBe(403); expect(response.headers['access-control-allow-origin']).toBeUndefined();
            }
        }
        expect((await r.gateway.app.inject({ method: 'OPTIONS', url: `${base}/compatibility`, headers: { origin: r.gatewayOptions.origin } })).statusCode).toBe(404);
    });
    it('rejects invalid additional browser origins before acquiring the state lock', async () => {
        const r = await setup(), { createGateway } = await import('./gateway');
        for (const values of [['*'], [localOrigin, localOrigin], ['http://example.com'], [`${localOrigin}/`], ['http://user@localhost:8989'], [`${localOrigin}/path`], ['https://example.com:443']]) {
            expect(() => createGateway({ ...r.gatewayOptions, additionalBrowserOrigins: values })).toThrow('INVALID_ORIGIN');
        }
    });
});

describe('loopback REST → worker → existing core/daemon', () => {
    it('reconciles timeout by stable requestID and deduplicates after restart', async () => {
        const r = await setup({ timeoutMs: 500 }), grant = await r.connect(); await r.startWorker(); r.delaySpawn(1000);
        expect((await create(r, grant)).error.code).toBe('UNAVAILABLE_OR_UNKNOWN');
        await new Promise(resolve => setTimeout(resolve, 1300)); r.delaySpawn(0); r.gatewayOptions.timeoutMs = 5000;
        const receipt = await r.client.request('GET', '/requests/create1', undefined, grant);
        expect(receipt.data.state).toBe('confirmed'); expect(r.spawnCount).toBe(1);
        await r.restartGateway(); await r.startWorker();
        expect((await create(r, grant)).data.sessionID).toBe(receipt.data.sessionID); expect(r.spawnCount).toBe(1);
    });
    it('recovers durable message ack and rejects changed payload', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); const sid = (await create(r, grant)).data.sessionID;
        r.loseSendAck(); const body = { requestID: 'send1', text: 'fixture private instruction' };
        expect((await r.client.request('POST', `/sessions/${sid}/messages`, body, grant)).data.state).toBe('queued');
        await r.waitForSubmitted(grant, 'send1');
        expect((await r.client.request('GET', '/requests/send1', undefined, grant)).data.state).toBe('submitted');
        expect((await r.client.request('POST', `/sessions/${sid}/messages`, body, grant)).data.state).toBe('submitted'); expect(r.sendCount).toBe(1);
        expect((await r.client.request('POST', `/sessions/${sid}/messages`, { ...body, text: 'changed' }, grant)).error.code).toBe('REQUEST_ID_CONFLICT');
    });
    it('returns cursor/turn evidence without false attribution or cancel-stop equivalence', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); const sid = (await create(r, grant)).data.sessionID;
        r.complete(sid, 'turn1', 'failed', 'Bearer fixture-sensitive secret=hidden');
        const page = await r.client.request('GET', `/sessions/${sid}/events?after_seq=0&limit=1`, undefined, grant);
        expect(page.data).toMatchObject({ hasMore: true, nextCursor: 1 });
        const result = await r.client.request('GET', `/sessions/${sid}/result?turnID=turn1`, undefined, grant);
        expect(result.data).toMatchObject({ ready: true, outcome: 'failed', attribution: 'session_turn_only' });
        expect(JSON.stringify(result)).not.toMatch(/fixture-sensitive|hidden/);
        expect((await r.client.request('GET', `/sessions/${sid}/result?turnID=unrelated`, undefined, grant)).data.ready).toBe(false);
        expect((await r.client.request('POST', `/sessions/${sid}/cancel`, { requestID: 'cancel1' }, grant)).data).toMatchObject({ state: 'cancel_requested', process: 'unknown' });
        r.setProcess('stopped'); expect((await r.client.request('GET', `/sessions/${sid}/status`, undefined, grant)).data.process).toBe('stopped');
    });
    it('does not queue known-offline work or restore revoked access on reconnect', async () => {
        const r = await setup(), grant = await r.connect();
        expect((await create(r, grant)).error.code).toBe('WORKER_UNAVAILABLE'); expect(r.spawnCount).toBe(0);
        await r.startWorker(); const created = await create(r, grant); expect(created.ok).toBe(true);
        await r.ownerRequest(`/connections/${grant}`, 'DELETE');
        expect((await r.client.request('GET', '/requests/create1', undefined, grant)).error.code).toBe('GRANT_REVOKED');
        await r.stopWorker(); await r.startWorker();
        expect((await r.client.request('POST', `/sessions/${created.data.sessionID}/cancel`, { requestID: 'cancel_revoked' }, grant)).error.code).toBe('GRANT_REVOKED');
    });
    it('maps fixed MCP tools and stable composite child IDs without shell/URL tools', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker();
        const input = { requestID: 'parent', machineID: 'machineA', projectID: 'projectA', text: 'fixture task' };
        const first = await startTask(r.client, grant, input), again = await startTask(r.client, grant, input);
        expect(first.result.data.state).toBe('queued'); await r.waitForSubmitted(grant, first.requests.send); expect(again.requests).toEqual(first.requests); expect(r.spawnCount).toBe(1); expect(r.sendCount).toBe(1);
        expect((await callControlTool(r.client, grant, 'happy_machines', {})).ok).toBe(true);
        await expect(callControlTool(r.client, grant, 'happy_send', { sessionID: first.sessionID, requestID: 'bad', text: 'x', shell: 'arbitrary' })).rejects.toThrow();
        expect(Object.keys(toolContracts).some(n => /shell|fetch|exec/.test(n))).toBe(false);
    });
    it('keeps relay ciphertext opaque and keys/credentials/instructions out of disk and audit', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); const sid = (await create(r, grant)).data.sessionID;
        await r.client.request('POST', `/sessions/${sid}/messages`, { requestID: 'secret_test', text: 'fixture-private-instruction' }, grant);
        expect(JSON.stringify([...r.ciphertext.values()])).not.toContain('fixture-private-instruction');
        const files = readdirSync(r.dir, { recursive: true }).filter(f => String(f).endsWith('.json'));
        const disk = files.map(f => readFileSync(join(r.dir, String(f)), 'utf8')).join('\n');
        expect(disk).not.toMatch(/fixture-private-instruction|fixture-owner-A|BEGIN PRIVATE KEY|authorization/i);
        expect(JSON.stringify(r.audit)).not.toMatch(/secret_test|fixture-private-instruction|fixture-owner-A/);
        expect(r.audit.some((event: any) => event.principalID === 'client:assistant')).toBe(true);
    });
});

describe('revocation races, pin rotation, capabilities and exclusive state ownership', () => {
    it('revokes an in-flight call without returning its content or implicitly stopping the process', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); r.delaySpawn(200);
        const pending = create(r, grant);
        for (let i=0; i<100 && r.spawnCount===0; i++) await new Promise(resolve => setTimeout(resolve,5));
        expect(r.spawnCount).toBe(1);
        await r.ownerRequest(`/connections/${grant}`, 'DELETE');
        expect((await pending).error.code).toBe('GRANT_REVOKED');
        await new Promise(resolve => setTimeout(resolve,250));
        expect((await r.client.request('GET','/requests/create1',undefined,grant)).error.code).toBe('GRANT_REVOKED');
    });
    it('invalidates existing grants on client or worker pin changes', async () => {
        const r = await setup(), grant = await r.connect();
        const original = r.gatewayOptions.clients[0].publicKey;
        r.gatewayOptions.clients[0].publicKey = r.otherIdentity.publicKey;
        const rotated = new ProofClient(`${r.address}${base}`, { id: 'assistant', privateKey: r.otherIdentity.privateKey }, 'client', { allowLoopback: true });
        expect((await rotated.request('GET','/machines',undefined,grant)).error.code).toBe('CLIENT_IDENTITY_CHANGED');
        r.gatewayOptions.clients[0].publicKey = original;
        expect((await r.client.request('GET','/machines',undefined,grant)).error.code).toBe('GRANT_REVOKED');
        const secondGrant = await r.connect();
        r.registration.publicKey = r.otherIdentity.publicKey;
        expect((await r.client.request('GET','/machines',undefined,secondGrant)).error.code).toBe('WORKER_IDENTITY_CHANGED');
    });
    it('fails closed against an incompatible daemon instead of advertising a false capability', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker();
        const rpc = r.transport.rpc;
        r.transport.rpc = async (machine: any, command: any) => command.operation === 'capabilities' ? { version: 0 } : rpc(machine,command);
        expect((await r.client.request('GET','/capabilities',undefined,grant)).error.code).toBe('UNSUPPORTED_VERSION');
        expect((await create(r,grant)).error.code).toBe('UNSUPPORTED_VERSION'); expect(r.spawnCount).toBe(0);
    });
    it('refuses two gateway owners for the same durable authorization directory', async () => {
        const r = await setup();
        const { createGateway } = await import('./gateway');
        expect(() => createGateway(r.gatewayOptions)).toThrow('GATEWAY_DIRECTORY_LOCKED');
    });
});


describe('permanent expiry and project rebind tombstones', () => {
    it('does not revive an observed expired grant after clock rollback or restart', async () => {
        const initial = Date.now(); let time = initial;
        const r = await setup({ clock: () => time }), grant = await r.connect({ expiresAt: time+1000 });
        time += 1001;
        expect((await r.client.request('GET','/machines',undefined,grant)).error.code).toBe('GRANT_EXPIRED');
        time = initial; await r.restartGateway();
        expect((await r.client.request('GET','/machines',undefined,grant)).error.code).toBe('GRANT_EXPIRED');
    });
    it('revokes old grants when a project directory is rebound, including after config rollback', async () => {
        const r = await setup(), grant = await r.connect();
        r.registration.projects[0].directory = '/different/project';
        expect((await r.client.request('GET','/machines',undefined,grant)).error.code).toBe('PROJECT_BINDING_CHANGED');
        r.registration.projects[0].directory = r.project;
        expect((await r.client.request('GET','/machines',undefined,grant)).error.code).toBe('GRANT_REVOKED');
    });
});


describe('permanent connection record deletion', () => {
    it('deletes every state only for its owner, retains legacy revocation, and stays deleted across restart', async () => {
        let time = Date.now(); const r = await setup({ clock: () => time });
        const pending = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA', methods: ['machines.list'], sessionIDs: [], expiresAt: time+60000 });
        const approved = await r.connect(), expired = await r.connect({ expiresAt: time+1000 });
        time += 1001;
        expect((await r.client.request('GET', '/machines', undefined, expired)).error.code).toBe('GRANT_EXPIRED');
        const revoked = await r.connect();
        expect((await r.ownerRequest(`/connections/${revoked}`, 'DELETE')).body.data.state).toBe('revoked');
        expect(r.gateway.store.get(`connection:${revoked}`)).not.toBeNull();
        expect((await r.ownerRequest(`/connections/${revoked}/consent`)).status).toBe(200);
        const survivor = await r.connect();
        expect((await r.ownerRequest(`/connections/${pending.data.id}/record`, 'DELETE', undefined, 'B')).status).toBe(404);
        expect((await r.ownerRequest('/connections/missing/record', 'DELETE')).status).toBe(404);
        const deletedIDs = [pending.data.id, approved, expired, revoked];
        for (const id of deletedIDs) {
            const deleted = await r.ownerRequest(`/connections/${id}/record`, 'DELETE');
            expect(deleted.status).toBe(200); expect(deleted.body.data).toEqual({ deleted: true });
            expect((await r.ownerRequest(`/connections/${id}/consent`)).status).toBe(404);
            expect((await r.client.request('GET', `/connections/${id}`)).error.code).toBe('NOT_FOUND');
            expect(r.gateway.store.get(`connection:${id}`)).toBeNull();
        }
        expect((await r.ownerRequest(`/connections/${revoked}/record`, 'DELETE')).status).toBe(404);
        expect((await r.ownerRequest('/connections')).body.data.map((c: any) => c.id)).toEqual([survivor]);
        await r.restartGateway();
        expect((await r.ownerRequest('/connections')).body.data.map((c: any) => c.id)).toEqual([survivor]);
        for (const id of deletedIDs) expect((await r.ownerRequest(`/connections/${id}/consent`)).status).toBe(404);
        expect((await r.ownerRequest(`/connections/${survivor}/consent`)).status).toBe(200);
    });
    it('settles waiting jobs before deleting the record without deleting receipts or claiming tasks stopped', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); const release = r.pauseSpawn();
        const pending = create(r, grant);
        try {
            for (let i=0; i<100 && r.spawnCount===0; i++) await new Promise(resolve => setTimeout(resolve,5));
            expect(r.spawnCount).toBe(1);
            const intentKey = `intent:${grant}:create1`, intent = r.gateway.store.get(intentKey);
            expect(intent).not.toBeNull();
            const deleted = await r.ownerRequest(`/connections/${grant}/record`, 'DELETE');
            expect(deleted.status).toBe(200); expect(deleted.body.data).toEqual({ deleted: true });
            expect(JSON.stringify(deleted.body)).not.toMatch(/process|stopped/);
            expect((await pending).error.code).toBe('GRANT_REVOKED');
            expect(r.gateway.store.get(intentKey)).toEqual(intent);
            expect(r.gateway.store.get(`connection:${grant}`)).toBeNull();
        } finally { release(); }
    });
});


describe('bounded concurrent worker observation', () => {
    it('can query a pending receipt while spawn is blocked without duplicate dispatch', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker(); const release = r.pauseSpawn();
        const pending = create(r, grant);
        try {
            for (let i=0; i<100 && r.spawnCount===0; i++) await new Promise(resolve => setTimeout(resolve,5));
            expect(r.spawnCount).toBe(1);
            const receipt = await r.client.request('GET','/requests/create1',undefined,grant);
            expect(receipt.data.state).toBe('pending'); expect(r.spawnCount).toBe(1);
        } finally { release(); }
        expect((await pending).data.state).toBe('confirmed');
    });
});
