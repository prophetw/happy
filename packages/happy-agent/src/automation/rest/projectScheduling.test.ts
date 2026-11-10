import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureWorker } from './fixtures/parallelTaskHarness';
import { methods } from '../control';
import { hash } from '../journal';
import { TaskQueue } from './taskQueue';
import { createCipheriv } from 'node:crypto';
import { canonicalBody } from './auth';

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
async function until(fn: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 15000;
    while (!await fn()) { if (Date.now() > deadline) throw Error('condition_timeout'); await new Promise(r => setTimeout(r, 25)); }
}
function setup(policy: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'happy-projects-')); roots.push(root);
    const projects = Array.from({length:5}, (_,i) => {
        const directory = join(root, 'repo'+i); mkdirSync(directory); git(directory,'init','-q');
        git(directory,'config','user.name','fixture'); git(directory,'config','user.email','fixture@invalid');
        writeFileSync(join(directory,'base'),'preserve'); git(directory,'add','base'); git(directory,'commit','-qm','base');
        // A real staged user change must survive both checkout and execution.
        writeFileSync(join(directory,'user-staged'),'preserve'); git(directory,'add','user-staged');
        return {id:'project'+i,directory,sessionIDs:[]};
    });
    const registration = {id:'worker',userID:'owner',machineID:'machine',publicKey:'fixture-key',projects,methods:[...methods],protocol:1,...policy};
    const grants = Object.fromEntries(projects.map((p,i) => ['grant-'+i,{id:'grant-'+i,clientID:'dot-'+i,userID:'owner',workerID:'worker',workerFingerprint:hash('fixture-key'),machineID:'machine',projectID:p.id,projectDirectory:p.directory,sessionIDs:[],methods:[...methods],expiresAt:Date.now()+600000,state:'approved'}]));
    writeFileSync(join(root,'config.json'),JSON.stringify({registration})); writeFileSync(join(root,'grants.json'),JSON.stringify(grants));
    const workers = projects.map((_,i)=>fixtureWorker(root,'grant-'+i)), queue = workers[0].worker.queue;
    const start = async (i: number, id: string, execution?: unknown) => {
        const created = await workers[i].call('tasks.create',{requestID:'create-'+id,machineID:'machine',projectID:projects[i].id,...(execution?{execution}:{})});
        expect(created.ok).toBe(true);
        const sent = await workers[i].call('sessions.send',{requestID:id,sessionID:created.data.sessionID,text:id+'.txt'}); expect(sent.ok).toBe(true);
        return created.data;
    };
    const state = (id: string) => queue.tasks().find(t=>t.requestID===id)!;
    const release = (id: string) => { const t=state(id); writeFileSync(join(root,'sessions',t.sessionID,'release-'+t.seq),''); };
    return {root,projects,workers,queue,start,state,release,tick:()=>workers[0].worker.scheduler.tick()};
}
afterEach(async()=>{
    for (const root of roots.splice(0)) {
        const sessions=join(root,'sessions');
        if (existsSync(sessions)) {
            const { readdirSync } = await import('node:fs');
            for (const id of readdirSync(sessions)) { const s=JSON.parse(readFileSync(join(sessions,id,'metadata'),'utf8')); try { process.kill(-s.metadata.hostPid,'SIGKILL'); } catch(e) { if((e as NodeJS.ErrnoException).code!=='ESRCH') throw e; } }
        }
        await new Promise(r=>setTimeout(r,40)); rmSync(root,{recursive:true,force:true});
    }
});

