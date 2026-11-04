import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { methods } from '../control';
import { ScopedWorker, HTTPWorkerRunner } from './worker';
import { MAX_SCOPE_PROJECTS } from './schema';
import type { ProofClient } from './client';

const fixturePath = new URL('../../../examples/rest-fixture.ts', import.meta.url).pathname;
const rigs: any[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(r => r.close())); });
async function setup(extra: any = {}) {
    const { fixtureRig } = await import(fixturePath);
    const rig = await fixtureRig({ multipleProjects: true, serviceTokens: { clients: [{ id: 'service', userID: 'userA', name: 'Fixture backend', generation: 'v1' }] }, ...extra });
    rigs.push(rig); return rig;
}
function body(r: any, extra: any = {}) {
    return { clientID: 'service', workerID: 'worker', machineID: 'machineA', scopeVersion: 2, projectIDs: ['projectB', 'projectA'], methods: [...methods], sessionIDs: [], expiresAt: r.gatewayOptions.now() + 60000, ...extra };
}
async function pending(r: any, extra: any = {}) {
    const x = await r.ownerRequest('/service-connections', 'POST', body(r, extra)); expect(x.status).toBe(200); return x.body.data;
}
async function approve(r: any, c: any) {
    const view = (await r.ownerRequest(`/connections/${c.id}/consent`)).body.data;
    const x = await r.ownerRequest(`/connections/${c.id}/approve`, 'POST', { digest: view.digest, challenge: view.challenge, credentialMode: 'service-token-v1', ...(c.scopeVersion ? { scopeVersion: c.scopeVersion } : {}) });
    expect(x.status).toBe(200);
    const issued = await r.ownerRequest(`/connections/${c.id}/service-token`, 'POST'); expect(issued.status).toBe(200); return issued.body.data.token as string;
}
async function request(r: any, token: string, route: string, method = 'GET', value?: unknown) {
    const response = await r.gateway.app.inject({ method: method as any, url: '/happy-control/v1' + route, headers: { authorization: 'Bearer ' + token }, ...(value === undefined ? {} : { payload: value }) });
    return { status: response.statusCode, body: response.json() };
}
const create = (r: any, token: string, projectID: string, requestID: string) => request(r, token, '/tasks', 'POST', { requestID, machineID: 'machineA', projectID });
function job(c: any, projectID = 'projectB') {
    return { id: 'fixture-job', workerID: 'worker', grantID: c.id, deadline: Date.now() + 60000, command: { version: 1, method: 'tasks.create', requestID: 'fixture-direct', machineID: 'machineA', projectID } };
}

