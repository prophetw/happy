import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, createCipheriv } from 'node:crypto';
import { hash } from '../journal';
import { projectResponse } from './projection';
import { TaskQueue } from './taskQueue';
import { MetadataStore } from './store';
import { TaskScheduler } from './taskScheduler';
import { prepareWorkspace, workspaceResult, workspaceResources, workspaceGit, verifyWorkspace, withManagedWorkspaceLaunch } from './taskWorkspaces';
import { SessionProcessProofs, readLinuxProcess } from './sessionProcessProofs';
import { workspaceCommand, workspaceMain } from '../production/workspaces';
import { WorkspaceLifecycle, type WorkspacePolicy, type Activity, linuxWorkspaceActivity } from './workspaceLifecycle';
import { reclaimRecord, reclaimRecords } from './workspaceReclaimState';

const roots:string[]=[];
const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(retireAfterIntegration = false) {
    const root=mkdtempSync(join(tmpdir(),'happy-lifecycle-'));roots.push(root);
    const repo=join(root,'repo');mkdirSync(repo);git(repo,'init','-q','-b','main');git(repo,'config','user.name','fixture');git(repo,'config','user.email','fixture@invalid');
    writeFileSync(join(repo,'base.txt'),'base\n');writeFileSync(join(repo,'.gitignore'),'private-note\n');git(repo,'add','base.txt','.gitignore');git(repo,'commit','-qm','base');
    const directory=join(root,'machine'),queue=new TaskQueue(directory,{}, {machineID:'machine'});
    const w=await prepareWorkspace(queue,{requestID:'create',grantID:'grant',projectID:'project',root:repo,execution:{mode:'worktree',...(retireAfterIntegration ? {retireAfterIntegration:true} : {})}});
    queue.transaction(s=>{s.workspaces.find(x=>x.id===w.id)!.sessionID='session';});
    const task=queue.enqueue({requestID:'send',grantID:'grant',workerID:'worker',sessionID:'session',workspaceID:w.id,authorization:'',text:'fixture',resources:workspaceResources(w,'session')});
    let activity:Activity={confirmed:true,blockers:[],fingerprint:'clear'},clock=1000;
    const policy:WorkspacePolicy={version:1,id:'fixture-policy',machineID:'machine',grantID:'grant',projectID:'project',root:repo,mainRef:'refs/heads/main',allowApply:true};
    const manager=(overrides:Partial<WorkspacePolicy>={},effect=workspaceGit,authorize:()=>void|Promise<void>=()=>{},current:()=>void=()=>{})=>new WorkspaceLifecycle(queue,{...policy,...overrides},async()=>activity,()=>clock,effect,authorize,current);
    const scheduler=new TaskScheduler(queue,{authorize:async()=>{},send:async()=>({seq:1,id:'sent'}),stop:async()=>{},observe:async()=>({process:'running',cursor:1,seq:1,outcome:'completed',...workspaceResult(w)})});
    const complete=async()=>{await scheduler.tick();await scheduler.tick();expect(queue.tasks()[0].state).toBe('completed');};
    const save=()=>{writeFileSync(join(w.cwd,'feature.txt'),'feature\n');git(w.cwd,'add','feature.txt');git(w.cwd,'commit','-qm','feature');queue.update(task.id,t=>{t.resultCommit=git(w.cwd,'rev-parse','HEAD');t.worktreeDirty=false;});};
    const integrate=()=>git(repo,'merge','--ff-only',git(w.cwd,'rev-parse','HEAD'));
    const resolve=async(m=manager(),kind:'integrated'|'archived'|'discarded'|'no-change'='integrated')=>m.resolve(w.id,{operationID:'resolve',expectedRevision:0,head:git(w.cwd,'rev-parse','HEAD'),kind,source:'fixture:review'});
    return {root,repo,queue,w,task,policy,manager,scheduler,complete,save,integrate,resolve,
        activity:(value:Activity)=>{activity=value;},advance:(n:number)=>{clock+=n;}};
}

it('closes create -> queue/run -> pending result -> integrated -> planned -> removed -> query/rebuild, without losing refs',async()=>{
    const f=await fixture(),m=f.manager();
    expect((await m.plan(f.w.id)).reasons).toContain('queued_running_or_recovery_reference');
    await f.scheduler.tick();expect(f.queue.tasks()[0].state).toBe('running');
    expect((await m.plan(f.w.id)).eligible).toBe(false);
    await f.scheduler.tick();expect((await m.plan(f.w.id)).reasons).toContain('no_change_needs_resolution');
    f.save();await expect(f.resolve()).rejects.toThrow('WORKSPACE_NOT_IN_MAIN');
    f.integrate();await f.resolve();
    f.activity({confirmed:true,blockers:['live_session_or_process'],fingerprint:'idle-live'});
    expect((await m.plan(f.w.id)).reasons).toContain('live_session_or_process'); // completed != stopped
    f.activity({confirmed:true,blockers:[],fingerprint:'clear'});
    const plan=await m.plan(f.w.id);expect(plan.eligible).toBe(true);
    const main=git(f.repo,'rev-parse','main'),removed=await m.apply(plan,'retire');
    expect(removed.state).toBe('removed');expect(removed.removal).toBe('git-confirmed');expect(existsSync(f.w.cwd)).toBe(false);
    expect(git(f.repo,'rev-parse','main')).toBe(main);expect(git(f.repo,'rev-parse',f.w.branch!)).toBe(main);
    const result=m.result(f.w.id);expect(result.workspaceState).toBe('retired');expect(result.disposition!.sourceTaskID).toBe(f.task.id);
    expect(await m.plan(f.w.id)).toMatchObject({workspaceState:'retired',outcome:'resolved',eligible:false,reasons:['already_retired'],head:main});
    expect(git(f.repo,'show',`${result.disposition!.retainedRef}:feature.txt`)).toBe('feature');
    expect(f.queue.receipt(f.task).execution!.workspaceState).toBe('retired');
    expect((projectResponse({version:1,ok:true,data:f.queue.receipt(f.task)}).data as any).execution.retainedRef).toBe(result.disposition!.retainedRef);
    expect((projectResponse({version:1,ok:true,data:{execution:{retainedRef:'refs/heads/main'}}}).data as any).execution.retainedRef).toBe('unknown');
    if(process.env.WORKSPACE_LIFECYCLE_FIXTURE)writeFileSync(process.env.WORKSPACE_LIFECYCLE_FIXTURE,JSON.stringify(projectResponse({version:1,ok:true,data:f.queue.receipt(f.task)})),{mode:0o600});
    expect(()=>verifyWorkspace(f.queue.workspaces('grant')[0])).toThrow('WORKSPACE_RETIRED');
    await expect(prepareWorkspace(f.queue,{requestID:'create',grantID:'grant',projectID:'project',root:f.repo,execution:{mode:'worktree'}})).rejects.toThrow('WORKSPACE_RETIRED');
    expect(()=>f.queue.enqueue({requestID:'new-send',grantID:'grant',workerID:'worker',sessionID:'session',workspaceID:f.w.id,authorization:'',text:'new',resources:[]})).toThrow('WORKSPACE_RETIRED');
    const rebuild=result.rebuild!;execFileSync(rebuild.command,rebuild.args,{stdio:'pipe'});
    expect(readFileSync(join(rebuild.args.at(-2)!,'feature.txt'),'utf8')).toBe('feature\n');
    expect(await m.apply(plan,'retire')).toEqual(removed); // old operation cannot delete the new checkout
    expect(existsSync(rebuild.args.at(-2)!)).toBe(true);
});
it('rechecks the original plan expiry and local policy after a delayed final authorization',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');let checks=0;
    const m=f.manager({},workspaceGit,async()=>{if(++checks===2)f.advance(60001);});
    const plan=await m.plan(f.w.id),result=await m.apply(plan,'expires-in-authorization');
    expect(result.state).toBe('failed');expect(result.reason).toBe('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');expect(existsSync(f.w.cwd)).toBe(true);
    f.advance(-60001);
    const guarded=f.manager({},workspaceGit,()=>{},()=>{throw Error('policy revoked');});
    const blocked=await guarded.apply(await guarded.plan(f.w.id),'policy-at-remove');
    expect(blocked.state).toBe('failed');expect(blocked.reason).toBe('WORKSPACE_AUTHORIZATION_CHANGED');expect(existsSync(f.w.cwd)).toBe(true);
});

