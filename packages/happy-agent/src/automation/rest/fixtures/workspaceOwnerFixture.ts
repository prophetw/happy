import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { hash } from '../../journal';
import { TaskQueue } from '../taskQueue';
import { prepareWorkspace, workspaceResult, workspaceResources } from '../taskWorkspaces';
import { TaskScheduler } from '../taskScheduler';
import { executeWorkspaceOwnerJob } from '../../production/workspaceOwner';
import { createWorkspaceOwnerApi, type WorkspaceOwnerRunner } from '../../production/workspaceOwnerApi';
import { ApiError } from '../schema';
import { SessionProcessProofs } from '../sessionProcessProofs';

export const fixtureGit=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
/** No live config, account, credentials, messages or databases. Every Git path
 * is created beneath this single mkdtemp root. With a probe socket, real Linux
 * session processes exercise the same occupancy checks as the production API. */
export async function workspaceOwnerFixture(processProbe?: { root: string; socket: string }) {
    const root=processProbe?.root??mkdtempSync('/tmp/happy-owner-ui-'),repo=join(root,'repo'),home=join(root,'home');mkdirSync(repo);mkdirSync(home);
    fixtureGit(repo,'init','-qb','main');fixtureGit(repo,'config','user.name','Fixture');fixtureGit(repo,'config','user.email','fixture@invalid');
    writeFileSync(join(repo,'base.txt'),'synthetic code\n');fixtureGit(repo,'add','base.txt');fixtureGit(repo,'commit','-qm','base');
    const machineID='fixture-machine',projectID='fixture-project',ownerID='fixture-owner';
    const queue=new TaskQueue(join(home,'.local/state/happy-control/machines',hash(machineID)),{}, {machineID});
    const workspaces:Record<string,Awaited<ReturnType<typeof prepareWorkspace>>>={};
    for(const name of ['ready','unknown-reply','dirty','live','legacy','unconfirmed']) {
        const w=await prepareWorkspace(queue,{requestID:`create-${name}`,grantID:'fixture-grant',projectID,root:repo,execution:{mode:'worktree'}});
        queue.transaction(s=>{s.workspaces.find(x=>x.id===w.id)!.sessionID=`session-${name}`;});
        const task=queue.enqueue({requestID:`send-${name}`,grantID:'fixture-grant',workerID:'fixture-worker',sessionID:`session-${name}`,workspaceID:w.id,authorization:'',text:'synthetic fixture input',resources:workspaceResources(w,`session-${name}`)});
        const scheduler=new TaskScheduler(queue,{authorize:async()=>{},send:async()=>({seq:1,id:'fixture-sent'}),stop:async()=>{},
            observe:async()=>({process:'running',cursor:1,seq:1,outcome:'completed',...workspaceResult(w)})});
        await scheduler.tick();await scheduler.tick();
        if(name==='dirty')writeFileSync(join(w.cwd,'keep.txt'),'must retain\n');
        if(name==='legacy')queue.transaction(s=>{delete s.workspaces.find(x=>x.id===w.id)!.managedBy;});
        if(name==='unconfirmed')queue.update(task.id,t=>{delete t.resultCommit;});
        workspaces[name]=w;
    }
    const policy={version:1,id:'fixture-policy',machineID,grantID:'fixture-grant',projectID,root:repo,mainRef:'refs/heads/main',allowApply:true,allowArchive:false,allowDiscard:false};
    const policyFile=join(root,'policy.json'),workerFile=join(root,'worker.json'),configFile=join(root,'owner.json');
    const save=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value),{mode:0o600});save(policyFile,policy);
    save(workerFile,{version:1,role:'worker',endpoint:'https://fixture.invalid/happy-control/v1',relayURL:'https://fixture.invalid',happyHomeDirectory:home,identityRef:'unused',
        registration:{id:'fixture-worker',userID:ownerID,name:'Fixture machine',publicKey:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),machineID,projects:[{id:projectID,directory:repo,sessionIDs:[]}],methods:['sessions.list'],protocol:1},
        secrets:{type:'encrypted-pkcs8-credentials',credentialsDirectory:join(root,'unused'),keys:{}}});
    save(configFile,{version:1,workerConfig:workerFile,stateDirectory:join(root,'manager'),homeDirectory:home,processProbeSocket:processProbe?.socket,
        listen:{host:'127.0.0.1',port:20082},origins:['http://127.0.0.1:20082'],projects:[{id:projectID,name:'Fixture Project',policyFile}]});
    const processes = new Set<ChildProcess>();
    const stop = async (child: ChildProcess) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exit = once(child, 'exit');
        child.kill();
        await exit;
    };
    if (processProbe) {
        const proofs = new SessionProcessProofs(join(queue.directory, 'session-process-proofs'), machineID);
        try {
            for (const [name, workspace] of Object.entries(workspaces)) {
                const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: workspace.cwd, detached: true, stdio: 'ignore' });
                await once(child, 'spawn');
                processes.add(child);
                if (!proofs.recordRunning({ id: `session-${name}`, metadata: { machineId: machineID, hostPid: child.pid, path: workspace.cwd } }, 'running'))
                    throw new Error(`Could not record fixture process for ${name}`);
                if (name !== 'live') { await stop(child); processes.delete(child); }
            }
        } catch (error) {
            await Promise.all([...processes].map(stop));
            throw error;
        }
    }
    const blockers=new Map<string,string[]>([[workspaces.live.id,['live_session_or_process']]]);
    let beforeJob: (()=>Promise<void>)|undefined;
    let afterJob: (()=>void)|undefined,controlAllowed=true;
    const run:WorkspaceOwnerRunner=async(owner,request,plan)=>{
        await beforeJob?.();
        try{const data=await executeWorkspaceOwnerJob(configFile,owner,request,plan,{activity:processProbe?undefined:async w=>({confirmed:true,blockers:blockers.get(w.id)??[],fingerprint:(blockers.get(w.id)??[]).join(':')||'fixture-clear'}),
            authorize:async()=>{if(!controlAllowed)throw new ApiError('WORKSPACE_SCOPE_DENIED',403);}});afterJob?.();return {ok:true,data};}
        catch(e){return {ok:false,error:{code:e instanceof ApiError?e.code:'WORKSPACE_INSPECTION_UNCONFIRMED'}};}
    };
    let clock=Date.now();
    const app=createWorkspaceOwnerApi({configFile,jobEntry:'fixture-not-spawned',run,now:()=>clock,verifyControl:async()=>controlAllowed?[projectID]:[],verifyOwner:async authorization=>{
        if(authorization==='Bearer fixture-owner')return ownerID;
        if(authorization==='Bearer other-owner')return 'other-owner';
        throw new ApiError('OWNER_AUTH_REQUIRED',401);
    }});
    const headers={origin:'http://127.0.0.1:20082',authorization:'Bearer fixture-owner'};
    const api=async(path:string,payload:unknown,extra:Record<string,string>={})=>{
        const response=await app.inject({method:'POST',url:'/api/workspace-owner/v1'+path,payload:JSON.stringify(payload),headers:{'content-type':'application/json',...headers,...extra}});
        return {status:response.statusCode,body:response.json()};
    };
    const scope={machineID,projectID};
    return {root,repo,home,queue,workspaces,app,api,scope,configFile,policyFile,workerFile,policy,blockers,run,headers,stopProcesses:()=>Promise.all([...processes].map(stop)),
        pause:(fn?:()=>Promise<void>)=>{beforeJob=fn;}, afterJob:(fn?:()=>void)=>{afterJob=fn;}, control:(allowed:boolean)=>{controlAllowed=allowed;}, advance:(ms:number)=>{clock+=ms;},
        request:(name:string,action:string,extra:Record<string,unknown>={})=>({action,...scope,workspaceID:workspaces[name].id,...extra}),
        resolve:async(name:string)=>{
            const r=await api('/write',{action:'resolve',...scope,workspaceID:workspaces[name].id,operationID:`resolve-${name}`,revision:0,head:fixtureGit(workspaces[name].cwd,'rev-parse','HEAD'),kind:'no-change'});
            if(r.body.data?.receipt?.state!=='resolved')throw Error(JSON.stringify(r.body));return r;
        },
    };
}
