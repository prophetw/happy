import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// Runtime-load the actual CLI seam without adding CLI production sources to the agent package's TypeScript rootDir.
const cliSource = new URL('../../../../happy-cli/src/daemon/automationControl.ts', import.meta.url).href;
const { createAutomationControl, observeOwnedProcess, observePersistedProcess } = await import(/* @vite-ignore */ cliSource);
import { fixtureWorker } from './fixtures/parallelTaskHarness';
import { ScopedWorker } from './worker';
import { SessionProcessProofs, readLinuxProcess } from './sessionProcessProofs';
import { methods } from '../control';
import { hash } from '../journal';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fixtures: Array<{ root: string; children: Map<number, string> }> = [];
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10000; while (!await check()) { if (Date.now() >= end) throw Error('persisted_fixture_timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'happy-persisted-scheduling-')), children = new Map<number, string>(); fixtures.push({ root, children });
    const repository = (name: string) => { const path = join(root, name); mkdirSync(path); git(path, 'init', '-q'); git(path, 'config', 'user.name', 'fixture'); git(path, 'config', 'user.email', 'fixture@invalid'); writeFileSync(join(path, 'baseline'), 'unchanged'); git(path, 'add', 'baseline'); git(path, 'commit', '-qm', 'base'); return path; };
    const repoA = repository('legacy-repo'), repoB = repository('queued-repo');
    const registration = { id: 'worker', userID: 'owner', machineID: 'machine', publicKey: 'fixture-key', projects: [{ id: 'project', directory: repoB, sessionIDs: [] }], methods: [...methods], protocol: 1, projectConcurrency: 2 };
    const grant = { id: 'grant-a', clientID: 'client-a', userID: 'owner', workerID: 'worker', workerFingerprint: hash('fixture-key'), machineID: 'machine', projectID: 'project', projectDirectory: repoB, sessionIDs: [], methods: [...methods], expiresAt: Date.now() + 600000, state: 'approved' };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ registration })); writeFileSync(join(root, 'grants.json'), JSON.stringify({ 'grant-a': grant }));
    const f = fixtureWorker(root), originalRPC = f.transport.rpc, saved = new Map<string, { savedAt: number; metadata: any }>(); let noKillAuthorityCalls = 0;
    const bootTime = Date.now() - uptime() * 1000;
    // Actual CLI status/control logic: persisted PID existence remains unknown.
    const cli = createAutomationControl({ directory: join(root, 'cli-receipts'), spawn: async () => { throw Error('unexpected_cli_spawn'); }, stop: () => { noKillAuthorityCalls++; return false; }, observe: (id: string) => observePersistedProcess(saved.get(id), 'machine', bootTime) });
    f.transport.rpc = async (machine, input) => {
        if (['status', 'cancel'].includes(String(input.operation))) return await cli(input) as Record<string, unknown>;
        const reply = await originalRPC(machine, input);
        if (input.operation === 'create' && typeof reply.sessionID === 'string') {
            const session = f.sessions().find(item => item.id === reply.sessionID)!; session.metadata.startedBy = 'daemon'; session.metadata.startedFromDaemon = true;
            writeFileSync(join(root, 'sessions', session.id, 'metadata'), JSON.stringify(session)); saved.set(session.id, { savedAt: Date.now(), metadata: session.metadata });
            const identity = readLinuxProcess(session.metadata.hostPid); expect(identity).not.toBeNull(); children.set(identity!.pid, identity!.startTicks);
        }
        return reply;
    };
    const restore = (proofs?: SessionProcessProofs) => new ScopedWorker(registration as any, f.transport, join(root, 'worker'), async () => grant as any, Date.now, undefined, async () => grant as any, join(root, 'queue'), proofs);
    const call = (worker: ScopedWorker, method: string, args: Record<string, unknown>) => worker.execute({ id: 'job', workerID: 'worker', grantID: 'grant-a', deadline: Date.now() + 60000, command: { version: 1, method, ...args } }) as Promise<any>;
    const create = async (requestID: string) => { const reply = await call(f.worker, 'tasks.create', { requestID, machineID: 'machine', projectID: 'project', execution: { mode: 'worktree' } }); expect(reply.ok).toBe(true); return reply.data; };
    const send = async (worker: ScopedWorker, sessionID: string, requestID: string) => { const reply = await call(worker, 'sessions.send', { sessionID, requestID, text: requestID + '.txt' }); expect(reply.ok).toBe(true); return reply.data; };
    const session = (id: string) => f.sessions().find(item => item.id === id)!;
    const cliStatus = async (id: string) => (await f.transport.rpc((await f.transport.machines())[0], { version: 1, operation: 'status', sessionID: id })).process;
    const trustPreviousOwnedChild = (worker: ScopedWorker, id: string) => { const value = session(id), pid = value.metadata.hostPid, stat = readFileSync('/proc/' + pid + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/); expect(Number(fields[1])).toBe(process.pid);
        // The pre-restart owner is this test's real child, not a mocked running PID.
        const owned = observeOwnedProcess({ pid, owned: Number(fields[1]) === process.pid, stopping: false }); expect(owned).toBe('running'); expect(worker.processProofs.recordRunning(value, owned)).toBe(true); };
    const ordinaryLiveSession = async () => {
        const machine = (await f.transport.machines())[0], created = await f.transport.rpc(machine, { version: 1, operation: 'create', requestID: 'legacy-direct', directory: repoA });
        const id = String(created.sessionID); await f.transport.send(session(id), 'old-authorized-input', 'legacy-work.txt');
        await until(() => f.messages(id).some(row => row.content?.content?.ev?.t === 'turn-start'));
        const input = f.messages(id).find(row => row.localId), turn = f.messages(id).find(row => row.content?.content?.ev?.t === 'turn-start').content.content.turn;
        const task = f.worker.queue.adoptLegacy({ requestID: hash(`legacy:${id}:${turn}`), workerID: 'worker', grantID: 'legacy-import', sessionID: id, authorization: '', text: '', resources: [{ key: 'machine', mode: 'exclusive' }], legacy: true, seq: input.seq, turnID: turn, processID: session(id).metadata.hostPid }); return { id, task };
    };
    return { ...f, root, repoA, repoB, saved, restore, call, create, send, session, cliStatus, trustPreviousOwnedChild, ordinaryLiveSession, noKillAuthorityCalls: () => noKillAuthorityCalls };
}
afterEach(async () => { for (const { root, children } of fixtures.splice(0)) { for (const [pid, start] of children) if (readLinuxProcess(pid)?.startTicks === start) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } await until(() => [...children].every(([pid, start]) => readLinuxProcess(pid)?.startTicks !== start)); rmSync(root, { recursive: true, force: true }); } });

