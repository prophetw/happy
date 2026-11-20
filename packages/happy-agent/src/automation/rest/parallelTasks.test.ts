import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync, readdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { fixtureWorker } from './fixtures/parallelTaskHarness';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { methods } from '../control';
import { TaskQueue } from './taskQueue';
import { cleanCompletedWorkspace } from './taskWorkspaces';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
const roots: string[] = [], dispatchers: ChildProcess[] = [];
async function until(fn: () => boolean | Promise<boolean>) { const end = Date.now() + 15000; while (!await fn()) { if (Date.now() > end) throw Error('condition_timeout'); await new Promise(r => setTimeout(r, 25)); } }
function setup(maxConcurrency = 2) {
    const root = mkdtempSync(join(tmpdir(), 'happy-parallel-')); roots.push(root); const repo = join(root, 'repo'); mkdirSync(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'fixture'); git(repo, 'config', 'user.email', 'fixture@invalid');
    writeFileSync(join(repo, 'baseline'), 'unchanged'); git(repo, 'add', 'baseline'); git(repo, 'commit', '-qm', 'base');
    const registration = { id: 'worker', userID: 'owner', machineID: 'machine', publicKey: 'fixture-key', projects: [{ id: 'project', directory: repo, sessionIDs: [] }], methods: [...methods], protocol: 1, projectConcurrency: maxConcurrency, machineConcurrency: maxConcurrency };
    const grant = { id: 'grant-a', clientID: 'client-a', userID: 'owner', workerID: 'worker', workerFingerprint: hash('fixture-key'), machineID: 'machine', projectID: 'project', projectDirectory: repo, sessionIDs: [], methods: [...methods], expiresAt: Date.now() + 600000, state: 'approved' };
    writeFileSync(join(root, 'config.json'), JSON.stringify({ registration }));
    writeFileSync(join(root, 'grants.json'), JSON.stringify({ 'grant-a': grant, 'grant-b': { ...grant, id: 'grant-b', clientID: 'client-b' } }));
    const f = fixtureWorker(root);
    const create = async (requestID: string, execution: unknown = { mode: 'worktree' }) => {
        const result = await f.call('tasks.create', { requestID, machineID: 'machine', projectID: 'project', execution }); expect(result.ok).toBe(true); return result.data;
    };
    const send = async (sessionID: string, requestID: string, text = requestID + '.txt') => {
        const result = await f.call('sessions.send', { requestID, sessionID, text }); expect(result.ok).toBe(true); return result.data;
    };
    const release = (id: string) => { const t = f.worker.queue.tasks().find(t => t.requestID === id)!; writeFileSync(join(root, 'sessions', t.sessionID, 'release-' + t.seq), ''); };
    const tick = () => f.worker.scheduler.tick();
    const state = (id: string) => f.worker.queue.tasks().find(t => t.requestID === id)?.state;
    return { ...f, root, repo, create, send, release, tick, state };
}
afterEach(async () => {
    for (const p of dispatchers.splice(0)) if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await once(p, 'exit'); }
    for (const root of roots.splice(0)) {
        const f = fixtureWorker(root);
        for (const s of f.sessions()) { try { process.kill(-s.metadata.hostPid, 'SIGKILL'); } catch(e) { if ((e as any).code !== 'ESRCH') throw e; } }
        await new Promise(r => setTimeout(r, 40)); rmSync(root, { recursive: true, force: true });
    }
});