it.each(['staged','unstaged','untracked','ignored'] as const)('retains %s files and never resolves them as an old clean HEAD',async layer=>{
    const f=await fixture();await f.complete();const path=join(f.w.cwd,layer==='untracked'?'new.txt':layer==='ignored'?'private-note':'base.txt');
    writeFileSync(path,'must retain\n');if(layer==='staged')git(f.w.cwd,'add','base.txt');
    const main=git(f.repo,'rev-parse','main'),m=f.manager(),plan=await m.plan(f.w.id);
    expect(plan.eligible).toBe(false);expect(plan.reasons).toContain(layer==='ignored'?'ignored_artifacts':'staged_unstaged_or_untracked');
    await expect(f.resolve(m,'no-change')).rejects.toThrow('WORKSPACE_UNSAVED_ARTIFACTS');
    expect(readFileSync(path,'utf8')).toBe('must retain\n');expect(git(f.repo,'rev-parse','main')).toBe(main);
});

it('requires result evidence, blocks recovery/queued references, and treats a completed task with live/unknown session as occupied',async()=>{
    const f=await fixture();await f.complete();
    f.queue.update(f.task.id,t=>{delete t.resultCommit;});expect((await f.manager().plan(f.w.id)).reasons).toContain('result_unconfirmed');
    await expect(f.resolve(f.manager(),'no-change')).rejects.toThrow('WORKSPACE_RESULT_UNCONFIRMED');
    f.queue.update(f.task.id,t=>{t.resultCommit=f.w.baseCommit;});await f.resolve(f.manager(),'no-change');
    f.activity({confirmed:false,blockers:['session_mapping_unconfirmed'],fingerprint:''});expect((await f.manager().plan(f.w.id)).eligible).toBe(false);
    f.activity({confirmed:true,blockers:['live_session_or_process'],fingerprint:'live'});expect((await f.manager().plan(f.w.id)).eligible).toBe(false);
    f.activity({confirmed:true,blockers:[],fingerprint:'clear'});
    f.queue.enqueue({requestID:'recovery',grantID:'grant',workerID:'worker',sessionID:'session',authorization:'',text:'recovery',resources:[]});
    expect((await f.manager().plan(f.w.id)).reasons).toContain('queued_running_or_recovery_reference');expect(existsSync(f.w.cwd)).toBe(true);
});

it.each(['archived','discarded'] as const)('requires explicit %s policy and pins unique committed results without calling merge/push',async kind=>{
    const f=await fixture();await f.complete();f.save();const main=git(f.repo,'rev-parse','main');
    await expect(f.resolve(f.manager(),kind)).rejects.toThrow('WORKSPACE_DISPOSITION_NOT_AUTHORIZED');
    const m=f.manager({allowArchive:kind==='archived',allowDiscard:kind==='discarded'});await f.resolve(m,kind);
    const result=await m.apply(await m.plan(f.w.id),'retire');expect(result.state).toBe('removed');
    expect(git(f.repo,'rev-parse','main')).toBe(main);expect(git(f.repo,'show',`${result.retainedRef}:feature.txt`)).toBe('feature');
});

it('proves complete patch equivalence without mistaking the original SHA for main ancestry',async()=>{
    const f=await fixture();await f.complete();f.save();const original=git(f.w.cwd,'rev-parse','HEAD');
    git(f.repo,'cherry-pick',original); // Force a distinct rewritten commit while retaining the same patch.
    git(f.repo,'commit','--amend','-qm','rewritten equivalent');expect(git(f.repo,'rev-parse','main')).not.toBe(original);
    await f.resolve();expect(f.manager().result(f.w.id).disposition!.proof).toBe('patch-equivalent');
    expect((await f.manager().apply(await f.manager().plan(f.w.id),'retire')).state).toBe('removed');
});

it('does not hide an older result commit when a later branch starts again from base',async()=>{
    const f=await fixture();await f.complete();f.save();git(f.w.cwd,'switch','-q','-c','other',f.w.baseCommit!);
    await expect(f.resolve(f.manager(),'no-change')).rejects.toThrow('WORKSPACE_RESULT_HISTORY_UNCONFIRMED');expect(existsSync(f.w.cwd)).toBe(true);
});

it('preserves missing legacy ownership until explicit adoption and reads queue/metadata without initialization or rewriting',async()=>{
    const f=await fixture();await f.complete();f.queue.transaction(s=>{delete s.workspaces[0].managedBy;});
    const names=readdirSync(f.queue.directory),before=new Map(names.filter(n=>n.endsWith('.json')||n==='.queue-lock'||n==='.payload-key').map(n=>[n,{bytes:readFileSync(join(f.queue.directory,n)).toString('base64'),mtime:statSync(join(f.queue.directory,n)).mtimeMs}]));
    const q=new TaskQueue(f.queue.directory,{}, {machineID:'machine',readOnly:true}),read=new WorkspaceLifecycle(q,f.policy,async()=>({confirmed:true,blockers:[],fingerprint:'clear'}));
    expect((await read.inventory()).items[0].state).toBe('legacy_unconfirmed');expect((await read.plan(f.w.id)).reasons).toContain('WORKSPACE_OWNER_UNCONFIRMED');
    expect(existsSync(join(f.queue.directory,'workspace-lifecycle'))).toBe(false);
    for(const [n,v] of before){expect(readFileSync(join(f.queue.directory,n)).toString('base64')).toBe(v.bytes);expect(statSync(join(f.queue.directory,n)).mtimeMs).toBe(v.mtime);}
    await expect(read.adopt(f.w.id,'adopt',0,f.w.baseCommit!)).rejects.toThrow('WORKSPACE_READ_ONLY');
    const m=f.manager();const a=await m.adopt(f.w.id,'adopt',0,f.w.baseCommit!);expect(a.state).toBe('adopted');expect(await m.adopt(f.w.id,'adopt',0,f.w.baseCommit!)).toEqual(a);
    await m.resolve(f.w.id,{operationID:'resolve',expectedRevision:1,head:f.w.baseCommit!,kind:'no-change',source:'fixture:adopt'});expect((await m.plan(f.w.id)).eligible).toBe(true);
    const absent=join(f.root,'nonexistent');expect(()=>new TaskQueue(absent,{}, {readOnly:true})).toThrow();expect(existsSync(absent)).toBe(false);
});