it('default policy runs five independent Git worktrees in five overlapping real children without changing original indices or HEADs',async()=>{
    const f=setup(), before=f.projects.map(p=>({head:git(p.directory,'rev-parse','HEAD'),status:git(p.directory,'status','--porcelain=v1')}));
    for(let i=0;i<5;i++) await f.start(i,'task'+i,{mode:'worktree'});
    expect(f.queue.tasks().every(t=>!t.dispatched)).toBe(true);
    await f.tick();
    expect(f.queue.tasks().filter(t=>t.state==='running')).toHaveLength(5);
    await until(()=>f.workers[0].sessions().every(s=>f.workers[0].messages(s.id).length>=2));
    const pids=f.workers[0].sessions().map(s=>s.metadata.hostPid);
    expect(new Set(pids).size).toBe(5);
    for(const pid of pids) expect(()=>process.kill(pid,0)).not.toThrow();
    // All five have a real turn-start and no turn-end at this same observation.
    expect(f.workers[0].sessions().every(s=>f.workers[0].messages(s.id).length===2)).toBe(true);
    if (process.env.HAPPY_SCHEDULING_EVIDENCE) appendFileSync(process.env.HAPPY_SCHEDULING_EVIDENCE,JSON.stringify({
        scenario:'five-project-overlap',observedAt:new Date().toISOString(),policy:f.queue.policy,
        children:f.workers[0].sessions().map(s=>({pid:s.metadata.hostPid,cwd:s.metadata.path,state:f.workers[0].state(s.id),events:f.workers[0].messages(s.id).length})),
        originalHeadsAndIndices:before,
    })+'\n');
    for(let i=0;i<5;i++) f.release('task'+i);
    await until(async()=>{await f.tick();return f.queue.tasks().every(t=>t.state==='completed');});
    for(let i=0;i<5;i++) {
        expect(git(f.projects[i].directory,'rev-parse','HEAD')).toBe(before[i].head);
        expect(git(f.projects[i].directory,'status','--porcelain=v1')).toBe(before[i].status);
        expect(readFileSync(join(f.projects[i].directory,'user-staged'),'utf8')).toBe('preserve');
    }
},30000);

it('ordinary projects and independent worktrees run together while the same checkout remains exclusive',async()=>{
    const f=setup();
    for(let i=0;i<5;i++) await f.start(i,'legacy'+i);
    await f.start(0,'same-legacy'); await f.start(0,'same-isolated',{mode:'worktree'});
    await f.tick();
    expect(f.queue.tasks().filter(t=>t.state==='running')).toHaveLength(6);
    expect(f.state('same-legacy').reason).toBe('project-limit'); expect(f.state('same-isolated').state).toBe('running');
    expect(f.workers[0].messages(f.state('same-legacy').sessionID)).toHaveLength(0);
},30000);

it('new sends on authorized pre-queue idle sessions also use project-scoped legacy locks',async()=>{
    const f=setup();
    const sessions=[];
    for(let i=0;i<3;i++) {const created=await f.workers[i].call('tasks.create',{requestID:'prequeue-'+i,machineID:'machine',projectID:'project'+i});expect(created.ok).toBe(true);sessions.push(created.data.sessionID);}
    // Reproduce the upgrade seam: existing core sessions have no queue workspace binding.
    f.queue.transaction(s=>{s.workspaces=[];});
    for(let i=0;i<3;i++) await f.workers[i].call('sessions.send',{requestID:'new-turn-'+i,sessionID:sessions[i],text:'turn.txt'});
    await f.tick();
    expect(f.queue.tasks().filter(t=>t.state==='running')).toHaveLength(3);
    expect(f.queue.tasks().every(t=>t.resources.find(r=>r.key==='machine')?.mode==='shared')).toBe(true);
});

it('named shared services exclude across projects and unrelated resources bypass the waiter',async()=>{
    const f=setup();
    await f.start(0,'service-a',{mode:'worktree',resources:['service:shared']});
    await f.start(1,'service-b',{mode:'worktree',resources:['service:shared']});
    await f.start(2,'independent',{mode:'worktree',resources:['service:other']});
    await f.tick();
    expect(f.state('service-a').state).toBe('running'); expect(f.state('service-b').reason).toBe('resource-wait');
    expect(f.state('independent').state).toBe('running');
});

it('explicit machine ceiling counts every project and has an accurate durable receipt',async()=>{
    const f=setup({machineConcurrency:2});
    for(let i=0;i<5;i++) await f.start(i,'limited'+i,{mode:'worktree'});
    await f.tick(); expect(f.queue.tasks().filter(t=>t.state==='running')).toHaveLength(2);
    for(let i=2;i<5;i++) expect(f.queue.receipt(f.state('limited'+i)).queueReason).toBe('machine-limit');
    f.release('limited0'); await until(async()=>{await f.tick();return f.state('limited2').state==='running';});
    expect(f.state('limited3').reason).toBe('machine-limit');
},30000);