describe('durable machine queue with actual Git worktrees and session processes', () => {
    it('runs two distinct worktrees; third waits and auto-starts; main remains byte-for-byte unchanged', async () => {
        const f = setup(), before = git(f.repo, 'status', '--porcelain=v1'), base = git(f.repo, 'rev-parse', 'HEAD');
        writeFileSync(join(f.repo, 'user-dirty'), 'preserve');
        const a = await f.create('a'), b = await f.create('b'), c = await f.create('c');
        expect(new Set([a.execution.directory,b.execution.directory,c.execution.directory]).size).toBe(3);
        expect(f.worker.queue.tasks()).toHaveLength(0); // create never executes instructions
        await f.send(a.sessionID,'one'); await f.send(b.sessionID,'two'); const queued = await f.send(c.sessionID,'three');
        expect(queued.state).toBe('queued'); expect(queued.seq).toBeUndefined();
        await f.tick(); expect(f.state('one')).toBe('running'); expect(f.state('two')).toBe('running'); expect(f.state('three')).toBe('queued');
        await until(() => f.messages(a.sessionID).length >= 2 && f.messages(b.sessionID).length >= 2);
        f.release('one'); await until(() => existsSync(join(a.execution.directory, 'one.txt')));
        await until(async () => { await f.tick(); return f.state('three') === 'running'; });
        f.release('two'); f.release('three');
        await until(async () => { await f.tick(); return f.worker.queue.tasks().every(t => t.state === 'completed'); });
        expect(git(f.repo,'rev-parse','HEAD')).toBe(base); expect(readFileSync(join(f.repo,'user-dirty'),'utf8')).toBe('preserve');
        expect(git(f.repo,'status','--porcelain=v1')).toBe('?? user-dirty'); expect(before).toBe('');
        for (const [w,file] of [[a,'one.txt'],[b,'two.txt'],[c,'three.txt']] as const) { expect(existsSync(join(w.execution.directory,file))).toBe(true); expect(git(w.execution.directory,'rev-parse','HEAD')).not.toBe(base); }
    }, 30000);
    it('serializes the same service while unrelated resources bypass its waiter; session follow-ups never steer', async () => {
        const f=setup(3), a=await f.create('a',{mode:'worktree',resources:['service:relay']}), b=await f.create('b',{mode:'worktree',resources:['service:relay']}), c=await f.create('c',{mode:'worktree',resources:['service:other']});
        await f.send(a.sessionID,'one'); await f.send(b.sessionID,'two'); await f.send(c.sessionID,'three'); await f.send(a.sessionID,'four'); await f.tick();
        expect(f.state('two')).toBe('waiting-resource');expect(f.state('three')).toBe('running'); expect(f.state('four')).toBe('waiting-resource');
        expect(f.messages(a.sessionID).filter(m=>m.localId)).toHaveLength(1);
        await until(()=>f.messages(a.sessionID).length>=2);f.release('one');
        await until(async()=>{await f.tick();return f.state('two')==='running';});expect(f.state('four')).toBe('waiting-resource');
        await until(()=>f.messages(b.sessionID).length>=2);f.release('two');
        await until(async()=>{await f.tick();return f.state('four')==='running';});
    },30000);
    it('deduplicates accepted and lost responses, rejects content conflicts, and cancels queued without stopping the active turn', async()=>{
        const f=setup(),a=await f.create('a');const first=await f.send(a.sessionID,'one');const duplicate=await f.send(a.sessionID,'one'); expect(duplicate.queueID).toBe(first.queueID);
        await expect(f.call('sessions.send',{sessionID:a.sessionID,requestID:'one',text:'different'})).rejects.toThrow('REQUEST_ID_CONFLICT');
        await f.tick(); await f.send(a.sessionID,'two');
        const cancel=await f.call('sessions.cancel',{sessionID:a.sessionID,requestID:'cancel',sendRequestID:'two'});expect(cancel.data.state).toBe('cancelled');expect(f.state('one')).toBe('running');expect(f.state('two')).toBe('cancelled');
        expect((await f.call('requests.get',{requestID:'one'})).data.seq).toBeGreaterThan(0);
        expect(f.messages(a.sessionID).filter(m=>m.localId)).toHaveLength(1);
        await f.call('sessions.cancel',{sessionID:a.sessionID,requestID:'cancel-running',sendRequestID:'one'});expect(f.state('one')).toBe('canceling');
        await until(async()=>{await f.tick();return f.state('one')==='cancelled';});
    });
    it('rechecks revoked grants before running, retains dirty/failed worktrees, and validates concurrency',async()=>{
        const f=setup(),a=await f.create('a');await f.send(a.sessionID,'one');const g=JSON.parse(readFileSync(join(f.root,'grants.json'),'utf8'));g['grant-a'].state='revoked';writeFileSync(join(f.root,'grants.json'),JSON.stringify(g));
        await f.tick();expect(f.state('one')).toBe('failed');expect(f.messages(a.sessionID)).toHaveLength(0);
        writeFileSync(join(a.execution.directory,'dirty'),'keep');expect(()=>cleanCompletedWorkspace(f.worker.queue, f.worker.queue.workspaces('grant-a')[0].id)).toThrow('WORKTREE_LIFECYCLE_POLICY_REQUIRED');
        expect(readFileSync(join(a.execution.directory,'dirty'),'utf8')).toBe('keep');expect(()=>new TaskQueue(join(f.root,'bad'),0)).toThrow('INVALID_CONCURRENCY');expect(()=>new TaskQueue(join(f.root,'invalid'),1.5)).toThrow('INVALID_CONCURRENCY');expect(()=>new TaskQueue(join(f.root,'queue'),3)).toThrow('QUEUE_CONFIGURATION_CHANGED');
    });
    it('holds a single cross-Dot/process ceiling and reconnects running processes after real scheduler SIGKILL',async()=>{
        const f=setup(),a=await f.create('a'),b=await f.create('b'),c=await f.create('c');await f.send(a.sessionID,'one');await f.send(b.sessionID,'two');await f.send(c.sessionID,'three');
        const harness=join(import.meta.dirname,'fixtures/parallelTaskHarness.ts');
        const start=async()=>{const p=spawn(process.execPath,['--import','tsx',harness,'--dispatch',f.root],{stdio:['ignore','ignore','pipe','ipc']});dispatchers.push(p);await new Promise<void>((resolve,reject)=>{p.on('message',(m:any)=>{if(m.ready)resolve();if(m.error)reject(Error(m.error));});p.on('exit',()=>reject(Error('dispatcher_exit')));});return p;};
        const p=await start(),q=await start();await until(()=>f.state('one')==='running'&&f.state('two')==='running');expect(f.state('three')).toBe('queued');
        p.kill('SIGKILL');await once(p,'exit');q.kill('SIGKILL');await once(q,'exit');
        expect(f.sessions().filter(s=>f.transport&&s.active)).toHaveLength(3);
        await start();await until(()=>f.messages(a.sessionID).length>=2);f.release('one');
        await until(()=>f.state('three')==='running');expect(f.messages(a.sessionID).filter(m=>m.localId)).toHaveLength(1);
        const other=fixtureWorker(f.root,'grant-b');const r=await other.call('tasks.create',{requestID:'other-create',machineID:'machine',projectID:'project',execution:{mode:'worktree'}});await other.call('sessions.send',{requestID:'other-send',sessionID:r.data.sessionID,text:'other.txt'});
        await new Promise(r=>setTimeout(r,150));expect(f.worker.queue.tasks().filter(t=>t.state==='running')).toHaveLength(2);expect(f.worker.queue.tasks().find(t=>t.requestID==='other-send')?.state).toBe('queued');
    },30000);
});


it('keeps distinct Worker owners separate while sharing the machine ceiling',async()=>{
    const f=setup(),g=JSON.parse(readFileSync(join(f.root,'grants.json'),'utf8'));g['grant-b'].workerID='worker-b';writeFileSync(join(f.root,'grants.json'),JSON.stringify(g));
    const other=fixtureWorker(f.root,'grant-b','worker-b'),a=await f.create('a');await f.send(a.sessionID,'one');
    const b=await other.call('tasks.create',{requestID:'b',machineID:'machine',projectID:'project',execution:{mode:'worktree'}});
    await other.call('sessions.send',{requestID:'two',sessionID:b.data.sessionID,text:'two.txt'});await f.tick();
    expect(f.state('two')).toBe('queued');await other.worker.scheduler.tick();expect(f.state('one')).toBe('running');expect(f.state('two')).toBe('running');
    const c=await f.create('c');await f.send(c.sessionID,'three');await Promise.all([f.tick(),other.worker.scheduler.tick()]);expect(f.state('three')).toBe('queued');
});
it('reconciles an actual persisted send after its ACK is lost without duplicate process input',async()=>{
    const f=setup(),a=await f.create('a');await f.send(a.sessionID,'one');writeFileSync(join(f.root,'lose-ack'),'');await f.tick();expect(f.state('one')).toBe('blocked');
    const restarted=fixtureWorker(f.root);await restarted.worker.scheduler.tick();expect(f.state('one')).toBe('running');expect(f.messages(a.sessionID).filter(m=>m.localId)).toHaveLength(1);
    await until(()=>f.messages(a.sessionID).length>=2);f.release('one');await until(async()=>{await restarted.worker.scheduler.tick();return f.state('one')==='completed';});
});
it('recovers a genuinely killed dispatcher before its send boundary and fails stopped task processes without replay',async()=>{
    const f=setup(),a=await f.create('a');await f.send(a.sessionID,'one');
    const p=spawn(process.execPath,['--import','tsx',join(import.meta.dirname,'fixtures/parallelTaskHarness.ts'),'--claim-only',f.root],{stdio:['ignore','ignore','pipe','ipc']});dispatchers.push(p);
    await once(p,'message');expect(f.state('one')).toBe('preparing');p.kill('SIGKILL');await once(p,'exit');await f.tick();expect(f.state('one')).toBe('running');
    const session=f.sessions().find(s=>s.id===a.sessionID);process.kill(-session.metadata.hostPid,'SIGKILL');
    await until(async()=>{await f.tick();return f.state('one')==='failed';});expect(f.messages(a.sessionID).filter(m=>m.localId)).toHaveLength(1);
});
it('adopts old live turns atomically and reduces all pages instead of treating old running as current',async()=>{
    const f=setup(),machine=(await f.transport.machines())[0];
    const old:any=await f.transport.rpc(machine,{version:1,operation:'create',requestID:'legacy-session',directory:f.repo});
    const events=join(f.root,'sessions',old.sessionID,'events');
    const turn=(seq:number,state:string)=>({id:'m'+seq,seq,content:{role:'session',content:{role:'agent',turn:'old-turn',ev:state==='running'?{t:'turn-start'}:{t:'turn-end',status:state}}}});
    appendFileSync(events,JSON.stringify(turn(1,'running'))+'\n');
    const a=await f.create('a');await f.send(a.sessionID,'one');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.legacy)?.state).toBe('running');expect(f.state('one')).toBe('running');
    for(let seq=2;seq<130;seq++)appendFileSync(events,JSON.stringify({id:'m'+seq,seq,content:{role:'unknown'}})+'\n');
    appendFileSync(events,JSON.stringify(turn(130,'completed'))+'\n');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.legacy)?.state).toBe('completed');expect(f.state('one')).toBe('running');
    // The old session PID is still alive, but its ended turn holds no execution slot.
    expect(f.transport).toBeDefined();expect(f.sessions().find(s=>s.id===old.sessionID)).toBeDefined();
});
it('scopes an ordinary live legacy turn to its canonical repository instead of blocking unrelated projects',async()=>{
    const f=setup(),other=join(f.root,'other');mkdirSync(other);git(other,'init','-q');
    const old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'ordinary-other',directory:other});
    appendFileSync(join(f.root,'sessions',old.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'ordinary-turn',ev:{t:'turn-start'}}}})+'\n');
    const task=await f.create('new-project');await f.send(task.sessionID,'new-project-send');await f.worker.tick();
    const adopted=f.worker.queue.tasks().find(t=>t.legacy)!;
    expect(adopted.resources).toEqual([{key:'machine',mode:'shared'},{key:'repo:'+hash(join(other,'.git')),mode:'shared'},{key:'checkout:'+hash(other),mode:'exclusive'},{key:'session:'+old.sessionID,mode:'exclusive'}]);
    expect(adopted.state).toBe('running');expect(f.state('new-project-send')).toBe('running');
});