it('uses a durable scheduling proof across the real persisted CLI unknown status without a machine-wide legacy lease', async () => {
    const f = fixture(), legacy = await f.ordinaryLiveSession(), queued = await f.create('other-project');
    const accepted = await f.send(f.worker, queued.sessionID, 'other-project-send'); expect(accepted.state).toBe('queued');
    expect(await f.cliStatus(legacy.id)).toBe('unknown'); expect(await f.cliStatus(queued.sessionID)).toBe('unknown');
    await f.worker.tick(); expect(f.worker.queue.tasks().find(task => task.id === legacy.task.id)!.resources).toEqual([{ key: 'machine', mode: 'exclusive' }]); expect(f.messages(queued.sessionID).filter(row => row.localId)).toHaveLength(0);
    f.trustPreviousOwnedChild(f.worker, legacy.id); f.trustPreviousOwnedChild(f.worker, queued.sessionID);
    const restarted = f.restore(); await restarted.tick(); expect(await f.cliStatus(legacy.id)).toBe('unknown');
    const retained = restarted.queue.tasks().find(task => task.id === legacy.task.id)!;
    expect(retained.resources).toContainEqual({ key: 'machine', mode: 'shared' }); expect(retained.resources).toContainEqual({ key: 'repo:' + hash(join(f.repoA, '.git')), mode: 'shared' });
    expect(retained.resources).toContainEqual({ key: 'checkout:' + hash(f.repoA), mode: 'exclusive' });
    expect(retained.id).toBe(legacy.task.id); expect(retained.processID).toBe(legacy.task.processID); expect(retained.turnID).toBe(legacy.task.turnID);
    expect(restarted.queue.tasks().find(task => task.requestID === 'other-project-send')!.state).toBe('running');
    expect(f.messages(queued.sessionID).filter(row => row.localId)).toHaveLength(1); expect(f.messages(legacy.id).filter(row => row.localId)).toHaveLength(1);
}, 20000);