it.each(['owner','grant','project','machine','manual','traversal','protected','symlink','alternates','locked','index-flag'] as const)('blocks %s identity/path bypass without removing a directory',async kind=>{
    const f=await fixture();await f.complete();let m=f.manager();
    if(kind==='owner')f.queue.transaction(s=>{s.workspaces[0].managedBy!.uid++;});
    if(kind==='grant')m=f.manager({grantID:'other'});
    if(kind==='project')m=f.manager({projectID:'other'});
    if(kind==='machine'){expect(()=>f.manager({machineID:'other'})).toThrow('WORKSPACE_MACHINE_MISMATCH');return;}
    if(kind==='manual')f.queue.transaction(s=>{s.workspaces[0].cwd=f.repo;});
    if(kind==='traversal')f.queue.transaction(s=>{s.workspaces[0].cwd=join(f.queue.directory,'worktrees')+'/../repo';});
    if(kind==='protected')m=f.manager({protectedDirectories:[join(f.w.cwd,'service')]});
    if(kind==='symlink'){const moved=join(f.root,'moved');renameSync(f.w.cwd,moved);symlinkSync(moved,f.w.cwd,'dir');}
    if(kind==='alternates')writeFileSync(join(f.repo,'.git/objects/info/alternates'),join(f.root,'missing-objects')+'\n');
    if(kind==='locked')git(f.repo,'worktree','lock',f.w.cwd);
    if(kind==='index-flag')git(f.w.cwd,'update-index','--assume-unchanged','base.txt');
    if(['grant','project'].includes(kind))await expect(m.plan(f.w.id)).rejects.toThrow('WORKSPACE_SCOPE_DENIED');
    else expect((await m.plan(f.w.id)).eligible).toBe(false);
    expect(readFileSync(join(f.w.cwd,'base.txt'),'utf8')).toBe('base\n');expect(readFileSync(join(f.repo,'base.txt'),'utf8')).toBe('base\n');
});

it.each(['head','untracked','ignored','queue','expiry'] as const)('rejects a plan after %s changes',async kind=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');const m=f.manager(),plan=await m.plan(f.w.id);
    if(kind==='head')f.save();
    if(kind==='untracked')writeFileSync(join(f.w.cwd,'new.txt'),'keep');
    if(kind==='ignored')writeFileSync(join(f.w.cwd,'private-note'),'keep');
    if(kind==='queue')f.queue.enqueue({requestID:'later',grantID:'grant',workerID:'worker',sessionID:'session',authorization:'',text:'new',resources:[]});
    if(kind==='expiry')f.advance(60001);
    await expect(m.apply(plan,'retire')).rejects.toThrow(kind==='expiry'?'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED':'WORKSPACE_PLAN_CHANGED');expect(existsSync(f.w.cwd)).toBe(true);
});

it('serializes repeated apply, rejects changed operation parameters, and never deletes a replacement checkout on replay',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');const m=f.manager(),plan=await m.plan(f.w.id);
    const [a,b]=await Promise.all([m.apply(plan,'retire'),m.apply(plan,'retire')]);expect(a).toEqual(b);
    git(f.repo,'worktree','add','-q','-b','replacement',f.w.cwd,a.retainedRef!);
    expect(await m.apply(plan,'retire')).toEqual(a);expect(existsSync(f.w.cwd)).toBe(true);
    await expect(m.resolve(f.w.id,{operationID:'resolve',expectedRevision:0,head:plan.head!,kind:'integrated',source:'changed'})).rejects.toThrow('WORKSPACE_OPERATION_CONFLICT');
});

it('records a normal Git refusal, retains every file/ref and permits only a freshly planned retry',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');let removes=0;
    const effect:typeof workspaceGit=async(cwd,args,fd)=>{if(args[0]==='worktree'&&args[1]==='remove'){removes++;expect(args).not.toContain('--force');expect(args).not.toContain('-f');throw Error('fixture denied');}return workspaceGit(cwd,args,fd);};
    const m=f.manager({},effect),plan=await m.plan(f.w.id),a=await m.apply(plan,'retire');expect(a.state).toBe('failed');expect(a.reason).toBe('WORKTREE_REMOVE_REFUSED');
    expect(await m.apply(plan,'retire')).toEqual(a);expect(removes).toBe(1);expect(existsSync(f.w.cwd)).toBe(true);expect(git(f.repo,'rev-parse',f.w.branch!)).toBe(f.w.baseCommit);
    expect((await f.manager().apply(await f.manager().plan(f.w.id),'retry')).state).toBe('removed');
});

it('reconciles an unknown remove result after restart/expiry without issuing a second remove',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');let removes=0;
    const effect:typeof workspaceGit=async(cwd,args,fd)=>{const result=await workspaceGit(cwd,args,fd);if(args[0]==='worktree'&&args[1]==='remove'){removes++;throw Error('lost acknowledgement');}return result;};
    const m=f.manager({},effect),plan=await m.plan(f.w.id);await expect(m.apply(plan,'retire')).rejects.toThrow('WORKSPACE_REMOVAL_UNCONFIRMED');expect(existsSync(f.w.cwd)).toBe(false);
    f.advance(60001);const result=await f.manager().apply(plan,'retire');expect(result.state).toBe('removed');expect(result.removal).toBe('absence-after-intent');expect(removes).toBe(1);
    expect(f.manager().result(f.w.id).workspaceState).toBe('retired');expect(git(f.repo,'rev-parse',result.retainedRef!)).toBe(f.w.baseCommit);
});

it('never treats an already missing historical path as a successful removal',async()=>{
    const f=await fixture();await f.complete();const moved=join(f.root,'missing-original');renameSync(f.w.cwd,moved);
    const plan=await f.manager().plan(f.w.id);expect(plan.eligible).toBe(false);await expect(f.manager().apply(plan,'retire')).rejects.toThrow('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');
    expect(readFileSync(join(moved,'base.txt'),'utf8')).toBe('base\n');expect(f.manager().result(f.w.id).workspaceState).toBe('active');
});

it('rechecks expiry after the final slow activity probe before touching Git',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');let probes=0;
    const m=new WorkspaceLifecycle(f.queue,f.policy,async()=>{if(++probes===3)f.advance(60001);return {confirmed:true,blockers:[],fingerprint:'clear'};},()=>1000+(probes>=3?60001:0));
    const result=await m.apply(await m.plan(f.w.id),'retire');expect(result.state).toBe('failed');expect(result.reason).toBe('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');expect(existsSync(f.w.cwd)).toBe(true);
});

it('keeps a recovery fence when Git partially removes files before failing',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');
    const effect:typeof workspaceGit=async(cwd,args,fd)=>{if(args[0]==='worktree'&&args[1]==='remove'){rmSync(join(f.w.cwd,'base.txt'));throw Error('fixture partial I/O');}return workspaceGit(cwd,args,fd);};
    const m=f.manager({},effect),result=await m.apply(await m.plan(f.w.id),'retire');expect(result.state).toBe('applying');expect(result.reason).toBe('WORKSPACE_RECOVERY_UNCONFIRMED');
    expect(f.queue.workspaces('grant')[0].retirement?.phase).toBe('retiring');expect(()=>verifyWorkspace(f.queue.workspaces('grant')[0])).toThrow('WORKSPACE_RETIRING');
    expect(git(f.repo,'show',`${result.retainedRef}:base.txt`)).toBe('base');expect(existsSync(f.w.cwd)).toBe(true);
});