for (const failure of [false, true]) it(`dispatches independent work while an older checkout history ${failure ? 'fails' : 'is held'}`, async () => {
    const f = setup(4), other = join(f.root, 'legacy-project'); mkdirSync(other); git(other, 'init', '-q');
    const old = await f.transport.rpc((await f.transport.machines())[0], { version: 1, operation: 'create', requestID: 'old-project-a', directory: other });
    const events = join(f.root, 'sessions', String(old.sessionID), 'events');
    for (let seq = 1; seq <= 101; seq++) appendFileSync(events, JSON.stringify({ id: `m${seq}`, seq, content: { role: 'unknown' } }) + '\n');
    const b = await f.create('independent-project-b', { mode: 'legacy' });
    await f.send(b.sessionID, 'independent-send');
    const rpc = f.transport.rpc;
    f.transport.rpc = async (machine, input) => input.operation === 'status' && input.sessionID === old.sessionID
        ? { version: 1, process: 'unknown' } : rpc(machine, input);
    let entered!: () => void, release!: () => void;
    const enteredPage = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.transport.messages;
    let attempts = 0;
    f.transport.messages = async (session, cursor, limit) => {
        if (session.id === old.sessionID && cursor === 100) {
            attempts++;
            entered();
            if (failure) throw Error('fixture_history_read_failed');
            await held;
        }
        return read(session, cursor, limit);
    };
    const round = f.worker.tick().catch(error => error);
    try {
        await enteredPage;
        const deadline = Date.now() + 2500;
        while (!f.messages(b.sessionID).some(m => m.content?.content?.ev?.t === 'turn-start') && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(f.state('independent-send'), 'B is durably sent before A resumes').toBe('running');
        expect(f.messages(b.sessionID).filter(m => m.localId)).toHaveLength(1);
        expect(f.messages(b.sessionID).filter(m => m.content?.content?.ev?.t === 'turn-start')).toHaveLength(1);
        expect(attempts).toBe(1);
        f.release('independent-send');
        await until(() => existsSync(join(f.repo, 'independent-send.txt')));
    } finally { release(); await round; }
}, 10000);

it('holds the checkout while another session on the same path is being checked', async () => {
    const f = setup(4);
    const old = await f.transport.rpc((await f.transport.machines())[0], { version: 1, operation: 'create', requestID: 'same-checkout-old', directory: f.repo });
    const b = await f.create('same-checkout-b', {mode:'legacy'});
    await f.send(b.sessionID, 'waiting-b');
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = f.transport.messages;
    f.transport.messages = async (session, cursor, limit) => {
        if (session.id === old.sessionID) { entered = true; await held; }
        return read(session, cursor, limit);
    };
    const round = f.worker.tick();
    try {
        await until(() => entered && f.state('waiting-b') === 'waiting-resource');
        const info = (await f.call('requests.get', {requestID:'waiting-b'})).data;
        expect(info).toMatchObject({ queueReason: 'legacy_observation', execution: {directory:f.repo} });
        expect(info.recovery).toContain(f.repo);
        expect(info.recovery).not.toContain(old.sessionID);
        expect(f.messages(b.sessionID)).toHaveLength(0);
    } finally { release(); await round; }
    expect(f.messages(b.sessionID).filter(m => m.localId)).toHaveLength(1);
});

function candidateFixture(f: ReturnType<typeof setup>) {
    const configPath = join(f.root, 'config.json'), config = JSON.parse(readFileSync(configPath, 'utf8'));
    const turnModule = join(f.root, 'candidate-turn.cjs');
    writeFileSync(turnModule, `const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const repo = ${JSON.stringify(f.repo)};
module.exports = (instruction, cwd) => {
    if (instruction.startsWith('inspect objects')) {
        const oid = /绑定的提交 ([a-f0-9]+)/.exec(instruction)[1];
        const git = (...args) => cp.execFileSync('git', ['--git-dir='+path.join(repo,'.git'), ...args], {cwd, encoding:'utf8'});
        const files = git('ls-tree','--name-only','-r',oid), diff = git('show','--format=','--no-ext-diff',oid,'--','baseline');
        return JSON.stringify({oid,files,diff,blob:git('cat-file','blob',oid+':baseline')});
    }
    if (instruction.startsWith('write candidate')) { fs.writeFileSync(path.join(cwd,'new.txt'),'candidate bytes');return 'written'; }
    if (instruction.startsWith('read candidate')) return fs.readFileSync(path.join(cwd,'new.txt'),'utf8');
    if (instruction.startsWith('isolated test')) {
        const command = 'node --test candidate.test.cjs';
        const result = cp.spawnSync(process.execPath,['--test','candidate.test.cjs'],{cwd,encoding:'utf8'});
        if (instruction.startsWith('isolated test with artifacts')) fs.writeFileSync(path.join(cwd,'kept.log'),'test evidence');
        return {text: result.stdout, events:[{t:'tool-call-start',call:'test-one',name:'CodexBash',args:{command,cwd}},
            {t:'tool-call-end',call:'test-one',exitCode:result.status}]};
    }
    return null;
};`);
    config.fixture = { turnModule, catalog: { version: 1, defaultAgent: 'codex', agents: [{ agent: 'codex', models: ['fixture-model'],
        permissionModes: ['default', 'read-only'], efforts: [], defaultModel: 'fixture-model', defaultPermissionMode: 'default', defaultEffort: '' }] } };
    config.registration.launchOptions = { version: 1, agents: [{ agent: 'codex', models: ['fixture-model'], permissionModes: ['default', 'read-only'] }] };
    writeFileSync(configPath, JSON.stringify(config));
    const scope = fixtureWorker(f.root);
    const createReview = async (requestID: string, candidate: unknown) => (await scope.call('tasks.create', { requestID, machineID: 'machine', projectID: 'project',
        options: {permissionMode:'read-only'}, execution: {mode:'read-only', candidate} })).data;
    const gitState = () => ({ worktrees: git(f.repo,'worktree','list','--porcelain'), branches: git(f.repo,'for-each-ref','refs/heads','--format=%(refname) %(objectname)') });
    const send = (sessionID: string, requestID: string, text: string) => scope.call('sessions.send',{sessionID,requestID,text});
    const tick = () => scope.worker.tick();
    const receipt = async (requestID: string) => (await scope.call('requests.get', {requestID})).data;
    const finish = async (id: string, sessionID: string) => {
        f.release(id);
        await until(() => scope.messages(sessionID).some(m => m.content?.content?.ev?.t === 'turn-end'));
        await tick();
        return scope.messages(sessionID).find(m => m.content?.content?.ev?.t === 'text')?.content.content.ev.text;
    };
    return { ...scope, createReview, send, tick, receipt, finish, gitState };
}

it('reviews an exact historic commit, tree, diff and blob without changing Git worktrees or branches', async () => {
    const f = setup(), a = candidateFixture(f), baseCommit = git(f.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(f.repo,'baseline'),'fixed candidate\n');git(f.repo,'commit','-qam','candidate');
    const commit = git(f.repo,'rev-parse','HEAD'), tree = git(f.repo,'rev-parse','HEAD^{tree}');
    writeFileSync(join(f.repo,'baseline'),'unrelated HEAD\n');git(f.repo,'commit','-qam','current');
    writeFileSync(join(f.repo,'uncommitted'),'existing work');
    const before = a.gitState();
    await expect(a.createReview('unknown-commit', {kind:'commit',commit:'a'.repeat(40)})).rejects.toThrow('CANDIDATE_UNAVAILABLE');
    await expect(a.createReview('no-commit', undefined)).rejects.toThrow('CANDIDATE_REQUIRED');
    const review = await a.createReview('pinned-review', {kind:'commit',commit,baseCommit});
    expect(review.execution).toMatchObject({candidateCommit:commit,candidateTree:tree});
    expect(review.execution.directory).not.toBe(f.repo);
    await a.send(review.sessionID,'pinned-read','inspect objects');await a.tick();
    const proof = JSON.parse(await a.finish('pinned-read',review.sessionID));
    expect(proof).toMatchObject({oid:commit,files:'baseline\n',blob:'fixed candidate\n'});
    expect(proof.diff).toContain('+fixed candidate');
    expect(a.gitState()).toEqual(before);
    expect(readFileSync(join(f.repo,'uncommitted'),'utf8')).toBe('existing work');
});

for (const changed of [false, true]) it(`hands the original checkout to an independent reviewer${changed ? ' and refuses changed bytes' : ' including an untracked file'}`, async () => {
    const f = setup(3), a = candidateFixture(f), before = a.gitState();
    const source = (await a.call('tasks.create',{requestID:'source',machineID:'machine',projectID:'project',execution:{mode:'legacy',handoff:true}})).data;
    const writer = (await a.call('tasks.create',{requestID:'writer',machineID:'machine',projectID:'project'})).data;
    await a.send(source.sessionID,'source-send','write candidate');await a.tick();
    await a.send(writer.sessionID,'waiting-write','parallel.txt');
    expect(await a.finish('source-send',source.sessionID)).toBe('written');
    const proof = await a.receipt('source-send');
    expect(proof.executionState).toBe('completed');
    expect(proof.execution.checkoutDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((await a.receipt('waiting-write')).recovery).toContain(source.sessionID);
    const review = await a.createReview('review',{kind:'checkout',requestID:'source-send',digest:proof.execution.checkoutDigest});
    expect(review.sessionID).not.toBe(source.sessionID);
    expect(review.execution.directory).toBe(f.repo);
    if (changed) writeFileSync(join(f.repo,'new.txt'),'changed after launch');
    await a.send(review.sessionID,'review-send','read candidate');await a.tick();
    if (changed) {
        expect(await a.receipt('review-send')).toMatchObject({ executionState:'failed', queueReason:'CANDIDATE_CHANGED', executionDispatched:false });
        expect(a.messages(review.sessionID)).toHaveLength(0);
    } else {
        expect((await a.receipt('waiting-write')).queueReason).toBe('candidate_review');
        expect(a.messages(writer.sessionID)).toHaveLength(0);
        expect(await a.finish('review-send',review.sessionID)).toBe('candidate bytes');
    }
    await until(async () => { await a.tick(); return f.state('waiting-write') === 'running'; });
    expect(a.messages(writer.sessionID).filter(m=>m.localId)).toHaveLength(1);
    expect(a.gitState()).toEqual(before);
});

it('releases a completed handoff through its original targeted cancel receipt', async () => {
    const f = setup(3), a = candidateFixture(f);
    const source = (await a.call('tasks.create',{requestID:'source',machineID:'machine',projectID:'project',execution:{handoff:true}})).data;
    const writer = (await a.call('tasks.create',{requestID:'writer',machineID:'machine',projectID:'project'})).data;
    await a.send(source.sessionID,'source-send','write candidate');await a.tick();await a.finish('source-send',source.sessionID);
    await a.send(writer.sessionID,'waiting-write','parallel.txt');await a.tick();
    expect((await a.receipt('waiting-write')).queueReason).toBe('candidate_review');
    const release = { sessionID:source.sessionID,requestID:'release-candidate',sendRequestID:'source-send' };
    for (let retry=0;retry<2;retry++) expect((await a.call('sessions.cancel',release)).data.state).toBe('cancelled');
    expect(await a.receipt('source-send')).toMatchObject({ executionState:'completed',execution:{reviewPending:false} });
    expect(a.state(source.sessionID)).toBe('running');
    await a.tick();expect(f.state('waiting-write')).toBe('running');
    expect(a.messages(writer.sessionID).filter(m=>m.localId)).toHaveLength(1);
});

for (const scenario of ['success', 'artifacts', 'failure']) it(`runs actual ${scenario} tests on a detached candidate and settles the checkout`, async () => {
    const f = setup(), a = candidateFixture(f);
    const keepArtifacts = scenario === 'artifacts', exitCode = scenario === 'failure' ? 1 : 0;
    writeFileSync(join(f.repo,'candidate.test.cjs'),`require('node:test')('fixed candidate',()=>require('node:assert/strict').equal(${exitCode},0));\n`);
    writeFileSync(join(f.repo,'.gitignore'),'kept.log\n');git(f.repo,'add','.');git(f.repo,'commit','-qm','candidate test');
    const commit = git(f.repo,'rev-parse','HEAD');
    writeFileSync(join(f.repo,'candidate.test.cjs'),'throw Error("wrong HEAD");');git(f.repo,'commit','-qam','current');
    const before = a.gitState(), command = 'node --test candidate.test.cjs';
    const session = await a.createReview('test-create',{kind:'test',commit,command}), cwd = session.execution.directory;
    expect(git(cwd,'rev-parse','HEAD')).toBe(commit);
    expect(a.gitState().worktrees).toContain('detached');
    expect(a.gitState().branches).toBe(before.branches);
    await a.send(session.sessionID,'test-send',keepArtifacts?'isolated test with artifacts':'isolated test');await a.tick();
    expect(await a.finish('test-send',session.sessionID)).toContain(exitCode ? '# fail 1' : '# pass 1');
    await until(async () => { await a.tick(); return Boolean((await a.receipt('test-send')).execution.testCleanup); });
    expect((await a.receipt('test-send')).execution).toMatchObject({candidateCommit:commit,resultCommit:commit,testResult:{command,exitCode},testCleanup:keepArtifacts?'retained':'removed'});
    expect(a.gitState().branches).toBe(before.branches);
    if (keepArtifacts) expect(readFileSync(join(cwd,'kept.log'),'utf8')).toBe('test evidence');
    else expect(a.gitState()).toEqual(before);
}, 20000);
it('reclassifies a persisted generated legacy machine lease without changing its turn or replaying input',async()=>{
    const f=setup(),other=join(f.root,'other');mkdirSync(other);git(other,'init','-q');
    const old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'persisted-other',directory:other});
    appendFileSync(join(f.root,'sessions',old.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'persisted-turn',ev:{t:'turn-start'}}}})+'\n');
    const previous=f.worker.queue.adoptLegacy({requestID:hash(`legacy:${old.sessionID}:persisted-turn`),workerID:'worker',grantID:'legacy-import',sessionID:old.sessionID,authorization:'',text:'',resources:[{key:'machine',mode:'exclusive'}],legacy:true,turnID:'persisted-turn',processID:f.sessions().find(s=>s.id===old.sessionID)!.metadata.hostPid});
    const task=await f.create('new-project');await f.send(task.sessionID,'after-restart');const restarted=fixtureWorker(f.root);await restarted.worker.tick();
    const adopted=restarted.worker.queue.tasks().find(t=>t.id===previous.id)!;
    expect(adopted.resources.find(r=>r.key==='machine')?.mode).toBe('shared');expect(adopted.turnID).toBe(previous.turnID);expect(adopted.processID).toBe(previous.processID);expect(adopted.requestID).toBe(previous.requestID);
    expect(restarted.worker.queue.tasks().filter(t=>t.sessionID===old.sessionID)).toHaveLength(1);expect(f.messages(old.sessionID).filter(m=>m.localId)).toHaveLength(0);expect(f.state('after-restart')).toBe('running');
    expect(fixtureWorker(f.root).worker.queue.tasks().find(t=>t.id===previous.id)?.resources).toEqual(adopted.resources);
});
it('keeps the declared scope of an explicitly managed worktree when adopting its ordinary follow-up',async()=>{
    const f=setup(3),old=await f.create('explicit-worktree',{mode:'worktree',resources:['service:old']});
    appendFileSync(join(f.root,'sessions',old.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'ordinary-turn',ev:{t:'turn-start'}}}})+'\n');
    const sameRepo=await f.create('other-worktree'),sameService=await f.create('service-waiter',{mode:'worktree',resources:['service:old']});
    await f.send(sameRepo.sessionID,'other-worktree-send');await f.send(sameService.sessionID,'service-waiter-send');await f.worker.tick();
    const adopted=f.worker.queue.tasks().find(t=>t.legacy)!;
    expect(adopted.resources.find(r=>r.key.startsWith('repo:'))?.mode).toBe('shared');expect(adopted.resources).toContainEqual({key:'declared:service:old',mode:'exclusive'});
    expect(f.state('other-worktree-send')).toBe('running');expect(f.state('service-waiter-send')).toBe('waiting-resource');
});
it('retains an unverified legacy scope until a real terminal turn, without treating the idle PID as a lease',async()=>{
    const f=setup(),old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'unknown-scope',directory:f.repo});
    const metadata=join(f.root,'sessions',old.sessionID,'metadata'),record=JSON.parse(readFileSync(metadata,'utf8'));record.metadata.path=join(f.root,'missing-directory');writeFileSync(metadata,JSON.stringify(record));
    const events=join(f.root,'sessions',old.sessionID,'events');appendFileSync(events,JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'unknown-turn',ev:{t:'turn-start'}}}})+'\n');
    const task=await f.create('waiter');await f.send(task.sessionID,'unknown-scope-waiter');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.legacy)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);expect(f.state('unknown-scope-waiter')).toBe('waiting-resource');
    appendFileSync(events,JSON.stringify({id:'m2',seq:2,content:{role:'session',content:{role:'agent',turn:'unknown-turn',ev:{t:'turn-end',status:'completed'}}}})+'\n');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.legacy)?.state).toBe('completed');expect(f.state('unknown-scope-waiter')).toBe('running');expect(f.state(old.sessionID)).toBeUndefined();
    expect(f.sessions().find(s=>s.id===old.sessionID)).toBeDefined();
});
it('never reclassifies an explicit machine maintenance task or a legacy lease with changed process identity',async()=>{
    const f=setup(3),old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'maintenance-session',directory:f.repo});
    appendFileSync(join(f.root,'sessions',old.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'maintenance-turn',ev:{t:'turn-start'}}}})+'\n');
    const explicit=f.worker.queue.enqueue({requestID:'explicit-machine-maintenance',workerID:'worker',grantID:'grant-a',sessionID:old.sessionID,authorization:hash(canonicalBody(f.grant('grant-a'))),text:'',resources:[{key:'machine',mode:'exclusive'}]});
    f.worker.queue.update(explicit.id,t=>{t.state='running';t.dispatched=true;t.seq=0;t.turnID='maintenance-turn';});
    const task=await f.create('waiter');await f.send(task.sessionID,'maintenance-waiter');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.id===explicit.id)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);expect(f.state('maintenance-waiter')).toBe('waiting-resource');
    const ordinary:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'changed-owner',directory:f.repo});
    appendFileSync(join(f.root,'sessions',ordinary.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'changed-turn',ev:{t:'turn-start'}}}})+'\n');
    const imported=f.worker.queue.adoptLegacy({requestID:hash(`legacy:${ordinary.sessionID}:changed-turn`),workerID:'worker',grantID:'legacy-import',sessionID:ordinary.sessionID,authorization:'',text:'',resources:[{key:'machine',mode:'exclusive'}],legacy:true,turnID:'changed-turn',processID:1});
    await f.worker.tick();expect(f.worker.queue.tasks().find(t=>t.id===imported.id)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);
});
it('keeps a known repository globally conservative while its execution process is unverified',async()=>{
    const f=setup(),other=join(f.root,'other');mkdirSync(other);git(other,'init','-q');
    const old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'unknown-process',directory:other});
    appendFileSync(join(f.root,'sessions',old.sessionID,'events'),JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'unknown-process-turn',ev:{t:'turn-start'}}}})+'\n');
    const rpc=f.transport.rpc;f.transport.rpc=async(machine,input)=>input.operation==='status'&&input.sessionID===old.sessionID?{version:1,process:'unknown'}:rpc(machine,input);
    const task=await f.create('waiter');await f.send(task.sessionID,'unknown-process-waiter');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.legacy)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);expect(f.state('unknown-process-waiter')).toBe('waiting-resource');
});
it('does not refine an old pending input lease from a different pending sequence',async()=>{
    const f=setup(),other=join(f.root,'other');mkdirSync(other);git(other,'init','-q');
    const old:any=await f.transport.rpc((await f.transport.machines())[0],{version:1,operation:'create',requestID:'pending-owner',directory:other});
    const previous=f.worker.queue.adoptLegacy({requestID:hash(`legacy:${old.sessionID}:input-1`),workerID:'worker',grantID:'legacy-import',sessionID:old.sessionID,authorization:'',text:'',resources:[{key:'machine',mode:'exclusive'}],legacy:true,seq:1,processID:f.sessions().find(s=>s.id===old.sessionID)!.metadata.hostPid});
    const messages=f.transport.messages;f.transport.messages=async(session,cursor,limit)=>session.id===old.sessionID?{messages:[{id:'m2',seq:2,localId:'automation:other-input',content:{role:'user',content:{type:'text',text:'pending'}}}],hasMore:false}:messages(session,cursor,limit);
    const task=await f.create('waiter');await f.send(task.sessionID,'pending-waiter');await f.worker.tick();
    expect(f.worker.queue.tasks().find(t=>t.id===previous.id)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);expect(f.state('pending-waiter')).toBe('waiting-resource');
    const snapshot=f.worker.queue.tasks().find(t=>t.id===previous.id)!;f.worker.queue.update(previous.id,t=>{t.seq=3;});
    f.worker.queue.refineLegacyResources(snapshot,[{key:'machine',mode:'shared'},{key:'repo:'+hash(join(other,'.git')),mode:'exclusive'}]);
    expect(f.worker.queue.tasks().find(t=>t.id===previous.id)?.resources).toEqual([{key:'machine',mode:'exclusive'}]);
});
it('rejects subdirectory and symlink worktree authorization, preserves dirty completed work and requires stopped cleanup',async()=>{
    const f=setup(),sub=join(f.repo,'approved-child');mkdirSync(sub);writeFileSync(join(sub,'keep'),'a');git(f.repo,'add','approved-child');git(f.repo,'commit','-qm','subdir');
    const config=JSON.parse(readFileSync(join(f.root,'config.json'),'utf8')),grants=JSON.parse(readFileSync(join(f.root,'grants.json'),'utf8'));config.registration.projects[0].directory=sub;grants['grant-a'].projectDirectory=sub;writeFileSync(join(f.root,'config.json'),JSON.stringify(config));writeFileSync(join(f.root,'grants.json'),JSON.stringify(grants));
    const scoped=fixtureWorker(f.root);await expect(scoped.call('tasks.create',{requestID:'subdir',projectID:'project',machineID:'machine',execution:{mode:'worktree'}})).rejects.toThrow('WORKTREE_REQUIRES_REPOSITORY_ROOT');
    const link=join(f.root,'link');symlinkSync(f.repo,link);config.registration.projects[0].directory=link;grants['grant-a'].projectDirectory=link;writeFileSync(join(f.root,'config.json'),JSON.stringify(config));writeFileSync(join(f.root,'grants.json'),JSON.stringify(grants));
    await expect(fixtureWorker(f.root).call('tasks.create',{requestID:'symlink',projectID:'project',machineID:'machine',execution:{mode:'worktree'}})).rejects.toThrow('PROJECT_PATH_CHANGED');
    // Restore only this fixture's configuration.
    config.registration.projects[0].directory=f.repo;grants['grant-a'].projectDirectory=f.repo;writeFileSync(join(f.root,'config.json'),JSON.stringify(config));writeFileSync(join(f.root,'grants.json'),JSON.stringify(grants));
    const fresh=fixtureWorker(f.root),a:any=await fresh.call('tasks.create',{requestID:'clean',projectID:'project',machineID:'machine',execution:{mode:'worktree'}});await fresh.call('sessions.send',{requestID:'one',sessionID:a.data.sessionID,text:'one.txt'});await fresh.worker.scheduler.tick();
    await until(()=>f.messages(a.data.sessionID).length>=2);f.release('one');await until(async()=>{await fresh.worker.scheduler.tick();return f.state('one')==='completed';});
    const w=f.worker.queue.workspaces('grant-a').find(w=>w.sessionID===a.data.sessionID)!;writeFileSync(join(w.cwd,'dirty'),'preserve');expect(()=>cleanCompletedWorkspace(f.worker.queue,w.id)).toThrow('WORKTREE_LIFECYCLE_POLICY_REQUIRED');
    expect(readFileSync(join(w.cwd,'dirty'),'utf8')).toBe('preserve');rmSync(join(w.cwd,'dirty'));expect(()=>cleanCompletedWorkspace(f.worker.queue,w.id)).toThrow('WORKTREE_LIFECYCLE_POLICY_REQUIRED');
    const pid=f.sessions().find(s=>s.id===a.data.sessionID).metadata.hostPid;process.kill(-pid,'SIGTERM');const stopped=()=>{try{process.kill(pid,0);return false;}catch(e){if((e as any).code!=='ESRCH')return false;}try{process.kill(-pid,0);return false;}catch(e){return (e as any).code==='ESRCH';}};await until(stopped);expect(()=>cleanCompletedWorkspace(f.worker.queue,w.id,stopped)).toThrow('WORKTREE_LIFECYCLE_POLICY_REQUIRED');expect(existsSync(w.cwd)).toBe(true);expect(git(f.repo,'rev-parse',w.branch!)).toBeTruthy();
});
it('authenticates durable payloads, refuses corrupt state, and reconfigures only an idle machine',()=>{
    const f=setup(), queue=f.worker.queue;
    const input={requestID:'capacity-0',grantID:'grant-a',workerID:'worker',sessionID:'fixture-session',authorization:'',text:'migration',resources:[]};
    const template=queue.enqueue(input);
    queue.transaction(s=>{s.tasks=Array.from({length:1000},(_,order)=>{const value={...input,requestID:`capacity-${order}`};return {...template,...value,order,id:hash(`${value.grantID}\n${value.requestID}`),fingerprint:hash(canonicalBody(value))};});s.nextOrder=1000;});
    expect(()=>queue.adoptLegacy({...input,requestID:'legacy-overflow'})).toThrow('QUEUE_CAPACITY_EXCEEDED');
    expect(new TaskQueue(join(f.root,'queue'),2).tasks()).toHaveLength(1000);
    expect(() => queue.enqueue({...input, requestID:'active-overflow'})).toThrow('QUEUE_CAPACITY_EXCEEDED');
    queue.transaction(s => { for (const task of s.tasks) { task.state = 'completed'; task.dispatched = true; task.seq = 1; } });
    expect(queue.cancel('grant-a','fixture-session','past-cancel')).toEqual([]);
    expect(queue.enqueue({...input, requestID:'after-history'}).order).toBe(1000);
    const reopened = new TaskQueue(join(f.root,'queue'), 2);
    expect(reopened.tasks()).toHaveLength(1001);
    expect(reopened.cancel('grant-a','fixture-session','past-cancel')).toEqual([]);
    expect(reopened.enqueue(input)).toMatchObject({ id: template.id, state: 'completed' });
    expect(reopened.claim('worker')?.requestID).toBe('after-history');
    expect(reopened.claim('worker')).toBeNull();
    reopened.update(template.id, row => { row.turnID = 'late-original-turn'; });
    expect(reopened.receipt(reopened.enqueue(input))).toMatchObject({ executionState:'completed', turnID:'late-original-turn' });
    expect(() => reopened.enqueue({...input, text:'changed'})).toThrow('REQUEST_ID_CONFLICT');
    expect(reopened.enqueue({...input, grantID:'another-grant'}).id).not.toBe(template.id);
    queue.transaction(s=>{s.tasks=[];}); // Isolated fixture only: restore an idle ledger for the encryption checks.
    queue.configureConcurrency(3);expect(new TaskQueue(join(f.root,'queue'),3).maxConcurrency).toBe(3);
    const file=readdirSync(join(f.root,'queue')).find(p=>p.endsWith('.json'))!,path=join(f.root,'queue',file);const data=JSON.parse(readFileSync(path,'utf8'));const original=structuredClone(data),key=readFileSync(join(f.root,'queue/.payload-key')),bytes=Buffer.from(data.value.sealed,'base64'),decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));const plain=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString());plain.nextOrder='corrupt';const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),payload=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final()]);data.value.sealed=Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64');writeFileSync(path,JSON.stringify(data));expect(()=>new TaskQueue(join(f.root,'queue'),3)).toThrow('QUEUE_CORRUPT');Object.assign(data,original);data.value.sealed=data.value.sealed.slice(0,-10)+'AAAAAAAAAA';writeFileSync(path,JSON.stringify(data));expect(()=>new TaskQueue(join(f.root,'queue'),3)).toThrow('QUEUE_CORRUPT');
    // afterEach only needs the unchanged fixture config, not the deliberately corrupt ledger.
    rmSync(join(f.root,'queue'),{recursive:true,force:true});
});