it('persists canonical project overrides and rejects policy disagreement across Workers',async()=>{
    const f=setup(), config=JSON.parse(readFileSync(join(f.root,'config.json'),'utf8'));
    config.registration.projectConcurrencyOverrides={[f.projects[0].directory]:1};
    // Only this idle fixture is reconfigured; production migration never drops a ledger.
    f.queue.configureConcurrency({projectConcurrency:2,projectOverrides:{[join(f.projects[0].directory,'.git')]:1}});
    writeFileSync(join(f.root,'config.json'),JSON.stringify(config));
    const owner=fixtureWorker(f.root,'grant-0');
    const tasks=[];
    for(const id of ['one','two']) {const a=await owner.call('tasks.create',{requestID:'create-'+id,machineID:'machine',projectID:'project0',execution:{mode:'worktree'}});await owner.call('sessions.send',{requestID:id,sessionID:a.data.sessionID,text:id+'.txt'});tasks.push(a);}
    await owner.worker.scheduler.tick();
    const reopened=fixtureWorker(f.root,'grant-0');
    expect(reopened.worker.queue.tasks().find(t=>t.requestID==='two')?.reason).toBe('project-limit');
    expect(()=>new TaskQueue(join(f.root,'queue'))).toThrow('QUEUE_CONFIGURATION_CHANGED');
    expect(()=>reopened.worker.queue.configureConcurrency({projectConcurrency:3})).toThrow('QUEUE_IN_USE');
});

it('different project IDs and Dot grants for one Git common directory share one project quota across Workers',async()=>{
    const f=setup(),config=JSON.parse(readFileSync(join(f.root,'config.json'),'utf8')),grants=JSON.parse(readFileSync(join(f.root,'grants.json'),'utf8'));
    config.registration.projects[1].directory=f.projects[0].directory;
    grants['grant-1'].projectDirectory=f.projects[0].directory; grants['grant-1'].workerID='worker-b';
    writeFileSync(join(f.root,'config.json'),JSON.stringify(config));writeFileSync(join(f.root,'grants.json'),JSON.stringify(grants));
    await f.start(0,'owner-a',{mode:'worktree'});
    const b=fixtureWorker(f.root,'grant-1','worker-b');
    for(const id of ['owner-b','owner-c']) {const created=await b.call('tasks.create',{requestID:'create-'+id,projectID:'project1',machineID:'machine',execution:{mode:'worktree'}});expect(created.ok).toBe(true);await b.call('sessions.send',{requestID:id,sessionID:created.data.sessionID,text:id+'.txt'});}
    b.worker.queue.noteScheduler('worker-b');
    await f.tick(); expect(f.state('owner-b').state).toBe('queued'); // a Worker cannot claim another owner's queue.
    await b.worker.scheduler.tick(); await f.tick();
    expect(f.state('owner-a').state).toBe('running');expect(f.state('owner-b').state).toBe('running');expect(f.state('owner-c').reason).toBe('project-limit');
},30000);

it('authorized Git worktree aliases share the original repository quota, and machine quotas span Worker owners',async()=>{
    const f=setup({machineConcurrency:2}), config=JSON.parse(readFileSync(join(f.root,'config.json'),'utf8')),grants=JSON.parse(readFileSync(join(f.root,'grants.json'),'utf8'));
    const alias=join(f.root,'approved-alias');git(f.projects[0].directory,'worktree','add','-qb','alias',alias);
    config.registration.projects[1].directory=alias;grants['grant-1'].projectDirectory=alias;grants['grant-1'].workerID='worker-b';
    writeFileSync(join(f.root,'config.json'),JSON.stringify(config));writeFileSync(join(f.root,'grants.json'),JSON.stringify(grants));
    await f.start(0,'primary',{mode:'worktree'});
    const b=fixtureWorker(f.root,'grant-1','worker-b');
    const created=await b.call('tasks.create',{requestID:'alias-create',projectID:'project1',machineID:'machine',execution:{mode:'worktree'}});
    expect(created.ok).toBe(true);await b.call('sessions.send',{requestID:'alias-send',sessionID:created.data.sessionID,text:'alias.txt'});
    await f.start(2,'different-project',{mode:'worktree'});b.worker.queue.noteScheduler('worker-b');
    await f.tick();await b.worker.scheduler.tick();await f.tick();
    expect(f.queue.tasks().filter(t=>t.state==='running')).toHaveLength(2);
    expect(f.state('different-project').reason).toBe('machine-limit');
    const workspaces=f.queue.transaction(s=>s.workspaces);
    expect(new Set(workspaces.filter(w=>['project0','project1'].includes(w.projectID)).map(w=>w.repository)).size).toBe(1);
},30000);