it('finishes a matching failed-receipt fence cleanup after an interrupted metadata transaction',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');
    const effect:typeof workspaceGit=async(cwd,args,fd)=>{if(args[0]==='worktree'&&args[1]==='remove')throw Error('fixture refusal');return workspaceGit(cwd,args,fd);};
    const m=f.manager({},effect),plan=await m.plan(f.w.id),failed=await m.apply(plan,'retire');expect(failed.state).toBe('failed');
    // Valid durable state at the crash point: receipt written, queue fence not yet cleared.
    f.queue.transaction(s=>{s.workspaces[0].retirement={operationID:'retire',phase:'retiring',retainedRef:failed.retainedRef!,retainedCommit:failed.head!};});
    expect((await f.manager().apply(plan,'retire')).state).toBe('failed');expect(f.queue.workspaces('grant')[0].retirement).toBeUndefined();expect(existsSync(f.w.cwd)).toBe(true);
});

it('fails closed on missing authoritative session mapping even when no process has the workspace as cwd',async()=>{
    const f=await fixture();await f.complete();
    const activity=await linuxWorkspaceActivity(f.queue.workspaces('grant')[0],f.queue.tasks(),f.queue.directory,'machine');expect(activity.confirmed).toBe(false);expect(activity.blockers).toContain('session_mapping_unconfirmed');
    expect((await new WorkspaceLifecycle(f.queue,f.policy).plan(f.w.id)).eligible).toBe(false);
});

it('does not grant apply from policy defaults or a modified plan',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');const disabled=f.manager({allowApply:undefined});
    expect((await disabled.plan(f.w.id)).reasons).toContain('policy_apply_disabled');
    const plan=await f.manager().plan(f.w.id);await expect(f.manager().apply({...plan,revision:99},'retire')).rejects.toThrow('WORKSPACE_PLAN_INVALID');
    expect(existsSync(f.w.cwd)).toBe(true);
});

it('preserves temporary delivery artifacts and cannot release them based on a clean checkout',async()=>{
    const f=await fixture();await f.complete();writeFileSync(join(f.w.temporaryDirectory,'report.json'),'private fixture delivery');
    expect((await f.manager().plan(f.w.id)).reasons).toContain('WORKSPACE_TEMPORARY_ARTIFACTS');
    expect(readFileSync(join(f.w.temporaryDirectory,'report.json'),'utf8')).toBe('private fixture delivery');
});

it('detects an idle mapped session after it moves cwd and holds no workspace descriptor',async()=>{
    const f=await fixture();await f.complete();
    const child=spawn(process.execPath,['-e',"process.stdin.once('data',d=>{process.chdir(d.toString().trim());process.stdout.write('moved\\n')});process.stdout.write('ready\\n');setInterval(()=>{},1000)"],{cwd:f.w.cwd,detached:true,stdio:['pipe','pipe','pipe']});
    let output='';const wait=(word:string)=>new Promise<void>((resolve,reject)=>{const poll=()=>{if(output.includes(word)){clearInterval(timer);resolve();}};const timer=setInterval(poll,5);child.once('error',reject);});
    child.stdout.on('data',b=>{output+=b.toString();});
    try {
        await wait('ready');expect(readLinuxProcess(child.pid!)!.cwd).toBe(f.w.cwd);
        const proofs=new SessionProcessProofs(join(f.queue.directory,'session-process-proofs'),'machine');
        expect(proofs.recordRunning({id:'session',metadata:{machineId:'machine',hostPid:child.pid,path:f.w.cwd}},'running')).toBe(true);
        child.stdin.write(f.root+'\n');await wait('moved');expect(readLinuxProcess(child.pid!)!.cwd).toBe(f.root);
        const activity=await linuxWorkspaceActivity(f.queue.workspaces('grant')[0],f.queue.tasks(),f.queue.directory,'machine');
        expect(activity.blockers).toContain('live_session_or_process');expect(existsSync(f.w.cwd)).toBe(true);
    } finally {const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));process.kill(-child.pid!,'SIGTERM');await stopped;}
},15000);

it('provides scoped, read-only official inventory/plan and explicit resolve/apply without host startup',async()=>{
    const f=await fixture();await f.complete();const home=join(f.root,'home'),directory=join(home,'.local/state/happy-control/machines',hash('machine'));
    mkdirSync(join(home,'.local/state/happy-control/machines'),{recursive:true,mode:0o700});
    // The CLI only accepts its derived machine directory; move this fixture queue and registry normally.
    // Use a second fresh fixture registration in that directory instead of importing a manual worktree.
    const queue=new TaskQueue(directory,{}, {machineID:'machine'}),w=await prepareWorkspace(queue,{requestID:'cli-create',grantID:'grant',projectID:'project',root:f.repo,execution:{mode:'worktree'}});
    queue.transaction(s=>{s.workspaces[0].sessionID='cli-session';});
    const task=queue.enqueue({requestID:'cli-send',grantID:'grant',workerID:'worker',sessionID:'cli-session',workspaceID:w.id,authorization:'',text:'fixture',resources:[]});
    queue.update(task.id,t=>{t.state='completed';t.dispatched=true;t.resultCommit=w.baseCommit;});
    const policyPath=join(f.root,'policy.json'),configPath=join(f.root,'worker.json'),planPath=join(f.root,'plan.json');
    writeFileSync(policyPath,JSON.stringify(f.policy),{mode:0o600});
    writeFileSync(configPath,JSON.stringify({version:1,role:'worker',endpoint:'https://fixture.invalid/happy-control/v1',relayURL:'https://fixture.invalid',happyHomeDirectory:home,identityRef:'identity',
        registration:{id:'worker',userID:'user',name:'fixture',publicKey:'-----BEGIN PUBLIC KEY-----fixture',machineID:'machine',projects:[{id:'project',directory:f.repo,sessionIDs:[]}],methods:['sessions.status'],protocol:1},
        secrets:{type:'encrypted-pkcs8-credentials',credentialsDirectory:join(f.root,'absent-secret-directory'),keys:{}}}),{mode:0o600});
    const run=(action:string,...args:string[])=>workspaceCommand([action,'--worker-config',configPath,'--policy',policyPath,...args],{homeDirectory:home,activity:async()=>({confirmed:true,blockers:[],fingerprint:'fixture-clear'})});
    const queueFile=join(directory,hash('queue')+'.json'),before=readFileSync(queueFile),mtime=statSync(queueFile).mtimeMs;
    expect((await run('inventory') as any).items).toHaveLength(1);expect((await run('plan','--id',w.id) as any).eligible).toBe(false);
    expect(readFileSync(queueFile)).toEqual(before);expect(statSync(queueFile).mtimeMs).toBe(mtime);expect(existsSync(join(directory,'workspace-lifecycle'))).toBe(false);
    await run('resolve','--id',w.id,'--operation-id','resolve','--revision','0','--head',w.baseCommit!,'--kind','no-change','--source','fixture:cli');
    let stdout='';const write=vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{stdout+=String(chunk);return true;});
    try{await workspaceMain(['plan','--worker-config',configPath,'--policy',policyPath,'--id',w.id],{homeDirectory:home,activity:async()=>({confirmed:true,blockers:[],fingerprint:'fixture-clear'})});}finally{write.mockRestore();}
    expect(JSON.parse(stdout).ok).toBe(true);expect(JSON.parse(stdout).result.eligible).toBe(true);
    writeFileSync(planPath,stdout,{mode:0o600});
    expect((await run('apply','--plan-file',planPath,'--operation-id','retire') as any).state).toBe('removed');
    expect((await run('result','--id',w.id) as any).workspaceState).toBe('retired');expect(existsSync(w.cwd)).toBe(false);
    expect(existsSync(f.w.cwd)).toBe(true);expect(existsSync(join(f.root,'absent-secret-directory'))).toBe(false);
    await expect(run('inventory','--force','true')).rejects.toThrow('WORKSPACE_COMMAND_INVALID');
});