it('runs the signed HTTP/MCP contract through the outbound Worker into actual Git session processes',async()=>{
    const {generateKeyPairSync}=await import('node:crypto'),{createGateway}=await import('./gateway'),{ProofClient}=await import('./client'),{HTTPWorkerRunner}=await import('./worker'),{callControlTool}=await import('./mcp');
    const f=setup(),identity=(id:string)=>{const p=generateKeyPairSync('ed25519');return {id,privateKey:p.privateKey,publicKey:p.publicKey.export({type:'spki',format:'pem'}).toString()};};
    const owner=identity('client'),workerIdentity=identity('worker'),registration={...JSON.parse(readFileSync(join(f.root,'config.json'),'utf8')).registration,publicKey:workerIdentity.publicKey};
    const audit:any[]=[],gateway=createGateway({directory:join(f.root,'gateway'),origin:'http://127.0.0.1',clients:[{...owner,userID:'owner',name:'fixture'}],workers:[registration],verifyOwner:async auth=>{if(auth!=='Bearer fixture-owner')throw Error('fixture_unauthorized');return 'owner';},audit:e=>audit.push(e)});
    const address=await gateway.app.listen({port:0,host:'127.0.0.1'}),client=new ProofClient(address+'/happy-control/v1',owner,'client',{allowLoopback:true}),workerClient=new ProofClient(address+'/happy-control/v1',workerIdentity,'worker',{allowLoopback:true});
    const abort=new AbortController(),events:any[]=[];let running:Promise<void>|undefined;
    try{
        const pending=await client.request('POST','/connections',{workerID:'worker',machineID:'machine',projectID:'project',methods:[...methods],sessionIDs:[],expiresAt:Date.now()+120000});expect(pending.ok).toBe(true);
        const grantID=pending.data.id,consent=await gateway.app.inject({method:'GET',url:'/happy-control/v1/connections/'+grantID+'/consent',headers:{origin:'http://127.0.0.1',authorization:'Bearer fixture-owner'}});
        const view=consent.json().data;expect((await gateway.app.inject({method:'POST',url:'/happy-control/v1/connections/'+grantID+'/approve',headers:{origin:'http://127.0.0.1',authorization:'Bearer fixture-owner'},payload:{digest:view.digest,challenge:view.challenge}})).statusCode).toBe(200);
        const runner=new HTTPWorkerRunner(workerClient,registration,f.transport,join(f.root,'http-worker'),Date.now,undefined,join(f.root,'queue'));await runner.pollOnce();running=runner.run(abort.signal,250,e=>events.push(e));
        const a:any=await callControlTool(client,grantID,'happy_create_task',{requestID:'http-a',machineID:'machine',projectID:'project',execution:{mode:'worktree'}}),b:any=await callControlTool(client,grantID,'happy_create_task',{requestID:'http-b',machineID:'machine',projectID:'project',execution:{mode:'worktree'}}),c:any=await callControlTool(client,grantID,'happy_create_task',{requestID:'http-c',machineID:'machine',projectID:'project',execution:{mode:'worktree'}});
        for(const [s,id]of [[a,'http-one'],[b,'http-two'],[c,'http-three']] as const){expect(s.ok).toBe(true);const receipt:any=await callControlTool(client,grantID,'happy_send',{requestID:id,sessionID:s.data.sessionID,text:id+'.txt'});expect(receipt.data.state).toBe('queued');}
        await until(()=>f.state('http-one')==='running'&&f.state('http-two')==='running');expect(f.state('http-three')).toBe('queued');
        const count=()=>audit.filter(e=>e.method==='/happy-control/v1/worker/authorize').length,baseline=count();await new Promise(r=>setTimeout(r,2100));expect(count()-baseline).toBeLessThanOrEqual(16);
        f.release('http-one');await until(()=>f.state('http-three')==='running');f.release('http-two');f.release('http-three');await until(()=>f.worker.queue.tasks().every(t=>t.state==='completed'));
        const receipt:any=await callControlTool(client,grantID,'happy_request_status',{requestID:'http-three'});expect(receipt.data.executionState).toBe('completed');expect(receipt.data.execution.directory).toBe(c.data.execution.directory);expect(receipt.data.execution.resultCommit).not.toBe(c.data.execution.baseCommit);
        expect(git(f.repo,'status','--porcelain=v1')).toBe('');expect(events.filter(e=>e.state==='unavailable')).toEqual([]);expect(audit.filter(e=>e.status>=400)).toEqual([]);
    }finally{abort.abort();await running;await gateway.app.close();}
},30000);

