import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { SessionProcessProofs, readLinuxProcess, type LinuxProcessIdentity } from './sessionProcessProofs';
import { TaskQueue } from './taskQueue';
import { TaskScheduler } from './taskScheduler';

const roots: string[] = [], children: ChildProcess[] = [];
async function setup() {
    const root = mkdtempSync(join(tmpdir(), 'happy-process-proof-')); roots.push(root);
    const repo = join(root, 'repo'); mkdirSync(repo); execFileSync('git', ['init','-q'], { cwd: repo });
    const child = spawn(process.execPath, ['-e','setTimeout(()=>{},60000)'], { cwd: repo, stdio: 'ignore', detached: true }); children.push(child);
    await once(child, 'spawn');
    let identity: LinuxProcessIdentity | null = null;
    for (let n=0;n<100;n++) { identity=readLinuxProcess(child.pid!); if(identity?.cwd===repo)break; await new Promise(r=>setTimeout(r,5)); }
    expect(identity?.cwd).toBe(repo);
    const directory = join(root, 'proofs'), session = { id:'session-a', metadata:{ machineId:'machine-a', hostPid:child.pid!, path:repo } };
    return { root, repo, child, identity:identity!, directory, session, proofs:new SessionProcessProofs(directory,'machine-a') };
}
afterEach(async()=>{
    for(const child of children.splice(0))if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}
    for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
it('records only an actual owned-running observation and survives store reconstruction without authorizing cancellation',async()=>{
    const f=await setup();expect(f.proofs.verify(f.session)).toBe(false);
    for(const value of ['unknown','stopped','stopping',undefined])expect(f.proofs.recordRunning(f.session,value)).toBe(false);
    expect(readdirSync(f.directory)).toEqual([]);expect(f.proofs.recordRunning(f.session,'running')).toBe(true);
    expect(new SessionProcessProofs(f.directory,'machine-a').verify(f.session)).toBe(true);
    expect(statSync(f.directory).mode&0o777).toBe(0o700);
    const file=join(f.directory,readdirSync(f.directory)[0]);expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(file).uid).toBe(process.getuid?.());
    const value=JSON.parse(readFileSync(file,'utf8')).value;expect(value.source).toBe('rpc-running');expect(value.repository).toBe(join(f.repo,'.git'));
    expect(Object.keys(value).sort()).toEqual(['directory','identity','machineID','recordedAt','repository','sessionID','source','version']);
});
it('rejects changes to PID, UID, boot, start ticks, cwd, cgroup, machine and session binding',async()=>{
    const f=await setup();let current:LinuxProcessIdentity|null=f.identity;
    const proofs=new SessionProcessProofs(f.directory,'machine-a',{inspect:()=>current});expect(proofs.recordRunning(f.session,'running')).toBe(true);
    for(const change of [{pid:f.identity.pid+1},{uid:f.identity.uid+1},{bootID:'00000000-0000-4000-8000-000000000001'},{startTicks:String(BigInt(f.identity.startTicks)+1n)},{cwd:f.root},{cgroup:'changed'}]) {
        current={...f.identity,...change};expect(proofs.verify(f.session)).toBe(false);
    }
    current=null;expect(proofs.verify(f.session)).toBe(false);current=f.identity;
    expect(proofs.verify({...f.session,id:'other-session'})).toBe(false);
    expect(proofs.verify({...f.session,metadata:{...f.session.metadata,machineId:'other-machine'}})).toBe(false);
    expect(proofs.verify({...f.session,metadata:{...f.session.metadata,path:f.root}})).toBe(false);
});
it('does not overwrite corrupt, public or symlinked material and fails closed on inspection errors',async()=>{
    const f=await setup();expect(f.proofs.recordRunning(f.session,'running')).toBe(true);
    const file=join(f.directory,readdirSync(f.directory)[0]);chmodSync(file,0o644);
    expect(f.proofs.verify(f.session)).toBe(false);expect(f.proofs.recordRunning(f.session,'running')).toBe(false);chmodSync(file,0o600);
    const corrupt='{"key":"session:session-a","value":{"version":1}}';writeFileSync(file,corrupt);
    expect(f.proofs.verify(f.session)).toBe(false);expect(f.proofs.recordRunning(f.session,'running')).toBe(false);expect(readFileSync(file,'utf8')).toBe(corrupt);
    rmSync(file);const target=join(f.root,'untouched');writeFileSync(target,'preserve');symlinkSync(target,file);
    expect(f.proofs.verify(f.session)).toBe(false);expect(f.proofs.recordRunning(f.session,'running')).toBe(false);expect(readFileSync(target,'utf8')).toBe('preserve');
    expect(new SessionProcessProofs(join(f.root,'unreadable-proof'),'machine-a',{inspect:()=>{throw Error('EPERM');}}).verify(f.session)).toBe(false);
});
it('imports an operator-verified identity only if current kernel binding still matches exactly',async()=>{
    const f=await setup();expect(f.proofs.importVerified(f.session,{...f.identity,startTicks:'1'})).toBe(false);
    expect(f.proofs.importVerified(f.session,f.identity)).toBe(true);expect(f.proofs.verify(f.session)).toBe(true);
    const file=join(f.directory,readdirSync(f.directory)[0]);expect(JSON.parse(readFileSync(file,'utf8')).value.source).toBe('operator-verified');
    f.child.kill('SIGTERM');await once(f.child,'exit');expect(f.proofs.verify(f.session)).toBe(false);
});
it('can read its own maximum escaped cgroup record and rejects unbounded start ticks',async()=>{
    const f=await setup();let current={...f.identity,cgroup:'\u0001'.repeat(4096)};
    const proofs=new SessionProcessProofs(f.directory,'machine-a',{inspect:()=>current});
    expect(proofs.recordRunning(f.session,'running')).toBe(true);expect(proofs.verify(f.session)).toBe(true);
    current={...current,startTicks:'1'.repeat(33)};expect(proofs.recordRunning(f.session,'running')).toBe(false);expect(proofs.verify(f.session)).toBe(false);
});
it('does not let a dispatchable flag override stopping or invalid process states',async()=>{
    for(const processState of ['stopping','not-a-process-state']) {
        const f=await setup(), queue=new TaskQueue(join(f.root,'queue'));
        queue.enqueue({requestID:'waiting',grantID:'grant',workerID:'worker',sessionID:'session',authorization:'',text:'check',resources:[{key:'machine',mode:'shared'}]});
        let sends=0;const scheduler=new TaskScheduler(queue,{authorize:async()=>{},observe:async()=>({process:processState,cursor:0,dispatchable:true}),send:async()=>{sends++;return{seq:1,id:'message'};},stop:async()=>{}},'worker');
        await scheduler.tick();expect(sends).toBe(0);expect(queue.tasks()[0].state).toBe('waiting-resource');
    }
});