it('checks a new queue claim atomically when taking the retirement fence',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');let probes=0,removes=0;
    const m=new WorkspaceLifecycle(f.queue,f.policy,async()=>{if(++probes===2)f.queue.enqueue({requestID:'racing',grantID:'grant',workerID:'worker',sessionID:'session',authorization:'',text:'fixture racing',resources:[]});return {confirmed:true,blockers:[],fingerprint:'clear'};},()=>1000,
        async(cwd,args,fd)=>{if(args[0]==='worktree'&&args[1]==='remove')removes++;return workspaceGit(cwd,args,fd);});
    const result=await m.apply(await m.plan(f.w.id),'retire');expect(result.state).toBe('failed');expect(result.reason).toBe('WORKSPACE_IN_USE');
    expect(removes).toBe(0);expect(existsSync(f.w.cwd)).toBe(true);expect(f.queue.tasks().find(t=>t.requestID==='racing')!.state).toBe('queued');
});

it('blocks unknown global recovery leases even when they have no workspace or session identity',async()=>{
    const f=await fixture();await f.complete();
    f.queue.enqueue({requestID:'unknown',grantID:'other',workerID:'other',sessionID:'other',authorization:'',text:'fixture',resources:[{key:'machine',mode:'exclusive'}]});
    expect((await f.manager().plan(f.w.id)).reasons).toContain('queued_running_or_recovery_reference');expect(existsSync(f.w.cwd)).toBe(true);
});

it('checks required remote main freshly and keeps an offline or unpushed result unresolved',async()=>{
    const f=await fixture();await f.complete();f.save();f.integrate();
    const remote=join(f.root,'remote.git');git(f.repo,'init','--bare','-q',remote);git(f.repo,'remote','add','personal',remote);git(f.repo,'push','-q','personal',f.w.baseCommit!+':refs/heads/main');
    const m=f.manager({remote:'personal'});await expect(f.resolve(m)).rejects.toThrow('WORKSPACE_MAIN_REMOTE_DIVERGED');
    git(f.repo,'push','-q','personal','main');await f.resolve(m);expect((await m.plan(f.w.id)).eligible).toBe(true);
    git(f.repo,'remote','set-url','personal',join(f.root,'unavailable.git'));expect((await m.plan(f.w.id)).reasons).toContain('WORKSPACE_REMOTE_UNCONFIRMED');
    expect(existsSync(f.w.cwd)).toBe(true);
});

it('retains manual gitdir evidence and dropped commits that survive only in this worktree HEAD reflog',async()=>{
    const f=await fixture();await f.complete();const gitdir=git(f.w.cwd,'rev-parse','--absolute-git-dir');
    writeFileSync(join(gitdir,'human-report.txt'),'fixture delivery');expect((await f.manager().plan(f.w.id)).reasons).toContain('WORKSPACE_GITDIR_ARTIFACTS');
    expect(readFileSync(join(gitdir,'human-report.txt'),'utf8')).toBe('fixture delivery');rmSync(join(gitdir,'human-report.txt'));
    f.save();const dropped=git(f.w.cwd,'rev-parse','HEAD');git(f.w.cwd,'reset','--hard',f.w.baseCommit!); // Destructive manipulation is only inside this synthetic repository.
    f.queue.update(f.task.id,t=>{t.resultCommit=f.w.baseCommit;});
    expect((await f.manager().plan(f.w.id)).reasons).toContain('WORKSPACE_REFLOG_ONLY_RESULTS');
    expect(git(f.repo,'show',dropped+':feature.txt')).toBe('feature');expect(existsSync(f.w.cwd)).toBe(true);
});

it('never resets corrupt/null queue or lifecycle records into an empty history',async()=>{
    const f=await fixture();await f.complete();
    const records=new MetadataStore(join(f.queue.directory,'workspace-lifecycle'));records.set('workspace:'+f.w.id,null);
    await expect(f.manager().plan(f.w.id)).rejects.toThrow();expect(records.get('workspace:'+f.w.id)).toBeNull();expect(existsSync(f.w.cwd)).toBe(true);
    const queueStore=new MetadataStore(f.queue.directory,64*1024*1024);queueStore.set('queue',null);
    const file=join(f.queue.directory,hash('queue')+'.json'),before=readFileSync(file);
    expect(()=>new TaskQueue(f.queue.directory,{}, {machineID:'machine'})).toThrow('QUEUE_CORRUPT');expect(readFileSync(file)).toEqual(before);
});

it('does not initialize a lost queue over an existing key or managed directories',async()=>{
    const f=await fixture(),file=join(f.queue.directory,hash('queue')+'.json');rmSync(file);
    expect(()=>new TaskQueue(f.queue.directory,{}, {machineID:'machine'})).toThrow('QUEUE_RECOVERY_REQUIRED');
    expect(existsSync(file)).toBe(false);expect(readFileSync(join(f.w.cwd,'base.txt'),'utf8')).toBe('base\n');
});

it('retains ORIG_HEAD-only delivery when HEAD reflog recording is disabled',async()=>{
    const f=await fixture();await f.complete();git(f.repo,'config','core.logAllRefUpdates','false');
    rmSync(join(git(f.w.cwd,'rev-parse','--absolute-git-dir'),'logs/HEAD'));f.save();const original=git(f.w.cwd,'rev-parse','HEAD');
    git(f.w.cwd,'reset','--hard',f.w.baseCommit!);f.queue.update(f.task.id,t=>{t.resultCommit=f.w.baseCommit;});
    rmSync(join(git(f.w.cwd,'rev-parse','--absolute-git-dir'),'logs/HEAD'),{force:true});
    rmSync(join(f.repo,'.git/logs/refs/heads',f.w.branch!),{force:true});
    expect(git(f.w.cwd,'rev-parse','ORIG_HEAD')).toBe(original);expect((await f.manager().plan(f.w.id)).reasons).toContain('WORKSPACE_GITDIR_ONLY_RESULTS');
    expect(git(f.repo,'show',original+':feature.txt')).toBe('feature');expect(existsSync(f.w.cwd)).toBe(true);
});