it('retains explicit legacy maxConcurrency=2 as a machine ceiling and removes the old maximum of four',async()=>{
    const f=setup({maxConcurrency:2});
    for(let i=0;i<3;i++) await f.start(i,'old-explicit'+i,{mode:'worktree'});
    await f.tick();expect(f.state('old-explicit2').reason).toBe('machine-limit');
    expect(new TaskQueue(join(f.root,'unlimited-new'),{machineConcurrency:5}).policy.machineConcurrency).toBe(5);
});

// Write a genuine authenticated V1 ledger, rather than bypassing the persisted migration.
function writeV1(f: ReturnType<typeof setup>, limit: number) {
    const dir=join(f.root,'queue'),snapshot=f.queue.transaction(s=>s);
    const tasks=snapshot.tasks.map(t=>{const v={...t,resources:t.resources.map(r=>r.key==='machine'?{...r,mode:'exclusive' as const}:r)};v.fingerprint=hash(canonicalBody({requestID:v.requestID,grantID:v.grantID,workerID:v.workerID,sessionID:v.sessionID,authorization:v.authorization,text:v.text,resources:v.resources,workspaceID:v.workspaceID,legacy:v.legacy}));return v;});
    const {policy:_policy,...rest}=snapshot,plain={...rest,version:1,maxConcurrency:limit,tasks};
    const file=join(dir,readdirSync(dir).find(p=>p.endsWith('.json'))!),data=JSON.parse(readFileSync(file,'utf8'));
    const key=readFileSync(join(dir,'.payload-key')),iv=Buffer.alloc(12,7),cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(plain)),cipher.final()]);
    data.value.sealed=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');writeFileSync(file,JSON.stringify(data));
}

it('migrates the old default into project 2, preserves live global exclusion and idempotent requests, and never widens a non-default machine limit',async()=>{
    const f=setup(); const active=await f.start(0,'old-active');await f.tick();
    await f.start(1,'new-project',{mode:'worktree'});writeV1(f,2);
    const upgraded=fixtureWorker(f.root,'grant-0');
    expect(upgraded.worker.queue.policy).toMatchObject({projectConcurrency:2,machineConcurrency:null});
    await upgraded.worker.scheduler.tick();expect(f.state('new-project').reason).toBe('resource-wait');
    const duplicate=await upgraded.call('sessions.send',{requestID:'old-active',sessionID:active.sessionID,text:'old-active.txt'});expect(duplicate.ok).toBe(true);
    f.release('old-active');await until(async()=>{await upgraded.worker.scheduler.tick();return f.state('new-project').state==='running';});
    // No replay of the old mutation at migration/reconciliation boundaries.
    expect(upgraded.messages(active.sessionID).filter(m=>m.localId)).toHaveLength(1);
    writeV1(f,3);
    expect(()=>new TaskQueue(join(f.root,'queue'))).toThrow('QUEUE_MIGRATION_REQUIRES_MACHINE_LIMIT');
    expect(new TaskQueue(join(f.root,'queue'),{machineConcurrency:3}).policy.machineConcurrency).toBe(3);
},30000);

it('two worktrees per project run; a project waiter does not block another project and receipts explain the limit',async()=>{
    const f=setup(), p=f.projects[0], head=git(p.directory,'rev-parse','HEAD'), status=git(p.directory,'status','--porcelain=v1');
    for(const id of ['a','b','c']) await f.start(0,id,{mode:'worktree'});
    await f.start(1,'other',{mode:'worktree'}); await f.tick();
    expect(f.state('a').state).toBe('running'); expect(f.state('b').state).toBe('running');
    expect(f.queue.receipt(f.state('c')).queueReason).toBe('project-limit'); expect(f.state('other').state).toBe('running');
    f.release('a'); await until(async()=>{await f.tick();return f.state('c').state==='running';});
    for(const id of ['b','c','other']) f.release(id);
    await until(async()=>{await f.tick();return f.queue.tasks().every(t=>t.state==='completed');});
    expect(git(p.directory,'rev-parse','HEAD')).toBe(head); expect(git(p.directory,'status','--porcelain=v1')).toBe(status);
},30000);
