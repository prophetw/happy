import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templates } from './check.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const read=name=>readFileSync(join(here,name),'utf8');
const plan=JSON.parse(read('multi-project-rollout.json.example')),patch=JSON.parse(read('multi-project-scope.patch.json.example'));

test('public plan pins three artifacts to one tested source and never authorizes deployment/grants',()=>{
 assert.equal(plan.mode,'preparation-only');assert.equal(plan.deploymentAuthorized,false);assert.equal(plan.deploymentReady,false);
 assert.equal(plan.scope.applied,false);assert.equal(plan.scope.directoryPreparation.created,false);assert.equal(plan.scope.createsOrApprovesGrant,false);
 assert.equal(plan.serviceIdentity.grantCreated,false);assert.equal(plan.serviceIdentity.approvalPerformed,false);
 assert.match(plan.source.sourceTree,/^[a-f0-9]{40}$/);assert.equal(plan.source.kind,'git-tree-snapshot-not-commit');
 for(const artifact of [plan.candidate.controlImage,plan.candidate.web,plan.candidate.worker]){assert.equal(artifact.sourceTree,plan.source.sourceTree);assert.match(artifact.archiveSHA256,/^[a-f0-9]{64}$/);assert.equal(artifact.deployed,false);}
 assert.notEqual(plan.candidate.controlImage.imageID,plan.baseline.controlImageID);assert.match(plan.candidate.controlImage.imageID,/^sha256:[a-f0-9]{64}$/);
 assert(!/(?:BEGIN [^-]*PRIVATE KEY|\bBearer\s|\bhsvc1\.)/.test(JSON.stringify(plan)));
});
test('only the explicit second test project can be proposed and existing sessions remain denied',()=>{
 assert.deepEqual(plan.scope,patch);assert.equal(patch.workerID,'worker-4090wsl2');
 assert.deepEqual(patch.expectedProjects,[{id:'automation-test',directory:'/home/dev/code/happy-automation-test',sessionIDs:[]}]);
 assert.deepEqual(patch.candidateProjects,[...patch.expectedProjects,{id:'automation-test-b',directory:'/home/dev/code/happy-automation-test-b',sessionIDs:[]}]);
 assert.deepEqual(patch.existingSessionIDs,[]);assert.equal(patch.preserveAllOtherFields,true);assert.equal(patch.directoryPreparation.plannedByUser,true);
 assert.deepEqual(patch.allowedChanges,['host.workers[matched workerID/userID/machineID].projects','worker.registration.projects']);
 assert(!JSON.stringify(patch).includes('agent-runtime-bridge'));
});
test('candidate project append fits real host/worker schemas without changing identities/providers/methods/expiry',async()=>{
 const {hostConfigSchema,workerConfigSchema}=await import('../../../packages/happy-agent/dist/automation/production/index.mjs');
 const host=templates().host,worker=JSON.parse(read('worker.json.example'));
 // Synthetic public encoding only. No private key, account/device or credential issuance.
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.alloc(32,9)]),format:'der',type:'spki'}).export({type:'spki',format:'pem'}).toString();
 host.clients[0].publicKey=key;host.workers[0].publicKey=key;host.clients[0].userID=patch.userID;host.workers[0].userID=patch.userID;host.workers[0].id=patch.workerID;host.workers[0].machineID=patch.machineID;
 worker.happyHomeDirectory='/fixture/happy';worker.registration={...structuredClone(host.workers[0])};
 const beforeHost=structuredClone(host),beforeWorker=structuredClone(worker);
 host.workers[0].projects=structuredClone(patch.candidateProjects);worker.registration.projects=structuredClone(patch.candidateProjects);
 assert.equal(hostConfigSchema.safeParse(host).success,true);assert.equal(workerConfigSchema.safeParse(worker).success,true);
 assert.deepEqual({...host.workers[0],projects:beforeHost.workers[0].projects},beforeHost.workers[0]);
 assert.deepEqual({...worker,registration:{...worker.registration,projects:beforeWorker.registration.projects}},beforeWorker);
 assert.deepEqual(host.clients,beforeHost.clients);assert.equal(host.maxGrantMs,beforeHost.maxGrantMs);
 assert.equal(hostConfigSchema.safeParse({...host,workers:[{...host.workers[0],token:'fixture-denied'}]}).success,false);
});
test('worker drop-in resets only executable/cwd and inherits original process-only/credential boundaries',()=>{
 const lines=read('multi-project-worker-release.conf.example').split('\n').filter(s=>s&&!s.startsWith('#'));
 assert.deepEqual(lines,['[Service]','WorkingDirectory='+plan.candidate.workerRelease+'/packages/happy-cli','ExecStart=','ExecStart='+plan.baseline.workerNodeExecutable+' '+plan.candidate.workerEntry+' --config /etc/happy-control/worker.json']);
 assert(read('worker.service.example').includes('KillMode=process'));assert.equal(plan.workerSwitchGuards.independentControllerRequired,true);assert.equal(plan.workerSwitchGuards.neverDeleteOrStealUnknownLocks,true);
 assert.equal(plan.workerSwitchGuards.realHostSwitchOrRollbackVerified,false);assert.equal(plan.baseline.refreshRequiredImmediatelyBeforeSwitch,true);
});
test('dedicated Compose settings preserve old gateway/config/state/PKI and no proxy/relay/native/MCP changes',()=>{
 const entries=Object.fromEntries(read('multi-project-settings.env.example').split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split('=')));
 assert.deepEqual(entries,{CONTROL_IMAGE:plan.candidate.controlImage.imageID,CONTROL_NGINX_IMAGE:plan.baseline.gatewayImageID,CONTROL_CONFIG_DIRECTORY:'/data/code/happy-control/config',CONTROL_STATE_DIRECTORY:'/data/code/happy-control/state',CONTROL_PKI_DIRECTORY:'/run/happy-control/pki'});
 for(const value of Object.values(plan.invariants))assert.equal(value,false);
 assert.equal(plan.rollback.restoreOldState,false);assert.equal(plan.rollback.oldRESTDowngradeAllowedByThisPlan,false);assert.equal(plan.rollback.preserveCurrentStateReceiptsProofsAndRevocations,true);
});