it('does not hide a legacy running turn behind a newly queued follow-up on that same session',async()=>{
    const f=setup(),old=await f.create('old',{mode:'legacy'}),events=join(f.root,'sessions',old.sessionID,'events');
    appendFileSync(events,JSON.stringify({id:'m1',seq:1,content:{role:'session',content:{role:'agent',turn:'old-turn',ev:{t:'turn-start'}}}})+'\n');
    await f.send(old.sessionID,'follow');const a=await f.create('a'),b=await f.create('b');await f.send(a.sessionID,'one');await f.send(b.sessionID,'two');await f.worker.tick();
    expect(f.worker.queue.tasks().filter(t=>t.legacy&&t.state==='running')).toHaveLength(1);expect(f.state('follow')).toBe('waiting-resource');expect(f.state('one')).toBe('running');expect(f.state('two')).toBe('queued');expect(f.messages(old.sessionID).filter(m=>m.localId)).toHaveLength(0);
});
it('prepares a slow actual worktree outside the global queue lock without executing checkout hooks',async()=>{
    const f=setup(),a=await f.create('a'),marker=join(f.root,'hook-ran');writeFileSync(join(f.repo,'.git/hooks/post-checkout'),'#!/bin/sh\ntouch '+marker+'\n',{mode:0o755});
    const previousPath=process.env.PATH!,realGit=realpathSync(previousPath.split(':').map(dir=>join(dir,'git')).find(existsSync)!),bin=join(f.root,'git-bin');mkdirSync(bin);
    const entered=join(f.root,'git-entered'), release=join(f.root,'git-release');
    // Prove send can finish while checkout is still held, independently of CPU load.
    writeFileSync(join(bin,'git'),`#!${process.execPath}
const {spawn}=require('node:child_process');
const {writeFileSync,existsSync}=require('node:fs');
const run=()=>{
    const p=spawn(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:['inherit','inherit','inherit',3]});
    p.on('exit',code=>process.exit(code??1));
};
if(process.argv.includes('worktree')&&process.argv.includes('add')){
    writeFileSync(${JSON.stringify(entered)},'started');
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);run();}},20);
}else run();
`,{mode:0o755});
    process.env.PATH=bin+':'+previousPath;
    let pending:Promise<any>|undefined;
    try{pending=f.create('slow');await until(()=>existsSync(entered));
        await f.send(a.sessionID,'one');expect(f.state('one')).toBe('queued');
        const during=await f.call('requests.get',{requestID:'slow'});expect(during.data.state).toBe('pending');expect(during.data.sessionID).toBeUndefined();
    }finally{writeFileSync(release,'continue');try{await pending;}finally{process.env.PATH=previousPath;}}
    expect(existsSync(marker)).toBe(false);
},25000);
it('retries an old core cancellation without cancelling any later queue item',async()=>{
    const f=setup(),a=await f.create('a');await f.call('sessions.cancel',{requestID:'old-cancel',sessionID:a.sessionID});await f.send(a.sessionID,'later');
    const repeated=await f.call('sessions.cancel',{requestID:'old-cancel',sessionID:a.sessionID});expect(repeated.data.state).toBe('cancel_requested');expect(f.state('later')).toBe('queued');
    await expect(f.call('sessions.cancel',{requestID:'a',sessionID:a.sessionID})).rejects.toThrow('REQUEST_ID_CONFLICT');expect(f.state('later')).toBe('queued');
});
it('prevents A+B resource starvation while allowing unrelated C to pass',async()=>{
    const f=setup(3),a=await f.create('a',{mode:'worktree',resources:['A']}),both=await f.create('both',{mode:'worktree',resources:['A','B']}),b=await f.create('b',{mode:'worktree',resources:['B']}),c=await f.create('c',{mode:'worktree',resources:['C']});
    await f.send(a.sessionID,'one');await f.send(both.sessionID,'two');await f.send(b.sessionID,'three');await f.send(c.sessionID,'four');await f.tick();
    expect(f.state('one')).toBe('running');expect(f.state('two')).toBe('waiting-resource');expect(f.state('three')).toBe('waiting-resource');expect(f.state('four')).toBe('running');
    await until(()=>f.messages(a.sessionID).length>=2);f.release('one');await until(async()=>{await f.tick();return f.state('two')==='running';});expect(f.state('three')).toBe('waiting-resource');
});

it('uses the existing legacy mode for authorized service work with staged edits and keeps named resource exclusion', async () => {
    const f = setup();
    writeFileSync(join(f.repo, 'baseline'), 'existing staged work');
    git(f.repo, 'add', 'baseline');
    const index = readFileSync(join(f.repo, '.git', 'index'));
    const a = await f.create('service-a', { mode: 'legacy', resources: ['service:fixture'] });
    const b = await f.create('service-b', { mode: 'worktree', resources: ['service:fixture'] });
    await f.send(a.sessionID, 'service-send');
    await f.send(b.sessionID, 'other-service-send');
    await f.tick();
    expect(f.state('service-send')).toBe('running');
    expect(f.state('other-service-send')).toBe('waiting-resource');
    expect(f.worker.queue.tasks().find(t => t.requestID === 'service-send')?.resources)
        .toContainEqual({ key: 'declared:service:fixture', mode: 'exclusive' });
    expect(a.execution.directory).toBe(f.repo);
    expect(readFileSync(join(f.repo, 'baseline'), 'utf8')).toBe('existing staged work');
    expect(readFileSync(join(f.repo, '.git', 'index'))).toEqual(index);
});
