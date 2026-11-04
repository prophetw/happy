import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewServiceTokenPlan, rolloutTemplate, serviceHostPatch } from './service-token-plan.mjs';
import { templates, validateProxyContracts } from './check.mjs';
const here=dirname(fileURLToPath(import.meta.url)),copy=x=>structuredClone(x),sha=c=>c.repeat(64);
function complete(){const p=rolloutTemplate();p.candidate.controlImageID='sha256:'+sha('1');p.candidate.controlImageArchiveSHA256=sha('2');p.candidate.webArchiveSHA256=sha('3');p.candidate.webTarget='.happy-releases/fixture-service-tokens';p.hostPatch.serviceTokens.clients=[{id:'fixture_service',userID:'fixture_user',name:'Fixture backend',generation:'fixture_generation'}];p.externalBackend.secretProvider='fixture_secret_provider';p.externalBackend.secureDeliveryChannel='fixture_secure_handoff';return p;}
test('draft is reviewable but missing real identity/artifacts/handoff and never claims deployment readiness',()=>{
 const p=rolloutTemplate(),r=reviewServiceTokenPlan(p);assert.equal(r.publicPlanValid,true);assert.equal(r.publicPlanComplete,false);assert.equal(r.deploymentReady,false);assert.equal(r.serverContacted,false);assert.equal(r.secretsRead,false);assert.equal(r.realGrantCreated,false);
 for(const field of ['candidate.controlImageID','candidate.controlImageArchiveSHA256','candidate.webArchiveSHA256','hostPatch.serviceTokens.clients.0.userID','externalBackend.secretProvider'])assert(r.missingFields.includes(field));
 assert.throws(()=>serviceHostPatch(p),/PUBLIC_PLAN_INCOMPLETE/);
});
test('complete public fixture produces a single additive host patch; no approval or online-readiness assertion',async()=>{
 const p=complete(),r=reviewServiceTokenPlan(p);assert.equal(r.publicPlanComplete,true);assert.equal(r.deploymentReady,false);assert.equal(r.mode,'review-only');assert.equal(p.proposedAcceptanceScope.approved,false);
 const patch=serviceHostPatch(p);assert.deepEqual(Object.keys(patch),['serviceTokens']);assert.equal(patch.serviceTokens.maxGrantMs,2592000000);
 const base=templates().host;
 // Synthetic public-key encoding only: no private key or account/device credential is generated.
 const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.alloc(32,7)]),format:'der',type:'spki'}).export({type:'spki',format:'pem'}).toString();
 base.clients[0].userID='fixture_user';base.clients[0].publicKey=publicKey;base.workers[0].userID='fixture_user';base.workers[0].machineID='fixture_machine';base.workers[0].publicKey=publicKey;
 const before=copy(base),candidate={...base,...patch};const {hostConfigSchema}=await import('../../../packages/happy-agent/dist/automation/production/index.mjs');const parsed=hostConfigSchema.parse(candidate);
 assert.equal(parsed.maxGrantMs,3600000);assert.deepEqual(candidate.workers,before.workers);assert.deepEqual(candidate.clients,before.clients);assert.equal(candidate.mcp,undefined);assert.equal(candidate.secrets,undefined);assert.deepEqual(base,before);
});
test('scope, signed policy, listeners, proxy/relay/worker actions and rollback safeguards cannot be widened',()=>{
 for(const mutate of [p=>p.proposedAcceptanceScope.projectRealpath='/home/dev/code/agent-runtime-bridge',p=>p.proposedAcceptanceScope.sessionIDs=['existing'],p=>p.proposedAcceptanceScope.methods=['shell'],p=>p.proposedAcceptanceScope.machineID='other',p=>p.proposedAcceptanceScope.recommendedInitialGrantMs=3600001,p=>p.invariants.signedMaxGrantMs=2592000000,p=>p.invariants.restBind='0.0.0.0:9010',p=>p.invariants.changeProxyRoutes=true,p=>p.invariants.updateWorker=true,p=>p.invariants.restartOrRecreateRelay=true,p=>p.invariants.preserveCurrentStateAndRevocationsOnRollback=false,p=>p.invariants.rollbackConfigAndImageTogether=false,p=>p.hostPatch.serviceTokens.maxGrantMs=2592000001]){const p=complete();mutate(p);assert.throws(()=>reviewServiceTokenPlan(p));}
});
test('rejects credentials, unsupported patch fields, image-id/manifest confusion, unsafe targets and premature approvals',()=>{
 for(const mutate of [p=>p.token='fixture-only',p=>p.hostPatch.secrets={},p=>p.hostPatch.serviceTokens.clients[0].publicKey='fixture-only',p=>p.hostPatch.serviceTokens.clients[0].name='Bearer fixture-only',p=>p.externalBackend.secretProvider='/etc/credentials',p=>p.candidate.controlImageID=p.baseline.controlImageID,p=>p.candidate.controlImageID='nginx@sha256:'+sha('1'),p=>p.candidate.webTarget='../happy',p=>p.applicationSource.kind='commit',p=>p.applicationSource.tree='not-a-sha',p=>p.proposedAcceptanceScope.approved=true,p=>p.baseline.liveRecheckedThisPreparation=true]){const p=complete();mutate(p);assert.throws(()=>reviewServiceTokenPlan(p));}
});
test('existing two proxy contracts already cover service paths without rewriting signatures or changing TLS',()=>{
 const a=readFileSync(join(here,'nginx-55.conf.example'),'utf8'),b=readFileSync(join(here,'nginx-57.location.conf.example'),'utf8');assert.equal(validateProxyContracts(a,b),true);
 for(const route of ['/happy-control/v1/service-connections','/happy-control/v1/service-connections/options','/happy-control/v1/connections/fixture/service-token'])assert(route.startsWith(rolloutTemplate().invariants.routePrefix));
});
test('CLI can only inspect/export public JSON; rejects apply and incomplete patches without printing input',()=>{
 const script=join(here,'service-token-plan.mjs');const r=JSON.parse(execFileSync(process.execPath,[script,'--review'],{encoding:'utf8'}));assert.equal(r.deploymentReady,false);
 for(const args of [['--apply'],['--deploy'],['--host-patch'],['--review','unused','extra']]){const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(JSON.parse(result.stderr).code,'SERVICE_TOKEN_PLAN_REJECTED');}
 const d=mkdtempSync(join(tmpdir(),'happy-public-plan-'));try{const p=join(d,'plan.json');writeFileSync(p,JSON.stringify({...complete(),token:'fixture-do-not-print'}));const result=spawnSync(process.execPath,[script,'--review',p],{encoding:'utf8'});assert.equal(result.status,1);assert(!result.stderr.includes('fixture-do-not-print'));}finally{rmSync(d,{recursive:true,force:true});}
});