describe('explicit multi-project service grants, fixture-only identities/transport', () => {
    it('freezes every selected directory, requires v2 approval acknowledgement and rejects replay', async () => {
        const r = await setup(), c = await pending(r);
        expect(c.projectIDs).toEqual(['projectA', 'projectB']); expect(c.projects).toEqual([{ id: 'projectA', directory: r.project }, { id: 'projectB', directory: r.projectB }]);
        expect(c.projectID).toBeUndefined(); expect(c.projectDirectory).toBeUndefined();
        const view = (await r.ownerRequest(`/connections/${c.id}/consent`)).body.data;
        const proof = { digest: view.digest, challenge: view.challenge, credentialMode: 'service-token-v1' };
        expect((await r.ownerRequest(`/connections/${c.id}/approve`, 'POST', proof)).body.error.code).toBe('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
        expect((await r.ownerRequest(`/connections/${c.id}/approve`, 'POST', { ...proof, scopeVersion: 2, projectIDs: ['projectA'] })).status).toBe(400);
        expect((await r.ownerRequest(`/connections/${c.id}/approve`, 'POST', { ...proof, scopeVersion: 2, digest: '0'.repeat(64) })).status).toBe(409);
        expect((await r.ownerRequest(`/connections/${c.id}/consent`, 'GET', undefined, 'B')).status).toBe(404);
        await approve(r, c);
        expect((await r.ownerRequest(`/connections/${c.id}/approve`, 'POST', { ...proof, scopeVersion: 2 })).body.error.code).toBe('APPROVAL_REPLAY');
    });
    it('rejects empty/duplicate/oversized/mixed scopes and unauthorized project/user/machine/worker/session', async () => {
        const r = await setup();
        for (const patch of [{ projectIDs: [] }, { projectIDs: ['projectA'] }, { projectIDs: ['projectA', 'projectA'] },
            { projectID: 'projectA' }, { projectIDs: Array.from({ length: MAX_SCOPE_PROJECTS + 1 }, (_, i) => 'p' + i) }]) {
            expect((await r.ownerRequest('/service-connections', 'POST', body(r, patch))).status).toBe(400);
        }
        for (const patch of [{ projectIDs: ['projectA', 'not_registered'] }, { machineID: 'other' }, { workerID: 'other' }, { sessionIDs: ['existingC'] }]) {
            expect((await r.ownerRequest('/service-connections', 'POST', body(r, patch))).status).toBe(403);
        }
        expect((await r.ownerRequest('/service-connections', 'POST', body(r), 'B')).status).toBe(403);
        const { clientID: _, ...signedScope } = body(r);
        expect((await r.client.request('POST', '/connections', signedScope)).error.code).toBe('INVALID_REQUEST');
    });
    it('uses one token across two projects, keeps receipts global to the grant and preserves cursor/turn/cancel semantics', async () => {
        const r = await setup(), c = await pending(r), token = await approve(r, c); await r.startWorker();
        const calls = await Promise.all([create(r, token, 'projectA', 'create_a'), create(r, token, 'projectB', 'create_b'), create(r, token, 'projectB', 'create_b')]);
        const a = calls[0].body.data.sessionID, b = (await request(r, token, '/requests/create_b')).body.data.sessionID;
        expect(a).toBeTruthy(); expect(b).toBeTruthy(); expect(a).not.toBe(b); expect(r.spawnCount).toBe(2);
        const sessions = (await r.transport.sessions()).sessions;
        expect(sessions.find((s: any) => s.id === a).metadata.path).toBe(r.project);
        expect(sessions.find((s: any) => s.id === b).metadata.path).toBe(r.projectB);
        expect((await create(r, token, 'projectA', 'create_b')).body.error.code).toBe('REQUEST_ID_CONFLICT');
        for (const sid of [a, b]) {
            const message = await request(r, token, `/sessions/${sid}/messages`, 'POST', { requestID: 'send_' + sid, text: 'isolated-multi-project-instruction' });
            expect(message.body.data.state).toBe('submitted');
            r.complete(sid, 'turn_' + sid); let cursor = 0, ready = false;
            for (let i = 0; i < 4; i++) {
                const result = await request(r, token, `/sessions/${sid}/result?turnID=turn_${sid}&after_seq=${cursor}&limit=2`);
                expect(result.body.data.nextCursor).toBeGreaterThanOrEqual(cursor); cursor = result.body.data.nextCursor; ready ||= result.body.data.ready;
                expect(result.body.data.messages.every((m: any) => m.turnID === 'turn_' + sid)).toBe(true);
                if (!result.body.data.hasMore) break;
            }
            expect(ready).toBe(true);
        }
        const visible = (await request(r, token, '/sessions')).body.data.sessions.map((s: any) => s.sessionID).sort(); expect(visible).toEqual([a, b].sort());
        const cancel = await request(r, token, `/sessions/${b}/cancel`, 'POST', { requestID: 'cancel_b' });
        expect(cancel.body.data).toMatchObject({ state: 'cancel_requested', process: 'unknown' }); r.setProcess('stopped');
        expect((await request(r, token, '/requests/cancel_b')).body.data.process).toBe('stopped');
        const disk = readdirSync(join(r.dir, 'gateway/state')).map(f => readFileSync(join(r.dir, 'gateway/state', f), 'utf8')).join('');
        expect(disk).not.toContain(token); expect(JSON.stringify(r.audit)).not.toContain(token);
        expect(JSON.stringify([...r.ciphertext.values()])).not.toContain('isolated-multi-project-instruction');
        await r.restartGateway(); await r.startWorker();
        expect((await request(r, token, '/requests/create_b')).body.data.sessionID).toBe(b); expect(r.spawnCount).toBe(2);
    }, 15000);
    it('denies unselected registered projects, existing sessions, other grants and method escalation', async () => {
        const r = await setup(), c = await pending(r), token = await approve(r, c); await r.startWorker();
        expect((await create(r, token, 'projectC', 'denied')).body.error.code).toBe('SCOPE_DENIED');
        for (const id of ['existing', 'existingB', 'existingC', 'foreign']) expect((await request(r, token, `/sessions/${id}/status`)).body.error.code).toBe('SCOPE_DENIED');
        const other = await pending(r), otherToken = await approve(r, other), own = await create(r, token, 'projectB', 'own');
        expect((await request(r, otherToken, `/sessions/${own.body.data.sessionID}/status`)).body.error.code).toBe('SCOPE_DENIED');
        const read = await pending(r, { methods: ['machines.list'] }), readToken = await approve(r, read);
        expect((await create(r, readToken, 'projectB', 'readonly')).body.error.code).toBe('SCOPE_DENIED');
    });
    it('allows only explicitly listed existing sessions within the selected project union', async () => {
        const r = await setup(), c = await pending(r, { sessionIDs: ['existingB'] }), token = await approve(r, c); await r.startWorker();
        expect((await request(r, token, '/sessions/existingB/status')).status).toBe(200);
        expect((await request(r, token, '/sessions/existing/status')).body.error.code).toBe('SCOPE_DENIED');
    });
    it('checks every binding and canonical path locally even when a gateway grants a rogue command', async () => {
        const r = await setup(), pendingScope = await pending(r); await approve(r, pendingScope);
        const c = r.gateway.grants.get(pendingScope.id);
        const registrations = [{ ...r.registration, userID: 'other' }, { ...r.registration, machineID: 'other' },
            { ...r.registration, projects: r.registration.projects.filter((p: any) => p.id !== 'projectB') },
            { ...r.registration, methods: ['machines.list'] },
            { ...r.registration, projects: r.registration.projects.map((p: any) => p.id === 'projectB' ? { ...p, directory: r.projectC } : p) }];
        for (const registration of registrations) await expect(new ScopedWorker(registration, r.transport, join(r.dir, 'rogue'), async () => c).execute(job(c))).rejects.toThrow();
        await expect(new ScopedWorker(r.registration, r.transport, join(r.dir, 'rogue'), async () => c).execute(job(c, 'projectC'))).rejects.toThrow('SCOPE_DENIED');
        await expect(new ScopedWorker(r.registration, r.transport, join(r.dir, 'rogue'), async () => c, Date.now, p => p === r.projectB ? r.projectC : p).execute(job(c))).rejects.toThrow('PROJECT_PATH_CHANGED');
        expect(r.spawnCount).toBe(0);
    });
    it('invalidates the whole grant if any bound directory is rebound, and restoring config cannot revive it', async () => {
        const r = await setup(), c = await pending(r), token = await approve(r, c); await r.startWorker();
        r.registration.projects[1].directory = r.projectC;
        expect((await create(r, token, 'projectA', 'must_not_run')).body.error.code).toBe('PROJECT_BINDING_CHANGED');
        r.registration.projects[1].directory = r.projectB; await r.restartGateway();
        expect((await request(r, token, '/machines')).body.error.code).toBe('GRANT_REVOKED'); expect(r.spawnCount).toBe(0);
    });
    it('requires upgraded worker capability, including a new->old worker transition while a job is queued', async () => {
        const r = await setup(), c = await pending(r), token = await approve(r, c);
        await r.workerClient.request('POST', '/worker/poll', { protocol: 1 });
        expect((await create(r, token, 'projectA', 'old_worker')).status).toBe(426); expect(r.spawnCount).toBe(0);
        await r.workerClient.request('POST', '/worker/poll', { protocol: 1, projectScopes: 1 });
        const waiting = create(r, token, 'projectB', 'downgrade');
        await new Promise(resolve => setTimeout(resolve, 20));
        await r.workerClient.request('POST', '/worker/poll', { protocol: 1 });
        expect((await waiting).body.error.code).toBe('WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED'); expect(r.spawnCount).toBe(0);
        await r.startWorker(); expect((await create(r, token, 'projectB', 'new_worker')).body.data.state).toBe('confirmed');
    });
    it('retains uncertainty after timeout and reconciles the same request without duplicate dispatch', async () => {
        const r = await setup({ timeoutMs: 1000 }), c = await pending(r), token = await approve(r, c); await r.startWorker();
        const release = r.pauseSpawn();
        try {
            const waiting = create(r, token, 'projectB', 'slow_multi');
            for (let i = 0; i < 300 && r.spawnCount === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
            expect(r.spawnCount).toBe(1); expect((await waiting).body.error.code).toBe('UNAVAILABLE_OR_UNKNOWN');
            release(); r.gatewayOptions.timeoutMs = 2000;
            let state: string | undefined;
            for (let i = 0; i < 20; i++) { const receipt = await request(r, token, '/requests/slow_multi'); state = receipt.body.data?.state; if (state === 'confirmed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
            expect(state).toBe('confirmed'); expect(r.spawnCount).toBe(1);
        } finally { release(); }
    });
    it('retains expiry/revocation across restart for all selected projects', async () => {
        let time = Date.now(); const r = await setup({ clock: () => time }), c = await pending(r), token = await approve(r, c); await r.startWorker();
        await r.ownerRequest(`/connections/${c.id}`, 'DELETE'); await r.restartGateway(); await r.startWorker();
        expect((await create(r, token, 'projectB', 'revoked')).body.error.code).toBe('GRANT_REVOKED');
        const next = await pending(r), nextToken = await approve(r, next); time = next.expiresAt;
        expect((await create(r, nextToken, 'projectA', 'expired')).body.error.code).toBe('GRANT_EXPIRED'); expect(r.spawnCount).toBe(0);
    });
    it('keeps legacy single-project grants single-project even if the worker registers more projects', async () => {
        const r = await setup(), c = await pending(r, { scopeVersion: undefined, projectIDs: undefined, projectID: 'projectA' }), token = await approve(r, c); await r.startWorker();
        expect(c.scopeVersion).toBeUndefined(); expect(c.projectDirectory).toBe(r.project);
        expect((await create(r, token, 'projectA', 'legacy')).body.data.state).toBe('confirmed');
        expect((await create(r, token, 'projectB', 'no_expand')).body.error.code).toBe('SCOPE_DENIED');
    });
    it('discovers a gateway upgrade without restarting the worker', async () => {
        const r = await setup(); let time = Date.now(), supports = false; const polls: any[] = [];
        const client = { request: async (_method: string, route: string, value?: any) => {
            if (route === '/compatibility') return { ok: true, data: supports ? { projectScopes: 1 } : {} };
            polls.push(value); return { ok: true, data: null };
        } } as unknown as ProofClient;
        const runner = new HTTPWorkerRunner(client, r.registration, r.transport, join(r.dir, 'upgrade-worker'), () => time);
        await runner.pollOnce(); expect(polls[0].projectScopes).toBeUndefined();
        supports = true; time += 30000; await runner.pollOnce(); expect(polls[1].projectScopes).toBe(1);
    });
    it('negotiates an old gateway without sending new fields and renegotiates after downgrade', async () => {
        const r = await setup(); let supports = false, reject = false; const polls: any[] = [];
        const client = { request: async (_method: string, route: string, value?: any) => {
            if (route === '/compatibility') return { ok: true, data: supports ? { projectScopes: 1 } : {} };
            polls.push(value); if (reject) { reject = false; return { ok: false, error: { code: 'INVALID_REQUEST' } }; }
            return { ok: true, data: null };
        } } as unknown as ProofClient;
        await new HTTPWorkerRunner(client, r.registration, r.transport, join(r.dir, 'legacy-worker')).pollOnce(); expect(polls[0].projectScopes).toBeUndefined();
        supports = true; const runner = new HTTPWorkerRunner(client, r.registration, r.transport, join(r.dir, 'new-worker'));
        await runner.pollOnce(); expect(polls[1].projectScopes).toBe(1);
        supports = false; reject = true; await expect(runner.pollOnce()).rejects.toThrow('INVALID_REQUEST');
        await runner.pollOnce(); expect(polls.at(-1).projectScopes).toBeUndefined();
    });
});