it('delivers a pre-restart queued session exactly once using reviewed proof while CLI lifecycle status remains unknown', async () => {
    const f = fixture(), created = await f.create('pre-restart'), accepted = await f.send(f.worker, created.sessionID, 'queued-before-restart');
    expect(accepted.state).toBe('queued'); expect(accepted.seq).toBeUndefined();
    expect(await f.cliStatus(created.sessionID)).toBe('unknown');
    await f.worker.tick(); expect(f.messages(created.sessionID)).toHaveLength(0);
    const original = f.worker.queue.tasks().find(task => task.requestID === 'queued-before-restart')!;
    expect(original.dispatched).toBe(false);
    expect(f.worker.processProofs.recordRunning(f.session(created.sessionID), await f.cliStatus(created.sessionID))).toBe(false);
    const identity = readLinuxProcess(f.session(created.sessionID).metadata.hostPid)!;
    expect(f.worker.processProofs.importVerified(f.session(created.sessionID), identity)).toBe(true);
    const restarted = f.restore();
    await until(async () => { await restarted.tick(); return restarted.queue.tasks().find(task => task.id === original.id)?.state === 'running'; });
    for (let i = 0; i < 3; i++) await restarted.tick();
    const replay = await f.send(restarted, created.sessionID, 'queued-before-restart');
    expect(replay.queueID).toBe(accepted.queueID); expect(f.messages(created.sessionID).filter(row => row.localId)).toHaveLength(1);
    expect(restarted.queue.tasks().find(task => task.id === original.id)!.seq).toBe(1);
    expect(await f.cliStatus(created.sessionID)).toBe('unknown');
    expect((await f.call(restarted, 'sessions.status', { sessionID: created.sessionID, cursor: 0, limit: 10 })).data.process).toBe('unknown');
}, 20000);

for (const invalid of ['missing', 'pid', 'boot'] as const) it(`keeps the original machine lease and queued message untouched with ${invalid} process proof`, async () => {
    const f = fixture(), legacy = await f.ordinaryLiveSession(), created = await f.create('waiter');
    await f.send(f.worker, created.sessionID, 'waiter-send');
    let proofs: SessionProcessProofs | undefined;
    if (invalid === 'missing') {
        expect(f.worker.processProofs.recordRunning(f.session(legacy.id), await f.cliStatus(legacy.id))).toBe(false);
    } else {
        f.trustPreviousOwnedChild(f.worker, legacy.id);
        if (invalid === 'pid') {
            const other = await f.transport.rpc((await f.transport.machines())[0], { version: 1, operation: 'create', requestID: 'other-real-owner', directory: f.repoA });
            const changed = f.session(legacy.id); changed.metadata.hostPid = f.session(String(other.sessionID)).metadata.hostPid;
            writeFileSync(join(f.root, 'sessions', legacy.id, 'metadata'), JSON.stringify(changed));
        } else {
            proofs = new SessionProcessProofs(f.worker.processProofs.directory, 'machine', { inspect: pid => { const identity = readLinuxProcess(pid); return identity ? { ...identity, bootID: '11111111-1111-4111-8111-111111111111' } : null; } });
        }
    }
    const restarted = f.restore(proofs); expect(restarted.processProofs.verify(f.session(legacy.id))).toBe(false);
    await restarted.tick();
    const retained = restarted.queue.tasks().find(task => task.id === legacy.task.id)!;
    expect(retained.resources).toEqual([{ key: 'machine', mode: 'exclusive' }]);
    expect(retained.processID).toBe(legacy.task.processID); expect(retained.turnID).toBe(legacy.task.turnID);
    expect(f.messages(created.sessionID).filter(row => row.localId)).toHaveLength(0);
    expect(await f.cliStatus(legacy.id)).toBe('unknown');
}, 20000);

