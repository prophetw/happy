import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixtureWorker as sourceFixtureWorker } from './fixtures/parallelTaskHarness';
import { methods } from '../control';
import { hash } from '../journal';
import { canonicalBody } from './auth';

const roots: string[] = [];
const Worker = process.env.TESTLOOP_AUTONOMOUS_BUNDLE
    ? (await import(pathToFileURL(process.env.TESTLOOP_AUTONOMOUS_BUNDLE).href)).ScopedWorker : undefined;
const fixtureWorker: typeof sourceFixtureWorker = (root, grantID, workerID) => sourceFixtureWorker(root, grantID, workerID, Worker);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function setup() {
    const root = mkdtempSync(join(tmpdir(), 'happy-autonomous-')); roots.push(root);
    const repo = join(root, 'repo'); mkdirSync(repo); git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
    writeFileSync(join(repo, 'baseline'), 'original'); git(repo, 'add', 'baseline'); git(repo, 'commit', '-qm', 'base');
    const registration = { id: 'worker', userID: 'owner', machineID: 'machine', publicKey: 'fixture-key',
        projects: [{ id: 'project', directory: repo, sessionIDs: [] }], methods: [...methods], protocol: 1, projectConcurrency: 4 };
    const grant = { id: 'grant-a', clientID: 'client-a', userID: 'owner', workerID: 'worker', workerFingerprint: hash('fixture-key'),
        machineID: 'machine', projectID: 'project', projectDirectory: repo, sessionIDs: [], methods: [...methods], expiresAt: Date.now() + 600000, state: 'approved' };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ registration }));
    writeFileSync(join(root, 'grants.json'), JSON.stringify({ 'grant-a': grant, 'grant-b': { ...grant, id: 'grant-b', clientID: 'client-b' } }));
    const f = fixtureWorker(root);
    const create = async (id: string, mode = 'worktree', resources: string[] = []) => {
        const r = await f.call('tasks.create', { requestID: id, machineID: 'machine', projectID: 'project', execution: { mode, resources } });
        expect(r.ok).toBe(true); return r.data;
    };
    const send = (sessionID: string, requestID: string) => f.call('sessions.send', { sessionID, requestID, text: requestID + '.txt' });
    const task = (id: string) => f.worker.queue.tasks().find(t => t.requestID === id)!;
    return { ...f, root, repo, create, send, task };
}
afterEach(async () => {
    for (const root of roots.splice(0)) {
        for (const s of fixtureWorker(root).sessions()) try { process.kill(-s.metadata.hostPid, 'SIGKILL'); } catch (e) { if ((e as any).code !== 'ESRCH') throw e; }
        await new Promise(done => setTimeout(done, 40)); rmSync(root, { recursive: true, force: true });
    }
});

it('continues an integration task in a dirty checkout without changing staged or untracked work', async () => {
    const f = setup(); writeFileSync(join(f.repo, 'baseline'), 'existing staged edits'); git(f.repo, 'add', 'baseline');
    writeFileSync(join(f.repo, 'private-local'), 'keep'); const index = readFileSync(join(f.repo, '.git', 'index'));
    const session = await f.create('original', 'integration'); await f.send(session.sessionID, 'original-send'); await f.worker.tick();
    expect(f.task('original-send').state).toBe('running');
    expect(f.messages(session.sessionID).filter(m => m.localId)).toHaveLength(1);
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
    expect(readFileSync(join(f.repo, 'baseline'), 'utf8')).toBe('existing staged edits');
    expect(readFileSync(join(f.repo, 'private-local'), 'utf8')).toBe('keep');
});

it('runs original checkout and independent worktrees together while serializing only the same checkout', async () => {
    const f = setup(), original = await f.create('original', 'legacy'), independent = await f.create('independent'), same = await f.create('same', 'integration');
    await f.send(original.sessionID, 'original-send'); await f.send(independent.sessionID, 'independent-send'); await f.send(same.sessionID, 'same-send');
    await f.worker.tick();
    expect(f.task('original-send').state).toBe('running'); expect(f.task('independent-send').state).toBe('running');
    expect(f.task('same-send').state).toBe('waiting-resource');
    const receipt: any = await f.call('requests.get', { requestID: 'same-send' });
    expect(receipt.data.recovery).toContain('工作目录'); expect(receipt.data.recovery).toContain(original.sessionID);
    expect(f.messages(same.sessionID)).toHaveLength(0);
});