it('rejects an authenticated sealed null payload without replacing it with an empty queue',async()=>{
    const f=await fixture(),key=readFileSync(join(f.queue.directory,'.payload-key')),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const ciphertext=Buffer.concat([cipher.update('null'),cipher.final()]);key.fill(0);
    new MetadataStore(f.queue.directory,64*1024*1024).set('queue',{sealed:Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64')});
    const file=join(f.queue.directory,hash('queue')+'.json'),before=readFileSync(file);
    expect(()=>new TaskQueue(f.queue.directory,{}, {machineID:'machine'})).toThrow('QUEUE_CORRUPT');expect(readFileSync(file)).toEqual(before);expect(existsSync(f.w.cwd)).toBe(true);
});

it('protects the current execution directory and revision/policy changes after a plan',async()=>{
    const f=await fixture();await f.complete();await f.resolve(f.manager(),'no-change');
    const cwd=vi.spyOn(process,'cwd').mockReturnValue(f.w.cwd);
    try{expect((await f.manager().plan(f.w.id)).reasons).toContain('WORKSPACE_PROTECTED_DIRECTORY');}finally{cwd.mockRestore();}
    const m=f.manager(),plan=await m.plan(f.w.id);
    await m.resolve(f.w.id,{operationID:'review-again',expectedRevision:1,head:f.w.baseCommit!,kind:'no-change',source:'fixture:new-review'});
    await expect(m.apply(plan,'retire')).rejects.toThrow('WORKSPACE_PLAN_CHANGED');
    await expect(f.manager({allowArchive:true}).apply(plan,'retire')).rejects.toThrow('WORKSPACE_PLAN_INVALID');
    expect(existsSync(f.w.cwd)).toBe(true);expect(git(f.repo,'rev-parse','main')).toBe(f.w.baseCommit);
});

it('never adopts or removes an independent clone replacing a historical registry path',async()=>{
    const f=await fixture();await f.complete();git(f.repo,'worktree','remove',f.w.cwd);git(f.repo,'clone','--no-hardlinks','-q',f.repo,f.w.cwd);
    await expect(f.manager().adopt(f.w.id,'adopt',0,f.w.baseCommit!)).rejects.toThrow('WORKSPACE_PATH_CHANGED');
    expect((await f.manager().plan(f.w.id)).eligible).toBe(false);expect(readFileSync(join(f.w.cwd,'base.txt'),'utf8')).toBe('base\n');
});


it('archives an explicitly accepted integrated result and safely repeats owner finalization',async()=>{
    const f=await fixture(true);await f.complete();f.save();f.integrate();
    const archive=join(f.root,'owner-archive');mkdirSync(archive,{mode:0o700});
    const m=f.manager({automaticRetirementArchive:archive}),head=git(f.w.cwd,'rev-parse','HEAD');
    const evidence='Isolated build and task behavior accepted';
    const finalize=()=>m.finalizeIntegrated(f.w.id,'owner-finalize',head,evidence,'owner');
    const first=await finalize();expect(first.state).toBe('removed');expect(await finalize()).toEqual(first);
    expect(existsSync(f.w.cwd)).toBe(false);
    const retained=new MetadataStore(archive).get<any>(`finalize:${f.w.id}:owner-finalize`);
    expect(retained.evidence).toMatchObject({acceptance:{evidence,acceptedBy:'owner'},tasks:[{id:f.task.id,resultCommit:head}]});
    expect(git(f.repo,'show',`${m.result(f.w.id).disposition!.retainedRef}:feature.txt`)).toBe('feature');
});

it('retains an opted-in workspace for dirty content, live sessions and unmerged commits',async()=>{
    const f=await fixture(true);await f.complete();f.save();
    const archive=join(f.root,'owner-archive');mkdirSync(archive,{mode:0o700});
    const m=f.manager({automaticRetirementArchive:archive}),head=git(f.w.cwd,'rev-parse','HEAD');
    const finalize=()=>m.finalizeIntegrated(f.w.id,'owner-finalize',head,'Business fixture accepted','owner');
    expect((await finalize()).reason).toBe('WORKSPACE_NOT_IN_MAIN');
    f.integrate();writeFileSync(join(f.w.cwd,'private-note'),'protected');
    f.activity({confirmed:true,blockers:['live_session_or_process'],fingerprint:'live'});
    const result=await finalize();expect(result.state).toBe('failed');
    expect(result.reason).toContain('ignored_artifacts');expect(result.reason).toContain('live_session_or_process');
    expect(readFileSync(join(f.w.cwd,'private-note'),'utf8')).toBe('protected');
});

it('leaves pre-existing managed workspaces out of owner finalization',async()=>{
    const f=await fixture();await f.complete();
    const archive=join(f.root,'owner-archive');mkdirSync(archive,{mode:0o700});
    await expect(f.manager({automaticRetirementArchive:archive}).finalizeIntegrated(f.w.id,'finalize',f.w.baseCommit!,'acceptance','owner'))
        .rejects.toThrow('WORKSPACE_AUTOMATIC_RETIREMENT_DISABLED');
    expect(existsSync(f.w.cwd)).toBe(true);
});

async function deliveryFixture(command=['/bin/sh','-c','test "$(cat feature.txt)" = feature']) {
    const f=await fixture(true);
    await f.complete();f.save();
    const remote=join(f.root,'remote.git'),archive=join(f.root,'archive');
    mkdirSync(archive,{mode:0o700});
    git(f.repo,'init','--bare',remote);git(f.repo,'remote','add','origin',remote);git(f.repo,'push','origin','main');
    const overrides:Partial<WorkspacePolicy>={remote:'origin',automaticRetirementArchive:archive,
        delivery:{strategy:'direct',remoteURL:remote,test:command}};
    const head=git(f.w.cwd,'rev-parse','HEAD');
    const scope={machineID:'machine',projectID:'project',workspaceID:f.w.id,operationID:'delivery'};
    const begin={action:'start-delivery' as const,...scope,head,requestID:'send',evidence:'isolated business acceptance'};
    const resume={action:'resume-delivery' as const,...scope};
    return {...f,archive,remote,overrides,head,begin,resume,
        remoteHead:()=>git(remote,'rev-parse','refs/heads/main')};
}

it.each(['no-change','fast-forward','squash'] as const)('automatically reclaims %s using the real remote and keeps the original receipt',async kind=>{
    const f=await fixture(), remote=join(f.root,'remote.git'), archive=join(f.root,'archive');
    git(f.repo,'init','--bare',remote);git(f.repo,'remote','add','origin',remote);git(f.repo,'push','origin','main');
    await f.complete();
    if (kind !== 'no-change') {
        f.save();
        const head=git(f.w.cwd,'rev-parse','HEAD');
        if (kind === 'fast-forward') git(f.repo,'push','origin',head+':refs/heads/main');
        else {
            const peer=join(f.root,'peer');git(f.root,'clone','--branch','main',remote,peer);git(peer,'config','user.name','fixture');
            git(peer,'config','user.email','fixture@invalid');
            writeFileSync(join(peer,'feature.txt'),'feature\n');git(peer,'add','feature.txt');
            git(peer,'commit','-qm','squash summary');git(peer,'push','origin','main');
            const target=git(peer,'rev-parse','HEAD');
            expect(()=>git(f.repo,'cat-file','-e',target+'^{commit}')).toThrow();
        }
    }
    const main=git(f.repo,'rev-parse','main'), m=f.manager({remote:'origin',reclaimRemoteURL:remote});
    await Promise.all([m.reclaimDue(archive),f.manager({remote:'origin',reclaimRemoteURL:remote}).reclaimDue(archive)]);
    const result=m.result(f.w.id,undefined,true);
    expect(result.operation).toMatchObject({state:'removed',removal:'git-confirmed'});
    expect(result.disposition?.proof).toBe(kind==='squash'?'exact-content':'ancestor');
    expect(existsSync(f.w.cwd)).toBe(false);
    expect(git(f.repo,'worktree','list','--porcelain')).not.toContain(f.w.cwd);
    expect(git(f.repo,'rev-parse','main')).toBe(main);
    expect(git(f.repo,'cat-file','-t',result.disposition!.retainedRef)).toBe('commit');
    expect(f.queue.receipt(f.task).execution).toMatchObject({reclaimState:'released',workspaceState:'retired',
        reclaimOperationID:result.operation!.id});
    await f.manager({remote:'origin',reclaimRemoteURL:remote}).reclaimDue(archive);
    expect(m.result(f.w.id,undefined,true).operations).toEqual(result.operations);
});

it('waits for remote, occupied sessions and unknown artifacts, then resumes the same workspace operation',async()=>{
    const f=await fixture(), remote=join(f.root,'remote.git'), archive=join(f.root,'archive');
    git(f.repo,'remote','add','origin',remote);
    await f.complete();
    const m=f.manager({remote:'origin',reclaimRemoteURL:remote}), status=()=>reclaimRecord(f.queue.directory,f.w)?.status;
    await m.reclaimDue(archive);expect(status()).toMatchObject({state:'waiting',reason:'WORKSPACE_REMOTE_UNCONFIRMED'});
    const id=status()?.operationID;
    git(f.repo,'init','--bare',remote);git(f.repo,'push','origin','main');
    f.activity({confirmed:true,blockers:['live_session_or_process'],fingerprint:'busy'});
    f.advance(120_000);await m.reclaimDue(archive);
    expect(status()).toMatchObject({state:'waiting',reason:'live_session_or_process',operationID:id});
    const report=join(f.w.temporaryDirectory,'report.json');writeFileSync(report,'retain');
    f.activity({confirmed:true,blockers:[],fingerprint:'stopped'});
    f.advance(120_000);await m.reclaimDue(archive);
    expect(status()).toMatchObject({state:'attention',reason:'WORKSPACE_TEMPORARY_ARTIFACTS',operationID:id});
    expect(readFileSync(report,'utf8')).toBe('retain');rmSync(report);
    f.advance(120_000);await f.manager({remote:'origin',reclaimRemoteURL:remote}).reclaimDue(archive);
    expect(status()).toMatchObject({state:'released',operationID:id});expect(existsSync(f.w.cwd)).toBe(false);
});

it.each(['lost-ack','refused'] as const)('reconciles an interrupted automatic removal before another Git write (%s)',async scenario=>{
    const f=await fixture(), remote=join(f.root,'remote.git'), archive=join(f.root,'archive');
    git(f.repo,'init','--bare',remote);git(f.repo,'remote','add','origin',remote);git(f.repo,'push','origin','main');
    await f.complete();
    let calls=0;
    const interrupted:typeof workspaceGit=async(cwd,args,fd,timeout)=>{
        if (args[0]==='worktree' && args[1]==='remove' && ++calls===1) {
            if (scenario==='lost-ack') await workspaceGit(cwd,args,fd,timeout);
            throw Error('interrupted Git effect');
        }
        return workspaceGit(cwd,args,fd,timeout);
    };
    const m=f.manager({remote:'origin',reclaimRemoteURL:remote},interrupted);
    await m.reclaimDue(archive);
    const prior=reclaimRecord(f.queue.directory,f.w)!.status;
    expect(prior.state).not.toBe('released');
    expect(existsSync(f.w.cwd)).toBe(scenario==='refused');
    f.advance(120_000);
    const afterRestart=f.manager({remote:'origin',reclaimRemoteURL:remote},interrupted);
    await afterRestart.reclaimDue(archive);
    const final=afterRestart.result(f.w.id);
    expect(final.operation).toMatchObject({state:'removed',removal:scenario==='lost-ack'?'absence-after-intent':'git-confirmed'});
    expect(calls).toBe(scenario==='lost-ack'?1:2);
    if (scenario==='lost-ack') expect(final.operation?.id).toBe(prior.operationID);
    expect(git(f.repo,'worktree','list','--porcelain')).not.toContain(f.w.cwd);
    expect(git(f.repo,'cat-file','-t',final.disposition!.retainedRef)).toBe('commit');
    expect(f.queue.receipt(f.task).execution).toMatchObject({workspaceState:'retired',reclaimState:'released'});
});

it('keeps pre-existing, shared and newly changed worktrees out of automatic removal',async()=>{
    const f=await fixture(), remote=join(f.root,'remote.git'), archive=join(f.root,'archive');
    git(f.repo,'init','--bare',remote);git(f.repo,'remote','add','origin',remote);git(f.repo,'push','origin','main');
    await f.complete();
    const record=reclaimRecord(f.queue.directory,f.w)!, store=reclaimRecords(f.queue.directory)!;
    store.delete(f.w.id);
    const manager=f.manager({remote:'origin',reclaimRemoteURL:remote});
    await manager.reclaimDue(archive);expect(existsSync(f.w.cwd)).toBe(true);
    store.set(f.w.id,record);
    writeFileSync(join(f.w.cwd,'extra.txt'),'new');
    git(f.w.cwd,'add','extra.txt');git(f.w.cwd,'commit','-qm','additional change');
    await manager.reclaimDue(archive);
    expect(reclaimRecord(f.queue.directory,f.w)?.status).toMatchObject({state:'attention',reason:'WORKSPACE_HEAD_CHANGED'});
    expect(readFileSync(join(f.w.cwd,'extra.txt'),'utf8')).toBe('new');
    const other=f.manager({grantID:'someone-else',remote:'origin',reclaimRemoteURL:remote});f.advance(120_000);
    await other.reclaimDue(archive);expect(existsSync(f.w.cwd)).toBe(true);
});

it('rejects an unpinned remote and serializes direct Happy startup with removal',async()=>{
    const f=await fixture(), remote=join(f.root,'remote.git'), other=join(f.root,'wrong.git'), archive=join(f.root,'archive');
    git(f.repo,'init','--bare',remote);git(f.repo,'init','--bare',other);git(f.repo,'remote','add','origin',other);
    git(f.repo,'push','origin','main');await f.complete();
    const m=f.manager({remote:'origin',reclaimRemoteURL:remote});
    await m.reclaimDue(archive);
    expect(reclaimRecord(f.queue.directory,f.w)?.status).toMatchObject({state:'waiting',reason:'WORKSPACE_REMOTE_UNCONFIRMED'});
    expect(existsSync(f.w.cwd)).toBe(true);
    git(f.repo,'remote','set-url','origin',remote);git(f.repo,'push','origin','main');
    f.advance(120_000);
    await m.reclaimDue(archive);
    expect(m.result(f.w.id).operation?.state).toBe('removed');

    const machines=join(f.root,'machines');
    const machineDirectory=join(machines,hash('other-machine'));
    const queue=new TaskQueue(machineDirectory,{}, {machineID:'other-machine'});
    const w=await prepareWorkspace(queue,{requestID:'create-other',grantID:'grant',projectID:'project',root:f.repo,execution:{mode:'worktree'}});
    const launch=vi.fn(async()=>true);
    expect(await withManagedWorkspaceLaunch(w.cwd,launch,machines)).toBe(true);
    queue.transaction(state=>{state.workspaces[0].retirement={phase:'retiring',operationID:'op',retainedRef:'refs/keep',retainedCommit:w.baseCommit!};});
    await expect(withManagedWorkspaceLaunch(w.cwd,launch,machines)).rejects.toThrow('WORKSPACE_RETIRING');
    expect(launch).toHaveBeenCalledTimes(1);
});

it('reads back both remote pushes after lost replies and retires through the same archived Owner operation',async()=>{
    const f=await deliveryFixture();
    const calls:string[]=[];
    const interrupted:typeof workspaceGit=async(cwd,args,fd,timeout)=>{
        const result=await workspaceGit(cwd,args,fd,timeout);
        if(args[0]==='push'){calls.push(args.at(-1)!);throw Error('reply lost after remote update');}
        return result;
    };
    const first=await f.manager(f.overrides,interrupted).deliver(f.begin,'owner');
    expect(first).toMatchObject({phase:'push-intent',testExitCode:0,blocker:'WORKSPACE_DELIVERY_UNCONFIRMED'});
    expect(f.remoteHead()).toBe(f.w.baseCommit);
    expect(await f.manager(f.overrides,interrupted).deliver(f.resume,'owner')).toMatchObject({phase:'merge-intent',pushedAt:expect.any(Number)});
    expect(f.remoteHead()).toBe(f.head);
    expect(existsSync(f.w.cwd)).toBe(true);
    await expect(f.manager(f.overrides).deliver(f.resume,'another-owner')).rejects.toThrow('WORKSPACE_DELIVERY_AUTHORIZATION_CHANGED');
    const owner=f.manager(f.overrides);
    expect(await owner.deliver(f.resume,'owner')).toMatchObject({phase:'released',head:f.head,mergedTarget:f.head,testExitCode:0});
    expect(calls).toEqual([`${f.head}:refs/heads/${f.w.branch}`,`${f.head}:refs/heads/main`]);
    expect(git(f.repo,'rev-parse','main')).toBe(f.w.baseCommit);
    expect(existsSync(f.w.cwd)).toBe(false);
    expect(await owner.deliver(f.resume,'owner')).toMatchObject({phase:'released'});
    const record=new MetadataStore(f.archive).get<{evidence:unknown}>(`finalize:${f.w.id}:delivery`);
    expect(record?.evidence).toMatchObject({acceptance:{evidence:'isolated business acceptance'}});
});

it('keeps unsaved files and a failed exact candidate test from reaching the remote',async()=>{
    const f=await deliveryFixture(['/bin/false']);
    writeFileSync(join(f.w.cwd,'keep.txt'),'retain\n');
    const owner=f.manager(f.overrides);
    expect(await owner.deliver(f.begin,'owner')).toMatchObject({phase:'authorized',blocker:'WORKSPACE_UNSAVED_ARTIFACTS'});
    expect(readFileSync(join(f.w.cwd,'keep.txt'),'utf8')).toBe('retain\n');
    rmSync(join(f.w.cwd,'keep.txt'));
    expect(await owner.deliver(f.resume,'owner')).toMatchObject({phase:'tested',testExitCode:1,blocker:'WORKSPACE_DELIVERY_TEST_FAILED'});
    expect(f.remoteHead()).toBe(f.w.baseCommit);
    expect(()=>git(f.remote,'rev-parse','--verify',f.w.branch!)).toThrow();
});

it('keeps a pushed candidate and stops if the remote target advances concurrently',async()=>{
    const f=await deliveryFixture();
    const other=join(f.root,'other');
    git(f.root,'clone','--branch','main',f.remote,other);git(other,'config','user.name','other');git(other,'config','user.email','other@invalid');
    writeFileSync(join(other,'unrelated.txt'),'concurrent\n');git(other,'add','unrelated.txt');git(other,'commit','-qm','unrelated');
    let advanced=false;
    const advance:typeof workspaceGit=async(cwd,args,fd,timeout)=>{
        const result=await workspaceGit(cwd,args,fd,timeout);
        if(!advanced&&args[0]==='push'){advanced=true;git(other,'push','origin','HEAD:refs/heads/main');}
        return result;
    };
    expect(await f.manager(f.overrides,advance).deliver(f.begin,'owner')).toMatchObject({phase:'pushed',head:f.head,blocker:'WORKSPACE_DELIVERY_TARGET_ADVANCED'});
    expect(f.remoteHead()).toBe(git(other,'rev-parse','HEAD'));
    expect(git(f.remote,'rev-parse',f.w.branch!)).toBe(f.head);
    expect(existsSync(f.w.cwd)).toBe(true);
    expect(await f.manager(f.overrides).deliver(f.resume,'owner')).toMatchObject({phase:'pushed',blocker:'WORKSPACE_DELIVERY_TARGET_ADVANCED'});
    const target=f.remoteHead();
    git(f.w.cwd,'merge','--no-edit',target);
    const next=git(f.w.cwd,'rev-parse','HEAD');
    f.queue.update(f.task.id,t=>{t.resultCommit=next;});
    const owner=f.manager(f.overrides);
    expect((await owner.deliveryInventory(5)).items[0].delivery?.canStart).toBe(true);
    expect(await owner.deliver({...f.begin,operationID:'retargeted',head:next},'owner')).toMatchObject({phase:'released',head:next,testedOn:target});
    expect(await owner.deliver(f.resume,'owner')).toMatchObject({head:f.head,blocker:'WORKSPACE_DELIVERY_SUPERSEDED'});
    expect(f.remoteHead()).toBe(next);
});

it.each(['squash','cherry-pick'])('reports exact %s content in the configured remote and unknown during an outage',async method=>{
    const f=await deliveryFixture();
    writeFileSync(join(f.w.cwd,'second.txt'),'second\n');
    git(f.w.cwd,'add','second.txt');git(f.w.cwd,'commit','-qm','second feature');
    if(method==='squash') {
        git(f.repo,'merge','--squash',f.w.branch!);
        git(f.repo,'commit','-qm','combined feature');
    } else {
        writeFileSync(join(f.repo,'unrelated.txt'),'independent remote improvement\n');
        git(f.repo,'add','unrelated.txt');git(f.repo,'commit','-qm','unrelated');
        git(f.repo,'cherry-pick',f.head,git(f.w.cwd,'rev-parse','HEAD'));
    }
    git(f.repo,'push','origin','main');
    expect(git(f.repo,'rev-parse','main')).not.toBe(git(f.w.cwd,'rev-parse','HEAD'));
    let view=await f.manager(f.overrides).deliveryInventory(5);
    expect(view.items[0].delivery).toMatchObject({state:'merged',proof:'exact-content',remoteHead:f.remoteHead()});
    renameSync(f.remote,f.remote+'-offline');
    view=await f.manager(f.overrides).deliveryInventory(5);
    expect(view.items[0].delivery).toMatchObject({state:'unknown',registration:'registered',directory:'present'});
    expect(existsSync(f.w.cwd)).toBe(true);
});
