import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceOwnerFixture, fixtureGit } from '../rest/fixtures/workspaceOwnerFixture';
import { ApiError } from '../rest/schema';
import { workspaceOwnerScope, workspaceOwnerControlProjects } from './workspaceOwner';
import { openWorkspaceLifecycle } from './workspaces';
import { directoryProjectID } from '../rest/schema';
const fixtures:Awaited<ReturnType<typeof workspaceOwnerFixture>>[]=[];
const fixture=async()=>{const f=await workspaceOwnerFixture();fixtures.push(f);return f;};
afterEach(async()=>{vi.unstubAllGlobals();for(const f of fixtures.splice(0)){await f.app.close();rmSync(f.root,{recursive:true,force:true});}});

it('uses account-owner auth and exact project scope; rejects model/service credentials and unknown request fields',async()=>{
    const f=await fixture();
    expect((await f.api('/catalog',{}, {authorization:'Bearer other-owner'})).status).toBe(403);
    expect((await f.api('/catalog',{}, {authorization:'HappyService fixture'})).status).toBe(401);
    expect((await f.api('/catalog',{}, {authorization:'Bearer hsvc1.fixture.invalid'})).status).toBe(401);
    expect((await f.api('/catalog',{}, {origin:'https://evil.invalid'})).status).toBe(403);
    expect((await f.api('/catalog',{})).body.data.projects.map((p:any)=>p.id)).toEqual([f.scope.projectID]);
    expect((await f.api('/read',{action:'inventory',...f.scope,projectID:'other-project'})).status).toBe(403);
    expect((await f.api('/read',{action:'inventory',...f.scope,path:'/tmp'})).status).toBe(400);
});
it('projects bounded identifiers without task text, policy secrets or duplicate Dot/task rows',async()=>{
    const f=await fixture();const a=await f.api('/read',{action:'inventory',...f.scope,limit:5});
    expect(a.body.data.total).toBe(6);expect(a.body.data.items).toHaveLength(5);expect(a.body.data.next).toBeTruthy();
    const b=await f.api('/read',{action:'inventory',...f.scope,after:a.body.data.next,limit:5});expect(b.body.data.items).toHaveLength(1);
    expect(new Set([...a.body.data.items,...b.body.data.items].map((x:any)=>x.directory)).size).toBe(6);
    expect(JSON.stringify(a.body)).not.toContain('synthetic fixture input');expect(JSON.stringify(a.body)).not.toContain('publicKey');
});
it('requires server proof for resolution; plans/explicit apply retain task query, refs and reconstruction data',async()=>{
    const f=await fixture(),w=f.workspaces.ready,main=fixtureGit(f.repo,'rev-parse','main');
    const before=await f.api('/write',f.request('ready','plan'));expect(before.body.data.plan.eligible).toBe(false);
    await f.resolve('ready');const planned=await f.api('/write',f.request('ready','plan'));const {ticket,plan}=planned.body.data;
    expect(plan.eligible).toBe(true);
    const request=f.request('ready','apply',{operationID:'remove-ready',ticket,confirmedPlanID:plan.id});
    const result=await f.api('/write',request);expect(result.body.data.receipt.state).toBe('removed');expect(existsSync(w.cwd)).toBe(false);
    expect(fixtureGit(f.repo,'rev-parse','main')).toBe(main);expect(fixtureGit(f.repo,'rev-parse',w.branch!)).toBe(main);
    expect((await f.api('/read',f.request('ready','result',{operationID:'remove-ready'}))).body.data.receipt.state).toBe('removed');
    const history=(await f.api('/read',f.request('ready','result'))).body.data;expect(history.operations).toHaveLength(2);expect(history.rebuild.command).toBe('git');
    const rebuild=history.rebuild;fixtureGit(rebuild.args[1],...rebuild.args.slice(2));expect(readFileSync(join(rebuild.args.at(-2),'base.txt'),'utf8')).toBe('synthetic code\n');
    expect((await f.api('/write',request)).body.data.receipt.state).toBe('removed');expect(existsSync(rebuild.args.at(-2))).toBe(true);
});
it('rejects forged/other-project tickets and rechecks dirty or live state after planning',async()=>{
    const f=await fixture();await f.resolve('ready');const p=(await f.api('/write',f.request('ready','plan'))).body.data;
    expect((await f.api('/write',f.request('ready','apply',{ticket:'forged',confirmedPlanID:p.plan.id,operationID:'forged'}))).status).toBe(409);
    writeFileSync(join(f.workspaces.ready.cwd,'new.txt'),'must retain');
    const result=await f.api('/write',f.request('ready','apply',{ticket:p.ticket,confirmedPlanID:p.plan.id,operationID:'dirty-change'}));
    expect(result.body.data.receipt?.state??result.body.data.error).not.toBe('removed');expect(existsSync(f.workspaces.ready.cwd)).toBe(true);
    await f.resolve('unknown-reply');const other=(await f.api('/write',f.request('unknown-reply','plan'))).body.data;
    f.blockers.set(f.workspaces['unknown-reply'].id,['live_session_or_process']);
    const blocked=await f.api('/write',f.request('unknown-reply','apply',{ticket:other.ticket,confirmedPlanID:other.plan.id,operationID:'live-change'}));
    expect(blocked.body.data.error??blocked.body.data.receipt?.state).not.toBe('removed');expect(existsSync(f.workspaces['unknown-reply'].cwd)).toBe(true);
});
it('keeps a stable operation during concurrent duplicate calls and rejects parameter changes',async()=>{
    const f=await fixture();await f.resolve('ready');const p=(await f.api('/write',f.request('ready','plan'))).body.data;
    let release!:()=>void;f.pause(()=>new Promise<void>(r=>{release=r;}));
    const request=f.request('ready','apply',{ticket:p.ticket,confirmedPlanID:p.plan.id,operationID:'duplicate'});
    const a=f.api('/write',request);await new Promise(r=>setTimeout(r,30));const b=f.api('/write',request);
    const conflict=await f.api('/write',{...request,confirmedPlanID:'a'.repeat(64)});expect(conflict.status).toBe(409);
    f.pause();release();const results=await Promise.all([a,b]);expect(results[0].body).toEqual(results[1].body);
    expect(results[0].body.data.receipt.state).toBe('removed');
});
it('does not accept fake integration, archive permission or an unknown result as completion',async()=>{
    const f=await fixture(),w=f.workspaces.ready;
    writeFileSync(join(w.cwd,'new-code.txt'),'new code');fixtureGit(w.cwd,'add','new-code.txt');fixtureGit(w.cwd,'commit','-qm','unique');
    const detail=(await f.api('/read',f.request('ready','detail'))).body.data;
    for(const kind of ['integrated','archived']) {
        const r=await f.api('/write',f.request('ready','resolve',{operationID:'deny-'+kind,revision:detail.item.revision,head:detail.inspectedHead,kind}));
        expect(r.body.data.error).toBe(kind==='integrated'?'WORKSPACE_NOT_IN_MAIN':'WORKSPACE_DISPOSITION_NOT_AUTHORIZED');
    }
    const unknown=await f.api('/read',f.request('ready','result',{operationID:'no-such-operation'}));expect(unknown.body.data.status).toBe('unknown');expect(unknown.body.data.receipt).toBeUndefined();
});
it('refuses expired plans and policy or project changes without removing a directory',async()=>{
    const f=await fixture();await f.resolve('ready');const p=(await f.api('/write',f.request('ready','plan'))).body.data;
    f.advance(70000);
    expect((await f.api('/write',f.request('ready','apply',{ticket:p.ticket,confirmedPlanID:p.plan.id,operationID:'expired'}))).status).toBe(409);
    expect(existsSync(f.workspaces.ready.cwd)).toBe(true);
    f.advance(-70000);const fresh=(await f.api('/write',f.request('ready','plan'))).body.data;
    writeFileSync(f.policyFile,JSON.stringify({...f.policy,allowApply:false}),{mode:0o600});
    const blocked=await f.api('/write',f.request('ready','apply',{ticket:fresh.ticket,confirmedPlanID:fresh.plan.id,operationID:'policy-changed'}));
    expect(blocked.body.data.receipt?.state??blocked.body.data.error).not.toBe('removed');expect(existsSync(f.workspaces.ready.cwd)).toBe(true);
    const worker=JSON.parse(readFileSync(f.workerFile,'utf8'));worker.registration.projects=[];writeFileSync(f.workerFile,JSON.stringify(worker));
    expect((await f.api('/catalog',{})).status).not.toBe(200);
});
it('does not settle an old unknown operation merely because its retry was rejected as busy',async()=>{
    const f=await fixture();await f.resolve('ready');const p=(await f.api('/write',f.request('ready','plan'))).body.data;
    const request=f.request('ready','apply',{ticket:p.ticket,confirmedPlanID:p.plan.id,operationID:'unknown-retry'});
    f.pause(async()=>{throw new ApiError('WORKSPACE_RESULT_UNKNOWN',503);});expect((await f.api('/write',request)).body.data.status).toBe('unknown');
    f.pause(async()=>{throw new ApiError('WORKSPACE_MANAGER_BUSY',429);});expect((await f.api('/write',request)).body.data.status).toBe('unknown');
    expect(existsSync(f.workspaces.ready.cwd)).toBe(true);f.pause();
});
it('marks a response withheld after completed side effects as unknown, then queries the original receipt after reauthorization',async()=>{
    const f=await fixture();await f.resolve('ready');const p=(await f.api('/write',f.request('ready','plan'))).body.data;
    f.afterJob(()=>f.control(false));
    const result=await f.api('/write',f.request('ready','apply',{ticket:p.ticket,confirmedPlanID:p.plan.id,operationID:'post-revocation'}));
    expect(result.status).toBe(403);expect(result.body.dispatch).toBe('unknown');expect(existsSync(f.workspaces.ready.cwd)).toBe(false);
    f.afterJob();f.control(true);
    expect((await f.api('/read',f.request('ready','result',{operationID:'post-revocation'}))).body.data.receipt.state).toBe('removed');
});
it('accepts genuine directory-selection scope using the same Control/Worker rule, without changing the registration or CLI permissions',async()=>{
    const f=await fixture(),projectID=directoryProjectID(f.repo);
    const worker=JSON.parse(readFileSync(f.workerFile,'utf8'));worker.registration.projects=[{id:'other',directory:join(f.root,'other'),sessionIDs:[]}];worker.registration.directorySelection={roots:[f.root]};writeFileSync(f.workerFile,JSON.stringify(worker));
    writeFileSync(f.policyFile,JSON.stringify({...f.policy,projectID}));const config=JSON.parse(readFileSync(f.configFile,'utf8'));config.projects[0].id=projectID;writeFileSync(f.configFile,JSON.stringify(config));
    expect(workspaceOwnerScope(f.configFile,'fixture-owner').projects[0].id).toBe(projectID);
    expect(()=>openWorkspaceLifecycle(f.workerFile,f.policyFile,{homeDirectory:f.home})).toThrow('WORKSPACE_SCOPE_DENIED');
    expect(openWorkspaceLifecycle(f.workerFile,f.policyFile,{homeDirectory:f.home,ownerDirectorySelection:true}).lifecycle.policy.projectID).toBe(projectID);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({version:1,ok:true,data:{workers:[{id:'fixture-worker',machineID:'fixture-machine',projects:[{id:'other',directory:join(f.root,'other')}],directorySelection:{roots:[f.root]},directoryScopes:1}]}})}));
    expect(await workspaceOwnerControlProjects(f.configFile,'Bearer fixture-owner','fixture-owner')).toEqual([projectID]);
});