it('does not turn scheduling proof into lifecycle ownership or confirmed cancellation of the persisted process', async () => {
    const f = fixture(), created = await f.create('pre-restart-cancel');
    await f.send(f.worker, created.sessionID, 'cancel-after-dispatch'); f.trustPreviousOwnedChild(f.worker, created.sessionID);
    const restarted = f.restore();
    await until(async () => { await restarted.tick(); return restarted.queue.tasks().find(task => task.requestID === 'cancel-after-dispatch')?.state === 'running'; });
    expect(await f.cliStatus(created.sessionID)).toBe('unknown');
    const cancelled = await f.call(restarted, 'sessions.cancel', { sessionID: created.sessionID, requestID: 'request-cancel', sendRequestID: 'cancel-after-dispatch' });
    expect(cancelled.ok).toBe(true); await restarted.tick();
    expect(restarted.queue.tasks().find(task => task.requestID === 'cancel-after-dispatch')!.state).toBe('canceling');
    expect(await f.cliStatus(created.sessionID)).toBe('unknown');
    expect(readLinuxProcess(f.session(created.sessionID).metadata.hostPid)).not.toBeNull();
    expect(f.noKillAuthorityCalls()).toBe(1);
    expect((await f.call(restarted, 'sessions.status', { sessionID: created.sessionID, cursor: 0, limit: 10 })).data.process).toBe('unknown');
}, 20000);

it('never replays an already dispatched unknown write merely because the persisted session has valid scheduling proof', async () => {
    const f = fixture(), created = await f.create('unknown-write'), accepted = await f.send(f.worker, created.sessionID, 'unknown-send');
    const original = f.worker.queue.tasks().find(task => task.requestID === 'unknown-send')!;
    f.worker.queue.update(original.id, task => { task.dispatched = true; task.state = 'blocked'; task.reason = 'dispatch_receipt_unknown'; });
    f.trustPreviousOwnedChild(f.worker, created.sessionID);
    const restarted = f.restore(); for (let i = 0; i < 3; i++) await restarted.tick();
    const receipt = await f.call(restarted, 'requests.get', { requestID: 'unknown-send' });
    expect(receipt.data.queueID).toBe(accepted.queueID); expect(receipt.data.executionState).toBe('blocked');
    expect(restarted.queue.tasks().find(task => task.id === original.id)!.dispatched).toBe(true);
    expect(f.messages(created.sessionID).filter(row => row.localId)).toHaveLength(0);
    expect(await f.cliStatus(created.sessionID)).toBe('unknown');
    expect((await f.call(restarted, 'sessions.status', { sessionID: created.sessionID, cursor: 0, limit: 10 })).data.process).toBe('unknown');
}, 20000);

