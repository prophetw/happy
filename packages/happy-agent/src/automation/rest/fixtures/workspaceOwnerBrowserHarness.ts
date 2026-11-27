import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureGit, workspaceOwnerFixture } from './workspaceOwnerFixture';
import { projectResponse } from '../projection';
import { createWorkspaceOwnerApi } from '../../production/workspaceOwnerApi';
import { executeWorkspaceReclamation, executeWorkspaceOwnerJob } from '../../production/workspaceOwner';
import { ApiError } from '../schema';
import { reclaimRecords } from '../workspaceReclaimState';
import { openWorkspaceLifecycle } from '../../production/workspaces';

const socket=process.env.HAPPY_WORKSPACE_FIXTURE_SOCKET,root=process.env.HAPPY_WORKSPACE_FIXTURE_ROOT;
const isFixtureRoot=(path:string)=>/^\/tmp\/happy-owner-ui-[A-Za-z0-9_]+$/.test(path);
const restarting=process.env.HAPPY_WORKSPACE_RESTART_ROOT;
const backgroundTest=process.env.HAPPY_WORKSPACE_RECLAIM_FIXTURE==='1';
const restartTest=process.env.HAPPY_WORKSPACE_RESTART_FIXTURE==='1'||backgroundTest;
if ((socket || root) && (!socket || !root || !isFixtureRoot(root))) throw new Error('Invalid process probe fixture');
if (restarting && (!restartTest || !isFixtureRoot(restarting) || socket || root)) throw new Error('Invalid restart fixture');
const f=restarting?null:await workspaceOwnerFixture(socket&&root?{socket,root}:undefined,process.env.HAPPY_WORKSPACE_FINALIZE_FIXTURE==='1'||restartTest&&!backgroundTest,restartTest&&!backgroundTest);
const assets=process.argv[2];
const base=f?.root??restarting!;
const manifest=join(base,'browser-fixture.json');
const fixtureData=f?{ root:f.root,repo:f.repo,configFile:f.configFile,
    workspaces:Object.fromEntries(Object.entries(f.workspaces).map(([key,w])=>[key,{id:w.id,cwd:w.cwd}])) }:JSON.parse(readFileSync(manifest,'utf8'));

if (f&&!backgroundTest) for (const w of Object.values(f.workspaces)) reclaimRecords(f.queue.directory)?.delete(w.id);
if (f&&restartTest&&!backgroundTest) {
    const remote=join(base,'remote.git'), old=join(f.repo,'older-worktree');
    fixtureGit(f.repo,'init','--bare',remote);
    fixtureGit(f.repo,'remote','add','origin',remote);
    fixtureGit(f.repo,'push','origin','main');
    fixtureGit(f.repo,'worktree','add','-qb','older-unclaimed',old,'main');
    for (const name of ['ready','unknown-reply','delivery']) {
        const w=f.workspaces[name],file=name+'.txt';
        if(name==='delivery')fixtureGit(w.cwd,'merge','--ff-only',fixtureGit(f.workspaces.ready.cwd,'rev-parse','HEAD'));
        writeFileSync(join(w.cwd,file),name+'\n');
        fixtureGit(w.cwd,'add',file);
        fixtureGit(w.cwd,'commit','-qm',name);
        const head=fixtureGit(w.cwd,'rev-parse','HEAD');
        f.queue.transaction(state=>{const task=state.tasks.find(t=>t.workspaceID===w.id)!;task.resultCommit=head;});
        if(name==='unknown-reply')fixtureGit(w.cwd,'push','origin','HEAD:refs/heads/'+w.branch);
    }
    // Simulate a lost local checkout outside the Owner flow, leaving its
    // durable task mapping and the Git registration intact.
    rmSync(f.workspaces.unconfirmed.cwd,{recursive:true,force:true});
    f.queue.transaction(state=>{state.workspaces=state.workspaces.filter(w=>w.id!==f.workspaces.live.id);});
    writeFileSync(f.policyFile,JSON.stringify({...f.policy,remote:'origin',
        delivery:{strategy:'direct',remoteURL:remote,test:['/bin/sh','-c','test "$(cat delivery.txt)" = delivery']}}));
    Object.assign(fixtureData,{remote,old});
    writeFileSync(manifest,JSON.stringify(fixtureData),{mode:0o600});
}
if (f&&backgroundTest) {
    const remote=join(base,'remote.git');
    fixtureGit(f.repo,'remote','add','origin',remote);
    writeFileSync(f.policyFile,JSON.stringify({...f.policy,remote:'origin',reclaimRemoteURL:remote}));
    Object.assign(fixtureData,{remote,workerFile:f.workerFile,policyFile:f.policyFile,home:f.home});
    writeFileSync(manifest,JSON.stringify(fixtureData),{mode:0o600});
    await f.app.close();
}
const activity=async (w:{id:string})=>({confirmed:true,
    blockers:w.id===fixtureData.workspaces.live.id?['live_session_or_process']:[],fingerprint:'isolated-fixture'});
const app=(!backgroundTest&&f?.app)||createWorkspaceOwnerApi({
    configFile:fixtureData.configFile, jobEntry:'fixture-not-spawned',
    reclaimCredential:backgroundTest?()=> 'Bearer fixture-owner':undefined,
    verifyControl:async()=>['fixture-project'],
    verifyOwner:async authorization=>{
        if(authorization==='Bearer fixture-owner')return 'fixture-owner';
        if(authorization==='Bearer other-owner')return 'other-owner';
        throw new ApiError('OWNER_AUTH_REQUIRED',401);
    },
    run:async (owner,request,plan)=>{
        try {
            if ((request as {action?:string})?.action==='automatic-reclamation')
                return {ok:true,data:await executeWorkspaceReclamation(fixtureData.configFile,owner,'fixture-project',async()=>{},activity)};
            return {ok:true,data:await executeWorkspaceOwnerJob(fixtureData.configFile,owner,request,plan,{activity})};
        } catch(error) { return {ok:false,error:{code:error instanceof ApiError?error.code:'WORKSPACE_INSPECTION_UNCONFIRMED'}}; }
    },
});
app.get('/',async(_req,reply)=>reply.type('text/html').send('<!doctype html><html lang="zh"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dots workspaces · isolated fixture</title><style>html,body,#root{margin:0;min-height:100%;font-family:system-ui}body{background:#fff}</style><div id="root"></div><script src="/fixture.js"></script></html>'));
app.get('/fixture.js',async(_req,reply)=>reply.type('application/javascript').send(readFileSync(join(assets,'fixture.js'))));
await app.listen({host:'127.0.0.1',port:20082});
process.send?.({ready:true,...fixtureData,pid:process.pid});
process.on('message',async message=>{
    if(message==='results'&&f)process.send?.({kind:'results',tasks:f.queue.tasks().map(task=>({id:task.id,...projectResponse({version:1,ok:true,data:f.queue.receipt(task)})}))});
    if(message==='background-result'&&backgroundTest){
        const {lifecycle}=openWorkspaceLifecycle(fixtureData.workerFile,fixtureData.policyFile,{homeDirectory:fixtureData.home});
        const id=fixtureData.workspaces.ready.id;
        const task=lifecycle.queue.tasks().find(t=>t.workspaceID===id)!;
        process.send?.({kind:'background-result',requestID:task.requestID,absent:!existsSync(fixtureData.workspaces.ready.cwd),
            result:lifecycle.result(id,undefined,true),receipt:projectResponse({version:1,ok:true,data:lifecycle.queue.receipt(task)})});
    }
    if(message==='stop'){await app.close();await f?.stopProcesses();rmSync(base,{recursive:true,force:true});process.disconnect?.();}
});