for (const managed of [true, false]) it(`refines persisted ${managed ? 'managed' : 'pre-queue-session'} exclusion without replaying its original request`, async () => {
    const f = setup();
    let original: any;
    if (managed) original = await f.create('original', 'integration', ['service:preserve']);
    else {
        original = await f.transport.rpc((await f.transport.machines())[0], { version: 1, operation: 'create', requestID: 'old-session', directory: f.repo });
        const grants = JSON.parse(readFileSync(join(f.root, 'grants.json'), 'utf8')); grants['grant-a'].sessionIDs = [original.sessionID];
        writeFileSync(join(f.root, 'grants.json'), JSON.stringify(grants));
        const config = JSON.parse(readFileSync(join(f.root, 'config.json'), 'utf8')); config.registration.projects[0].sessionIDs = [original.sessionID];
        writeFileSync(join(f.root, 'config.json'), JSON.stringify(config));
    }
    const active = fixtureWorker(f.root), independent: any = (await active.call('tasks.create', { requestID: 'independent', machineID: 'machine', projectID: 'project', execution: { mode: 'worktree' } })).data;
    const send = (sessionID: string, requestID: string) => active.call('sessions.send', { sessionID, requestID, text: requestID + '.txt' });
    await send(original.sessionID, 'original-send'); await send(independent.sessionID, 'independent-send');
    const before = f.task('original-send');
    f.worker.queue.transaction(s => {
        const task = s.tasks.find(t => t.id === before.id)!;
        task.resources = task.resources.filter(r => !r.key.startsWith('checkout:')).map(r => r.key.startsWith('repo:') ? { ...r, mode: 'exclusive' as const } : r);
        task.fingerprint = hash(canonicalBody({ requestID: task.requestID, grantID: task.grantID, workerID: task.workerID, sessionID: task.sessionID,
            authorization: task.authorization, text: task.text, resources: task.resources, workspaceID: task.workspaceID, legacy: task.legacy }));
    });
    await fixtureWorker(f.root).worker.tick();
    const after = f.task('original-send');
    expect(after.state).toBe('running'); expect(f.task('independent-send').state).toBe('running');
    expect(after.id).toBe(before.id); expect(after.requestID).toBe(before.requestID);
    if (managed) expect(after.resources).toContainEqual({ key: 'declared:service:preserve', mode: 'exclusive' });
    await send(original.sessionID, 'original-send'); expect(f.messages(original.sessionID).filter(m => m.localId)).toHaveLength(1);
});

it('keeps named service conflicts and conceals another grant execution identity in wait guidance', async () => {
    const f = setup(), first = await f.create('first', 'worktree', ['service:shared']); await f.send(first.sessionID, 'first-send');
    const foreign = fixtureWorker(f.root, 'grant-b');
    const second: any = await foreign.call('tasks.create', { requestID: 'second', machineID: 'machine', projectID: 'project', execution: { mode: 'worktree', resources: ['service:shared'] } });
    await foreign.call('sessions.send', { sessionID: second.data.sessionID, requestID: 'second-send', text: 'second.txt' });
    await f.worker.tick();
    const receipt: any = await foreign.call('requests.get', { requestID: 'second-send' });
    expect(receipt.data.executionState).toBe('waiting-resource'); expect(receipt.data.recovery).toContain('service:shared');
    expect(receipt.data.recovery).not.toContain(first.sessionID);
});

it('retains an actionable protocol failure and automatically starts the original request after recovery', async () => {
    const f = setup(), session = await f.create('protocol'); await f.send(session.sessionID, 'protocol-send');
    const rpc = f.transport.rpc;
    f.transport.rpc = async (machine, input) => input.operation === 'capabilities' ? { version: 0, operations: [] } : rpc(machine, input);
    await f.worker.scheduler.tick();
    expect(f.task('protocol-send').state).toBe('queued'); expect(f.task('protocol-send').reason).toBe('execution_unavailable:UNSUPPORTED_VERSION');
    const receipt: any = await f.call('requests.get', { requestID: 'protocol-send' });
    expect(receipt.ok).toBe(true); expect(receipt.data.recovery).toContain('协议版本不匹配');
    expect(f.messages(session.sessionID)).toHaveLength(0);
    f.transport.rpc = rpc; f.worker.queue.update(f.task('protocol-send').id, task => { delete task.notBefore; });
    await f.worker.tick(); expect(f.task('protocol-send').state).toBe('running');
    expect(f.messages(session.sessionID).filter(m => m.localId)).toHaveLength(1);
});