it('restores machine exclusion when a previously verified legacy owner no longer matches the boot proof', async () => {
    const f = fixture(), legacy = await f.ordinaryLiveSession(); f.trustPreviousOwnedChild(f.worker, legacy.id);
    let changedBoot = false;
    const proofs = new SessionProcessProofs(f.worker.processProofs.directory, 'machine', { inspect: pid => { const identity = readLinuxProcess(pid); return identity && changedBoot ? { ...identity, bootID: '11111111-1111-4111-8111-111111111111' } : identity; } });
    const restarted = f.restore(proofs); await restarted.tick();
    const scoped = restarted.queue.tasks().find(task => task.id === legacy.task.id)!;
    expect(scoped.resources).toContainEqual({ key: 'machine', mode: 'shared' });
    changedBoot = true; expect(proofs.verify(f.session(legacy.id))).toBe(false); await restarted.tick();
    const unverified = restarted.queue.tasks().find(task => task.id === legacy.task.id)!;
    expect(unverified.resources).toContainEqual({ key: 'machine', mode: 'exclusive' });
    expect(unverified.resources.filter(resource => resource.key !== 'machine')).toEqual(scoped.resources.filter(resource => resource.key !== 'machine'));
    const queued = await f.create('wait-for-reverified-owner'); await f.send(restarted, queued.sessionID, 'boot-change-waiter'); await restarted.tick();
    expect(f.messages(queued.sessionID).filter(row => row.localId)).toHaveLength(0);
    expect(await f.cliStatus(legacy.id)).toBe('unknown'); expect(readLinuxProcess(legacy.task.processID!)).not.toBeNull();
}, 20000);

it('retains a real freshly owned running RPC scope even when optional proof capture is unavailable', async () => {
    const f = fixture(), legacy = await f.ordinaryLiveSession();
    const ownedCLI = createAutomationControl({ directory: join(f.root, 'fresh-owned-cli'), spawn: async () => { throw Error('unexpected_cli_spawn'); }, stop: () => false,
        observe: (id: string) => { const pid = f.session(id).metadata.hostPid, stat = readFileSync('/proc/' + pid + '/stat', 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/); return observeOwnedProcess({ pid, owned: Number(fields[1]) === process.pid, stopping: false }); } });
    const rpc = f.transport.rpc; f.transport.rpc = async (machine, input) => input.operation === 'status' ? await ownedCLI(input) as Record<string, unknown> : rpc(machine, input);
    const proofs = new SessionProcessProofs(join(f.root, 'unavailable-proof-capture'), 'machine', { inspect: () => null });
    const restarted = f.restore(proofs), queued = await f.create('fresh-other-project'); await f.send(restarted, queued.sessionID, 'fresh-other-send');
    expect(await f.cliStatus(legacy.id)).toBe('running'); expect(proofs.verify(f.session(legacy.id))).toBe(false);
    await restarted.tick();
    expect(restarted.queue.tasks().find(task => task.id === legacy.task.id)!.resources).toContainEqual({ key: 'machine', mode: 'shared' });
    expect(restarted.queue.tasks().find(task => task.requestID === 'fresh-other-send')!.state).toBe('running');
    expect(f.messages(queued.sessionID).filter(row => row.localId)).toHaveLength(1);
}, 20000);

it('restores conservative legacy exclusion when corroboration is lost and the read-only observation also fails', async () => {
    const f = fixture(), legacy = await f.ordinaryLiveSession(); f.trustPreviousOwnedChild(f.worker, legacy.id);
    let inspectionUnavailable = false;
    const proofs = new SessionProcessProofs(f.worker.processProofs.directory, 'machine', { inspect: pid => inspectionUnavailable ? null : readLinuxProcess(pid) });
    const restarted = f.restore(proofs); await restarted.tick();
    expect(restarted.queue.tasks().find(task => task.id === legacy.task.id)!.resources).toContainEqual({ key: 'machine', mode: 'shared' });
    inspectionUnavailable = true;
    const messages = f.transport.messages; f.transport.messages = async (session, cursor, limit) => { if (session.id === legacy.id) throw Error('fixture_observation_unavailable'); return messages(session, cursor, limit); };
    await restarted.tick();
    const retained = restarted.queue.tasks().find(task => task.id === legacy.task.id)!;
    expect(retained.resources).toContainEqual({ key: 'machine', mode: 'exclusive' });
    expect(retained.reason).toBe('observation_unavailable'); expect(retained.turnID).toBe(legacy.task.turnID);
    expect(readLinuxProcess(legacy.task.processID!)).not.toBeNull(); expect(f.messages(legacy.id).filter(row => row.localId)).toHaveLength(1);
}, 20000);
