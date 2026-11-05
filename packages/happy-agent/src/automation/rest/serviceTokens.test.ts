import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway } from './gateway';
import { MAX_SERVICE_GRANT_MS } from './schema';
import { hostConfigSchema } from '../production/config';
const fixturePath = new URL('../../../examples/rest-fixture.ts', import.meta.url).pathname;
const clients = [{ id: 'serviceA', userID: 'userA', name: 'Fixture backend A', generation: 'identity_v1' }, { id: 'serviceB', userID: 'userB', name: 'Fixture backend B', generation: 'identity_v1' }];
const rigs: any[]=[];
afterEach(async()=>{await Promise.all(rigs.splice(0).map(r=>r.close()));});
async function setup(extra: any={}) { const {fixtureRig}=await import(fixturePath);const r=await fixtureRig({serviceTokens:{clients:clients.map(c=>({...c}))},...extra});rigs.push(r);return r; }
async function pending(r:any,scope:Record<string,unknown>={}) {
 const x=await r.ownerRequest('/service-connections','POST',{clientID:'serviceA',workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list','sessions.list','tasks.create','requests.get','sessions.send','sessions.status','sessions.logs','sessions.result','sessions.cancel'],sessionIDs:[],expiresAt:r.gatewayOptions.now()+MAX_SERVICE_GRANT_MS,...scope});
 expect(x.status).toBe(200);return x.body.data;
}
async function approve(r:any,c:any) { const view=await r.ownerRequest(`/connections/${c.id}/consent`);const x=await r.ownerRequest(`/connections/${c.id}/approve`,'POST',{digest:view.body.data.digest,challenge:view.body.data.challenge,credentialMode:'service-token-v1'});expect(x.status).toBe(200); }
async function issue(r:any,c:any) { const x=await r.ownerRequest(`/connections/${c.id}/service-token`,'POST');expect(x.status).toBe(200);return x.body.data.token as string; }
async function request(r:any,token:string,route:string,method='GET',body?:unknown) {
 const response=await fetch(`${r.address}/happy-control/v1${route}`,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000) as NonNullable<Parameters<typeof fetch>[1]>['signal']});return {status:response.status,body:await response.json() as any};
}
describe('opt-in service access tokens (all identities/credentials and relay are isolated fixtures)',()=>{
 it('computes requested durations on the server for single, multiple and verified-directory scopes',async()=>{
  const serverNow=Date.now(),r=await setup({clock:()=>serverNow,multipleProjects:true,directorySelection:true});
  await r.startWorker();
  const selection=(await r.ownerRequest('/service-connections/resolve-directories','POST',{clientID:'serviceA',workerID:'worker',machineID:'machineA',directories:[r.projectB]})).body.data;
  const base={clientID:'serviceA',workerID:'worker',machineID:'machineA',methods:['machines.list'],sessionIDs:[],expiresInMs:MAX_SERVICE_GRANT_MS};
  for(const scope of [{projectID:'projectA'},{scopeVersion:2,projectIDs:['projectA','projectB']},{scopeVersion:3,projectIDs:selection.projects.map((p:any)=>p.id),projects:selection.projects,selectionID:selection.selectionID}]){
   const created=await r.ownerRequest('/service-connections','POST',{...base,...scope});
   expect(created.status).toBe(200);expect(created.body.data).toMatchObject({createdAt:serverNow,expiresAt:serverNow+MAX_SERVICE_GRANT_MS,state:'pending'});
   expect(created.body.data.expiresInMs).toBeUndefined();
  }
  for(const patch of [{expiresInMs:0},{expiresInMs:-1},{expiresInMs:1.5},{expiresInMs:undefined},{expiresAt:serverNow+60000}]){
   expect((await r.ownerRequest('/service-connections','POST',{...base,projectID:'projectA',...patch})).status).toBe(400);
  }
  expect((await r.ownerRequest('/service-connections','POST',{...base,projectID:'projectA',expiresInMs:MAX_SERVICE_GRANT_MS+1})).status).toBe(403);
  expect(r.gateway.store.list('connection:')).toHaveLength(3);
 });
 it('keeps the configured service duration cap and original signed expiry contract',async()=>{
  const serverNow=Date.now(),r=await setup({clock:()=>serverNow,serviceTokens:{clients,maxGrantMs:60000}});
  const base={clientID:'serviceA',workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list'],sessionIDs:[]};
  expect((await r.ownerRequest('/service-connections','POST',{...base,expiresInMs:60001})).status).toBe(403);
  const c=await r.ownerRequest('/service-connections','POST',{...base,expiresInMs:60000});expect(c.body.data.expiresAt).toBe(serverNow+60000);
  const signed=await r.client.request('POST','/connections',{workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list'],sessionIDs:[],expiresInMs:60000});
  expect(signed.error.code).toBe('INVALID_REQUEST');
 });
 it('keeps signed defaults unchanged; opts in explicitly and caps service grants at 30 days',async()=>{
  const r=await setup();
  const normal=await r.client.request('POST','/connections',{workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list'],expiresAt:Date.now()+2*3600000});expect(normal.error.code).toBe('SCOPE_DENIED');
  const tooLong=await r.ownerRequest('/service-connections','POST',{clientID:'serviceA',workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list'],expiresAt:Date.now()+MAX_SERVICE_GRANT_MS+1000});expect(tooLong.status).toBe(403);
  const c=await pending(r);expect(c.credentialMode).toBe('service-token-v1');
  const options=await r.ownerRequest('/service-connections/options');expect(options.body.data.clients.map((x:any)=>x.id)).toEqual(['serviceA']);expect(options.body.data.workers[0].projects[0].directory).toBe(r.project);
  const off=await setup({serviceTokens:undefined});expect((await off.ownerRequest('/service-connections/options')).body.error.code).toBe('SERVICE_TOKENS_DISABLED');
  expect(hostConfigSchema.safeParse({version:1,role:'host',listen:{host:'127.0.0.1',port:9010},origin:'https://fixture.invalid',relayURL:'https://fixture.invalid/home-relay',stateDirectory:'/fixture',clients:[],workers:[],serviceTokens:{clients,maxGrantMs:MAX_SERVICE_GRANT_MS+1}}).success).toBe(false);
 });
 it('requires owner origin/authentication and explicit bound approval before one-time delivery',async()=>{
  const r=await setup(),c=await pending(r);
  expect((await r.ownerRequest(`/connections/${c.id}/service-token`,'POST')).body.error.code).toBe('GRANT_NOT_APPROVED');
  expect((await r.gateway.app.inject({method:'POST',url:`/happy-control/v1/connections/${c.id}/service-token`,headers:{authorization:'Bearer fixture-owner-A'}})).statusCode).toBe(403);
  expect((await r.ownerRequest(`/connections/${c.id}/service-token`,'POST',undefined,'B')).status).toBe(404);
  const consent=await r.ownerRequest(`/connections/${c.id}/consent`);
  expect((await r.ownerRequest(`/connections/${c.id}/approve`,'POST',{digest:consent.body.data.digest,challenge:consent.body.data.challenge})).body.error.code).toBe('SERVICE_TOKEN_APPROVAL_UPGRADE_REQUIRED');
  expect((await r.ownerRequest(`/connections/${c.id}/approve`,'POST',{digest:'0'.repeat(64),challenge:consent.body.data.challenge,credentialMode:'service-token-v1'})).status).toBe(409);
  await approve(r,c);const results=await Promise.all(Array.from({length:4},()=>r.ownerRequest(`/connections/${c.id}/service-token`,'POST')));
  expect(results.filter(x=>x.status===200)).toHaveLength(1);expect(results.filter(x=>x.body.error?.code==='SERVICE_TOKEN_ALREADY_ISSUED')).toHaveLength(3);
  const metadata=(await r.ownerRequest(`/connections/${c.id}/consent`)).body.data.serviceToken;expect(metadata.issued).toBe(true);expect('token' in metadata).toBe(false);expect('digest' in metadata).toBe(false);
 });
 it('stores only a digest, never reveals again, and never forwards a service token to owner verification',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  const state=readdirSync(join(r.dir,'gateway/state')).map(p=>readFileSync(join(r.dir,'gateway/state',p),'utf8')).join('');
  expect(state.includes(token)).toBe(false);expect(state.includes(token.split('.').at(-1)!)).toBe(false);expect(JSON.stringify(r.audit).includes(token)).toBe(false);
  expect((await r.ownerRequest(`/connections/${c.id}/service-token`,'POST')).body.error.code).toBe('SERVICE_TOKEN_ALREADY_ISSUED');
  let verifierCalls=0;r.gatewayOptions.verifyOwner=async()=>{verifierCalls++;return 'userA';};
  expect((await r.gateway.app.inject({method:'GET',url:'/happy-control/v1/connections',headers:{origin:r.gatewayOptions.origin,authorization:`Bearer ${token}`}})).statusCode).toBe(401);
  expect((await request(r,token,`/connections/${c.id}/approve`,'POST',{digest:c.digest,challenge:'fixture'})).status).toBe(403);
  expect(verifierCalls).toBe(0);
 });
 it('does not accept service tokens as worker proof, issuer credentials, or unscoped query/cookie auth',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  expect((await request(r,token,'/worker/poll','POST',{protocol:1})).status).toBe(401);
  expect((await request(r,token,'/connections','POST',{})).status).toBe(401);
  expect((await request(r,token,`/connections/${c.id}/service-token`,'POST')).status).toBe(403);
  expect((await r.gateway.app.inject({method:'GET',url:'/happy-control/v1/machines',headers:{cookie:`service=${token}`}})).statusCode).toBe(401);
  expect((await r.gateway.app.inject({method:'GET',url:'/happy-control/v1/machines?token=fixture-only'})).statusCode).toBe(401);
  expect((await request(r,token+'x','/machines')).status).toBe(401);
 });
 it('uses the same worker/control/journal for create/send/results/idempotence/cancel unknown and real-stop confirmation',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);await r.startWorker();
  const body={requestID:'create_1',machineID:'machineA',projectID:'projectA'};
  const results=await Promise.all(Array.from({length:3},()=>request(r,token,'/tasks','POST',body)));
  const confirmed=results.find(x=>x.body.data?.state==='confirmed')!;expect(!!confirmed).toBe(true);const sid=confirmed.body.data.sessionID;
  const receipt=await request(r,token,'/requests/create_1');expect(receipt.body.data.sessionID).toBe(sid);expect(r.spawnCount).toBe(1);
  const sent=await request(r,token,`/sessions/${sid}/messages`,'POST',{requestID:'send_1',text:'fixture instruction'});expect(sent.body.data.state).toBe('submitted');
  const duplicate=await request(r,token,`/sessions/${sid}/messages`,'POST',{requestID:'send_1',text:'fixture instruction'});expect(duplicate.body.data.messageID).toBe(sent.body.data.messageID);expect(r.sendCount).toBe(1);
  expect((await request(r,token,`/sessions/${sid}/messages`,'POST',{requestID:'send_1',text:'different fixture'})).body.error.code).toBe('REQUEST_ID_CONFLICT');
  r.complete(sid,'turn_service');let after=0,ready=false;const rows:any[]=[];
  for(let i=0;i<5;i++){const x=await request(r,token,`/sessions/${sid}/result?turnID=turn_service&after_seq=${after}&limit=2`);expect(x.body.data.attribution).toBe('session_turn_only');expect(x.body.data.nextCursor).toBeGreaterThanOrEqual(after);after=x.body.data.nextCursor;ready ||=x.body.data.ready;rows.push(...x.body.data.messages);if(!x.body.data.hasMore)break;}
  expect(ready).toBe(true);expect(rows.every(x=>x.turnID==='turn_service')).toBe(true);
  expect([...r.ciphertext.values()].flat().some((m:any)=>m.c.includes('fixture instruction'))).toBe(false);
  const cancel=await request(r,token,`/sessions/${sid}/cancel`,'POST',{requestID:'cancel_1'});expect(cancel.body.data.state).toBe('cancel_requested');expect(cancel.body.data.process).toBe('unknown');
  r.setProcess('stopped');expect((await request(r,token,'/requests/cancel_1')).body.data.process).toBe('stopped');
 },15000);
 it('rejects cross user/project/machine/method/session and cannot access another grant sharing its service identity',async()=>{
  const r=await setup();
  const bad={clientID:'serviceB',workerID:'worker',machineID:'machineA',projectID:'projectA',methods:['machines.list'],expiresAt:Date.now()+60000};expect((await r.ownerRequest('/service-connections','POST',bad)).status).toBe(403);
  const c=await pending(r,{methods:['machines.list']});await approve(r,c);const token=await issue(r,c);await r.startWorker();
  expect((await request(r,token,'/projects')).body.data.projects).toEqual([{projectID:'projectA',directory:r.project}]);
  expect((await request(r,token,'/tasks','POST',{requestID:'denied',machineID:'machineA',projectID:'projectA'})).body.error.code).toBe('SCOPE_DENIED');
  const full=await pending(r);await approve(r,full);const fullToken=await issue(r,full);
  for(const patch of [{projectID:'other'},{machineID:'other'}])expect((await request(r,fullToken,'/tasks','POST',{requestID:'denied',machineID:'machineA',projectID:'projectA',...patch})).body.error.code).toBe('SCOPE_DENIED');
  expect((await request(r,fullToken,'/sessions/existing/status')).body.error.code).toBe('SCOPE_DENIED');
  expect((await request(r,fullToken,`/connections/${c.id}`)).status).toBe(404);
  expect((await r.ownerRequest('/service-connections','POST',{...bad,clientID:'serviceA',sessionIDs:['foreign']})).status).toBe(403);
 });
 it('handles offline/timeout as unavailable or unknown, then reconciles the original request without duplicate spawn',async()=>{
  const r=await setup({timeoutMs:1000}),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  const args={requestID:'slow',machineID:'machineA',projectID:'projectA'};
  const offline=await request(r,token,'/tasks','POST',args);expect(offline.body.error.code).toBe('WORKER_UNAVAILABLE');expect(offline.body.dispatch).toBe('not_sent');
  await r.startWorker();const release=r.pauseSpawn();const active=request(r,token,'/tasks','POST',args);
  for(let i=0;i<100&&r.spawnCount===0;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(r.spawnCount).toBe(1);
  const uncertain=await active;expect(uncertain.body.data?.state==='unknown'||uncertain.body.error?.code==='UNAVAILABLE_OR_UNKNOWN').toBe(true);
  release();r.gatewayOptions.timeoutMs=2000;let confirmed=false;
  for(let i=0;i<10;i++){const receipt=await request(r,token,'/requests/slow');expect(receipt.body.error?.code).toBeUndefined();if(receipt.body.data.state==='confirmed'){confirmed=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  expect(confirmed).toBe(true);expect(r.spawnCount).toBe(1);
 });
 it('expires at the original approved deadline and persists revocation across restart; cannot recover plaintext after lost delivery',async()=>{
  let time=Date.now();const r=await setup({clock:()=>time}),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  await r.restartGateway();await r.startWorker();expect((await request(r,token,'/machines')).status).toBe(200);
  expect((await r.ownerRequest(`/connections/${c.id}/service-token`,'POST')).body.error.code).toBe('SERVICE_TOKEN_ALREADY_ISSUED');
  time=c.expiresAt;expect((await request(r,token,'/machines')).body.error.code).toBe('GRANT_EXPIRED');
  const next=await pending(r);await approve(r,next);const nextToken=await issue(r,next);await r.ownerRequest(`/connections/${next.id}`,'DELETE');await r.restartGateway();
  expect((await request(r,nextToken,'/machines')).body.error.code).toBe('GRANT_REVOKED');
 });
 it('revokes in-flight access and worker rechecks; identity removal/change cannot resurrect an old token',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);await r.startWorker();const release=r.pauseSpawn();
  const active=request(r,token,'/tasks','POST',{requestID:'blocked',machineID:'machineA',projectID:'projectA'});
  for(let i=0;i<100&&r.spawnCount===0;i++)await new Promise(resolve=>setTimeout(resolve,5));expect(r.spawnCount).toBe(1);
  await r.ownerRequest(`/connections/${c.id}`,'DELETE');expect((await active).body.error.code).toBe('GRANT_REVOKED');release();
  const next=await pending(r);await approve(r,next);const nextToken=await issue(r,next);r.gatewayOptions.serviceTokens.clients[0].generation='identity_v2';await r.restartGateway();
  expect((await request(r,nextToken,'/machines')).body.error.code).toBe('GRANT_REVOKED');
  r.gatewayOptions.serviceTokens.clients[0].generation='identity_v1';await r.restartGateway();expect((await request(r,nextToken,'/machines')).body.error.code).toBe('GRANT_REVOKED');
 });
 it('permanent record deletion immediately invalidates only that service token and removes its digest',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  const other=await pending(r);await approve(r,other);const otherToken=await issue(r,other);await r.startWorker();
  expect((await request(r,token,'/machines')).status).toBe(200);expect((await request(r,otherToken,'/machines')).status).toBe(200);
  expect((await r.ownerRequest(`/connections/${c.id}/record`,'DELETE')).status).toBe(200);
  const invalid=await request(r,token,'/machines');expect(invalid.status).toBe(401);expect(invalid.body.error.code).toBe('INVALID_SERVICE_TOKEN');
  expect((await request(r,otherToken,'/machines')).status).toBe(200);
  expect(r.gateway.store.get(`service-token:${c.id}`)).toBeNull();expect(r.gateway.store.get(`service-token:${other.id}`)).not.toBeNull();
  expect(r.gateway.store.get(`connection:${c.id}`)).toBeNull();expect(r.gateway.store.get(`connection:${other.id}`)).toMatchObject({state:'approved'});
 });
 it('cleans a service-token digest while the feature is disabled and cannot restore it when re-enabled',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c),config=r.gatewayOptions.serviceTokens;
  r.gatewayOptions.serviceTokens=undefined;await r.restartGateway();
  expect(r.gateway.store.get(`service-token:${c.id}`)).not.toBeNull();
  expect((await r.ownerRequest(`/connections/${c.id}/record`,'DELETE')).status).toBe(200);
  expect(r.gateway.store.get(`service-token:${c.id}`)).toBeNull();expect(r.gateway.store.get(`connection:${c.id}`)).toBeNull();
  r.gatewayOptions.serviceTokens=config;await r.restartGateway();
  const invalid=await request(r,token,'/machines');expect(invalid.status).toBe(401);expect(invalid.body.error.code).toBe('INVALID_SERVICE_TOKEN');
  expect((await r.ownerRequest(`/connections/${c.id}/consent`)).status).toBe(404);
 });
 it('rejects duplicate signed/service identities before starting a gateway',async()=>{
  const r=await setup();expect(()=>createGateway({...r.gatewayOptions,directory:join(r.dir,'bad'),serviceTokens:{clients:[{...clients[0],id:'assistant'}]}})).toThrow('DUPLICATE_REGISTRATION');
 });
 it('redacts a bare service credential from task output and permits only explicitly approved existing sessions',async()=>{
  const r=await setup(),c=await pending(r,{sessionIDs:['existing']});await approve(r,c);const token=await issue(r,c);await r.startWorker();
  r.complete('existing','sensitive_turn','completed','Do not expose '+token);
  const result=await request(r,token,'/sessions/existing/result?turnID=sensitive_turn');expect(result.status).toBe(200);expect(JSON.stringify(result.body).includes(token)).toBe(false);
  expect(result.body.data.messages.some((m:any)=>m.text?.includes('[REDACTED]'))).toBe(true);
 });
 it('fails readiness/authentication/startup closed on corrupted credential metadata',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  r.gateway.store.set('service-token:'+c.id,{broken:true});
  expect((await request(r,token,'/machines')).body.error.code).toBe('STORE_UNAVAILABLE');
  expect((await r.gateway.app.inject({method:'GET',url:'/readyz'})).statusCode).toBe(503);
  await r.gateway.app.close();expect(()=>createGateway(r.gatewayOptions)).toThrow('STORE_UNAVAILABLE');
 });
 it('disabling and re-enabling the feature cannot restore a previously approved service token',async()=>{
  const r=await setup(),c=await pending(r);await approve(r,c);const token=await issue(r,c);
  const config=r.gatewayOptions.serviceTokens;r.gatewayOptions.serviceTokens=undefined;await r.restartGateway();
  expect((await request(r,token,'/machines')).body.error.code).toBe('SERVICE_TOKENS_DISABLED');
  r.gatewayOptions.serviceTokens=config;await r.restartGateway();expect((await request(r,token,'/machines')).body.error.code).toBe('GRANT_REVOKED');
 });
});