it('automatically settles opted-in work through owner-authorized business acceptance and retains occupied work',async()=>{
    const f=await workspaceOwnerFixture(undefined,true);fixtures.push(f);
    const finalize=(name:string)=>f.request(name,'finalize-integrated',{
        operationID:'finalize-'+name,head:f.workspaces[name].baseCommit,evidence:'Fixture acceptance confirmed independently',
    });
    expect((await f.api('/write',finalize('ready'),{authorization:'Bearer other-owner'})).status).toBe(403);
    expect((await f.api('/read',f.request('ready','detail'))).body.data.item.canFinalizeIntegrated).toBe(true);
    const ready=await f.api('/write',finalize('ready'));
    expect(ready.body.data.receipt.state).toBe('removed');
    expect(existsSync(f.workspaces.ready.cwd)).toBe(false);
    expect((await f.api('/write',finalize('ready'))).body.data.receipt).toEqual(ready.body.data.receipt);
    expect((await f.api('/read',f.request('ready','result',{operationID:'finalize-ready'}))).body.data.receipt.state).toBe('removed');
    for(const [name,reason] of [['dirty','staged_unstaged_or_untracked'],['live','live_session_or_process']]){
        const blocked=await f.api('/write',finalize(name));
        expect(blocked.body.data.receipt).toMatchObject({state:'failed',reason});
        expect(existsSync(f.workspaces[name].cwd)).toBe(true);
    }
});
