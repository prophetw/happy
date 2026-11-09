import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, symlinkSync, renameSync, writeFileSync } from 'node:fs';
const fixturePath = new URL('../../../examples/rest-fixture.ts', import.meta.url).pathname;
import { MetadataStore } from './store';
import { directoryPath, directoryProjectID } from './schema';

const rigs: any[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
async function setup(clock?: () => number) {
    const { fixtureRig } = await import(fixturePath);
    const r = await fixtureRig({ clock, directorySelection: true, serviceTokens: { clients: [{ id: 'service', userID: 'userA', name: 'Fixture backend', generation: 'v1' }, { id: 'other-service', userID: 'userB', name: 'Other user', generation: 'v1' }] } });
    rigs.push(r); await r.startWorker(); return r;
}
async function resolve(r: any, paths = [r.projectB, r.projectC], patch = {}) {
    return r.ownerRequest('/service-connections/resolve-directories', 'POST', { clientID: 'service', workerID: 'worker', machineID: 'machineA', directories: paths, ...patch });
}
function scope(r: any, selection: any, patch = {}) {
    return { clientID: 'service', workerID: 'worker', machineID: 'machineA', scopeVersion: 3, projectIDs: selection.projects.map((p: any) => p.id), projects: selection.projects, selectionID: selection.selectionID,
        methods: [...r.registration.methods], sessionIDs: [], expiresAt: Date.now() + 60000, ...patch };
}
async function pending(r: any, paths?: string[]) {
    const selected = await resolve(r, paths); expect(selected.status).toBe(200);
    const created = await r.ownerRequest('/service-connections', 'POST', scope(r, selected.body.data)); expect(created.status).toBe(200); return created.body.data;
}
async function approve(r: any, c: any, patch = {}) {
    const view = (await r.ownerRequest(`/connections/${c.id}/consent`)).body.data;
    return r.ownerRequest(`/connections/${c.id}/approve`, 'POST', { digest: view.digest, challenge: view.challenge, credentialMode: 'service-token-v1', scopeVersion: 3, ...patch });
}
async function request(r: any, token: string, route: string, method = 'GET', payload?: any) {
    const x = await r.gateway.app.inject({ method: method as any, url: '/happy-control/v1' + route, headers: { authorization: 'Bearer ' + token }, ...(payload ? { payload } : {}) });
    return { status: x.statusCode, body: x.json() };
}

describe('owner-selected directories: fixture-only worker, Happy identity and encrypted transport', () => {
    it('canonical path parser rejects traversal, controls, backslashes, root and ambiguous paths', () => {
        for (const p of ['/', '/tmp/', '/tmp/../etc', '/tmp//x', '/tmp/./x', '/tmp/\\x', '/tmp/\u0000x', '/tmp/\nx']) expect(directoryPath.safeParse(p).success, p).toBe(false);
        expect(directoryPath.parse('/tmp/中文项目')).toBe('/tmp/中文项目');
    });
    it('negotiates opt-in capability and resolves unregistered projects without mutating registrations or granting access', async () => {
        const r = await setup(), before = JSON.stringify(r.registration), selected = await resolve(r);
        expect(selected.status).toBe(200); expect(selected.body.data.projects).toHaveLength(2);
        expect(selected.body.data.projects.map((p: any) => p.id)).toContain(directoryProjectID(r.projectB));
        expect(JSON.stringify(r.registration)).toBe(before); expect(r.spawnCount).toBe(0); expect(r.gateway.store.list('connection:')).toHaveLength(0);
        const options = (await r.ownerRequest('/service-connections/options')).body.data;
        expect(options.directoryScopes).toBe(1); expect(options.workers[0].directoryScopes).toBe(1); expect(options.workers[0].directorySelection.roots).toEqual([r.dir]);
    });
    it('creates/approves exactly the selected paths and one token creates dedicated tasks in both, with existing reliability semantics', async () => {
        const r = await setup(), c = await pending(r);
        expect((await approve(r, c, { scopeVersion: 2 })).status).toBe(426);
        expect((await approve(r, c)).status).toBe(200); expect((await approve(r, c)).body.error.code).toBe('APPROVAL_REPLAY');
        const token = (await r.ownerRequest(`/connections/${c.id}/service-token`, 'POST')).body.data.token;
        const visible = await request(r, token, '/projects');
        expect(visible.body.data.projects).toEqual(c.projects.map((p: any) => ({ projectID: p.id, directory: p.directory })));
        for (const p of c.projects) {
            const create = { machineID: 'machineA', projectID: p.id, requestID: 'create_' + p.id };
            const [a, b] = await Promise.all([request(r, token, '/tasks', 'POST', create), request(r, token, '/tasks', 'POST', create)]);
            expect(a.status).toBe(200); expect(b.status).toBe(200); const sid = a.body.data.sessionID;
            expect((await r.transport.sessions()).sessions.find((s: any) => s.id === sid)?.metadata.path).toBe(p.directory);
            expect((await request(r, token, '/requests/' + create.requestID)).body.data.sessionID).toBe(sid);
            expect((await request(r, token, `/sessions/${sid}/messages`, 'POST', { requestID: 'send_' + p.id, text: 'fixture directory task' })).body.data.state).toBe('queued');
            await r.waitForSubmitted('', 'send_'+p.id,async()=>(await request(r,token,'/requests/send_'+p.id)).body);
            r.complete(sid, p.id); expect((await request(r, token, `/sessions/${sid}/result?turnID=${p.id}`)).body.data.outcome).toBe('completed');
        }
        expect(r.spawnCount).toBe(2); expect(r.sendCount).toBe(2);
        expect((await request(r, token, '/tasks', 'POST', { machineID: 'machineA', projectID: 'projectA', requestID: 'denied' })).status).toBe(403);
        expect((await request(r, token, '/sessions/existing/status')).status).toBe(403);
        expect(JSON.stringify(r.audit)).not.toContain(token); expect(JSON.stringify(r.gateway.store.list('service-token:'))).not.toContain(token);
        await r.ownerRequest(`/connections/${c.id}`, 'DELETE'); expect((await request(r, token, '/machines')).body.error.code).toBe('GRANT_REVOKED');
    }, 15000);
    it('binds resolution to owner/client/machine/worker, requires origin, and never accepts service bearer as owner', async () => {
        const r = await setup();
        for (const patch of [{ clientID: 'other-service' }, { machineID: 'other' }, { workerID: 'other' }]) expect((await resolve(r, [r.projectB], patch)).status).toBe(403);
        expect((await r.ownerRequest('/service-connections/resolve-directories', 'POST', { clientID: 'service', workerID: 'worker', machineID: 'machineA', directories: [r.projectB] }, 'B')).status).toBe(403);
        const x = await r.gateway.app.inject({ method: 'POST', url: '/happy-control/v1/service-connections/resolve-directories', payload: {}, headers: { authorization: 'Bearer fixture-owner-A' } }); expect(x.statusCode).toBe(403);
        const y = await r.gateway.app.inject({ method: 'POST', url: '/happy-control/v1/service-connections/resolve-directories', payload: {}, headers: { origin: r.gatewayOptions.origin, authorization: 'Bearer hsvc1.fake.fake' } }); expect(y.statusCode).toBe(401);
    });
    it('rejects sibling-prefix escape, root itself, nonexistent/file paths, symlink escape, aliases of the same real directory', async () => {
        const r = await setup(); writeFileSync(join(r.dir, 'file'), 'fixture'); symlinkSync('/tmp', join(r.dir, 'escape')); symlinkSync(r.projectB, join(r.dir, 'alias'));
        for (const path of [r.dir, r.dir + '-sibling', join(r.dir, 'missing'), join(r.dir, 'file'), join(r.dir, 'escape')]) expect((await resolve(r, [path])).status, path).toBe(403);
        expect((await resolve(r, [r.projectB, join(r.dir, 'alias')])).status).toBe(403);
        const canonical = await resolve(r, [join(r.dir, 'alias')]); expect(canonical.status).toBe(200); expect(canonical.body.data.projects[0].directory).toBe(r.projectB);
    });
    it('rejects forged/expired/replayed selection, tampered bindings and pre-existing session scopes', async () => {
        const r = await setup(), selected = (await resolve(r)).body.data, valid = scope(r, selected);
        expect((await r.ownerRequest('/service-connections', 'POST', { ...valid, selectionID: 'invented' })).status).toBe(403);
        expect((await r.ownerRequest('/service-connections', 'POST', { ...valid, projects: [{ id: valid.projects[0].id, directory: r.project }] })).status).toBe(403);
        expect((await r.ownerRequest('/service-connections', 'POST', { ...valid, sessionIDs: ['existing'] })).status).toBe(400);
        expect((await r.ownerRequest('/service-connections', 'POST', valid)).status).toBe(200);
        expect((await r.ownerRequest('/service-connections', 'POST', valid)).body.error.code).toBe('DIRECTORY_SELECTION_REPLAY');
        const expired = (await resolve(r)).body.data, proofs = new MetadataStore(join(r.dir, 'gateway', 'proofs')), record = proofs.get<any>('proof:directory-selection:' + expired.selectionID); record.expiresAt = 1; proofs.set('proof:directory-selection:' + expired.selectionID, record);
        expect((await r.ownerRequest('/service-connections', 'POST', scope(r, expired))).status).toBe(403);
    });
    it('rechecks the actual canonical path before approval and again before execution', async () => {
        const r = await setup(), c = await pending(r, [r.projectB]);
        renameSync(r.projectB, r.projectB + '-old'); symlinkSync(r.projectC, r.projectB);
        expect((await approve(r, c)).body.error.code).toBe('PROJECT_PATH_CHANGED'); expect(r.gateway.grants.get(c.id).state).toBe('pending');
        const c2 = await pending(r, [r.projectC]); expect((await approve(r, c2)).status).toBe(200);
        const token = (await r.ownerRequest(`/connections/${c2.id}/service-token`, 'POST')).body.data.token;
        renameSync(r.projectC, r.projectC + '-old'); mkdirSync(r.projectC); // The same canonical path is still the approved path; never promise inode sandboxing.
        await r.stopWorker(); renameSync(r.projectC, r.projectC + '-new'); symlinkSync('/tmp', r.projectC); await r.startWorker();
        expect((await request(r, token, '/tasks', 'POST', { requestID: 'changed', machineID: 'machineA', projectID: c2.projects[0].id })).body.error.code).toBe('PROJECT_PATH_CHANGED'); expect(r.spawnCount).toBe(0);
    });
    it('persists exact approved scope across restart, fails closed offline and after removing root policy', async () => {
        const r = await setup(), c = await pending(r, [r.projectB]); expect((await approve(r, c)).status).toBe(200);
        const token = (await r.ownerRequest(`/connections/${c.id}/service-token`, 'POST')).body.data.token;
        await r.restartGateway(); expect((await request(r, token, '/machines')).body.error.code).toBe('WORKER_UNAVAILABLE'); await r.startWorker(); expect((await request(r, token, '/machines')).status).toBe(200);
        delete r.registration.directorySelection; await r.restartGateway(); expect((await request(r, token, '/machines')).body.error.code).toBe('GRANT_REVOKED');
    });
});

it('bounds directory-only jobs, rejects foreign/late/replayed worker results and closes pending requests fail closed', async () => {
    const r = await setup(); await r.stopWorker();
    const { DirectorySelections } = await import('./directories');
    const selections = new DirectorySelections(r.gateway.store, Date.now, 30);
    const input = { workerID: 'worker', machineID: 'machineA', directories: [r.projectB] };
    const first = selections.resolve(r.registration, 'userA', input), job = selections.poll('worker')!;
    expect(job.command.method).toBe('owner.resolve-directories'); expect(selections.poll('worker')).toBeNull();
    expect(() => selections.check({ ...r.registration, id: 'other' }, job.id)).toThrow('JOB_UNAVAILABLE');
    expect(() => selections.result({ ...r.registration, userID: 'other' }, { jobID: job.id, projects: [{ id: directoryProjectID(r.projectB), directory: r.projectB }] })).toThrow('JOB_UNAVAILABLE');
    await expect(first).rejects.toThrow('DIRECTORY_WORKER_UNAVAILABLE');
    expect(() => selections.result(r.registration, { jobID: job.id, projects: [{ id: directoryProjectID(r.projectB), directory: r.projectB }] })).toThrow('JOB_UNAVAILABLE');
    const second = selections.resolve(r.registration, 'userA', input), secondJob = selections.poll('worker')!;
    selections.result(r.registration, { jobID: secondJob.id, projects: [{ id: directoryProjectID(r.projectB), directory: r.projectB }] });
    expect((await second)[0].directory).toBe(r.projectB);
    expect(() => selections.result(r.registration, { jobID: secondJob.id, projects: [{ id: directoryProjectID(r.projectB), directory: r.projectB }] })).toThrow('JOB_UNAVAILABLE');
    const third = selections.resolve(r.registration, 'userA', input); selections.close(); await expect(third).rejects.toThrow('DIRECTORY_WORKER_UNAVAILABLE'); expect(r.spawnCount).toBe(0);
});

it('returns 426 both before dispatch and when a queued v3 task meets a downgraded worker, without dispatch',async()=>{
 const r=await setup(), c=await pending(r,[r.projectB]);expect((await approve(r,c)).status).toBe(200);
 const token=(await r.ownerRequest(`/connections/${c.id}/service-token`,'POST')).body.data.token;await r.stopWorker();
 await r.workerClient.request('POST','/worker/poll',{protocol:1,projectScopes:1});
 const task={requestID:'downgrade',machineID:'machineA',projectID:c.projects[0].id};
 expect((await request(r,token,'/tasks','POST',task)).status).toBe(426);
 await r.workerClient.request('POST','/worker/poll',{protocol:1,projectScopes:1,directoryScopes:1});
 const waiting=request(r,token,'/tasks','POST',task);await new Promise(resolve=>setTimeout(resolve,20));
 await r.workerClient.request('POST','/worker/poll',{protocol:1,projectScopes:1});const denied=await waiting;expect(denied.status).toBe(426);expect(denied.body.error.code).toBe('WORKER_DIRECTORY_SCOPE_UPGRADE_REQUIRED');expect(r.spawnCount).toBe(0);
 await r.startWorker();expect((await request(r,token,'/tasks','POST',task)).body.data.state).toBe('confirmed');expect(r.spawnCount).toBe(1);
});

it('expires a selected-directory service grant without any renewal or task dispatch',async()=>{
 let now=Date.now();const r=await setup(()=>now),c=await pending(r,[r.projectB]);expect((await approve(r,c)).status).toBe(200);
 const token=(await r.ownerRequest(`/connections/${c.id}/service-token`,'POST')).body.data.token;now+=61000;
 expect((await request(r,token,'/machines')).body.error.code).toBe('GRANT_EXPIRED');expect(r.spawnCount).toBe(0);
});

it('denies every declared root itself even when roots overlap',async()=>{
 const r=await setup();r.registration.directorySelection.roots.push(r.projectB);
 expect((await resolve(r,[r.projectB])).body.error.code).toBe('SCOPE_DENIED');
 const leaf=join(r.projectB,'specific-project');mkdirSync(leaf);expect((await resolve(r,[leaf])).status).toBe(200);
});