describe('backend integration example safety',()=>{
 it('sanitizes provider/network errors and distinguishes not-sent from uncertain mutations',async()=>{
  const {serviceBackend}=await import(new URL('../../../examples/service-token-backend.mjs',import.meta.url).pathname);
  const noCredential=serviceBackend({endpoint:'https://fixture.invalid/happy-control/v1',getToken:async()=>{throw Error('fixture-provider-private-diagnostic');}});
  const before=await noCredential('POST','/tasks',{requestID:'stable_id'});expect(before.dispatch).toBe('not_sent');expect(JSON.stringify(before).includes('private-diagnostic')).toBe(false);
  const uncertain=serviceBackend({endpoint:'https://fixture.invalid/happy-control/v1',getToken:async()=>`hsvc1.fixture.${'a'.repeat(43)}`,fetchImpl:async()=>{throw Error('fixture-network-private-diagnostic');}});
  const after=await uncertain('POST','/tasks',{requestID:'stable_id'});expect(after.data).toEqual({state:'unknown',requestID:'stable_id'});expect(JSON.stringify(after).includes('private-diagnostic')).toBe(false);
 });
 it('rejects normalized/encoded traversal before reading any credential or making a request',async()=>{
  const {serviceBackend}=await import(new URL('../../../examples/service-token-backend.mjs',import.meta.url).pathname);let reads=0,requests=0;
  const call=serviceBackend({endpoint:'https://fixture.invalid/happy-control/v1',getToken:async()=>{reads++;return `hsvc1.fixture.${'a'.repeat(43)}`;},fetchImpl:async()=>{requests++;throw Error();}});
  for(const route of ['/%2e%2e/%2e%2e/home-relay/v1/account/profile','/..%2fhome-relay','/%252e%252e/elsewhere','//other.invalid/','/sessions/%5c..'])expect((await call('GET',route)).error.code).toBe('INVALID_ROUTE');
  expect(reads).toBe(0);expect(requests).toBe(0);
 });
});
