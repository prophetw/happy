import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const directory=dirname(fileURLToPath(import.meta.url));
const digest=/^[a-f0-9]{64}$/,image=/^sha256:[a-f0-9]{64}$/,gitObject=/^[a-f0-9]{40}$/,id=/^[A-Za-z0-9_-]{1,128}$/;
const methods=['machines.list','sessions.list','tasks.create','requests.get','sessions.send','sessions.status','sessions.logs','sessions.result','sessions.cancel'];
const strict=(value,keys)=>assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join(),'INVALID_PUBLIC_PLAN_FIELDS');
const unresolved=value=>value===null||(typeof value==='string'&&value.includes('REPLACE_'));
export function rolloutTemplate(){return JSON.parse(readFileSync(join(directory,'service-token-rollout.json.example'),'utf8'));}
/** Pure public-data inspection. No network, shell, credential discovery, artifact deployment or implicit approval. */
export function reviewServiceTokenPlan(plan){
 assert(!/(?:BEGIN [^-]*PRIVATE KEY|\bBearer\s|\bhsvc1\.)/.test(JSON.stringify(plan)),'NO_CREDENTIALS_IN_PLAN');
 strict(plan,['version','mode','origin','applicationSource','baseline','candidate','paths','hostPatch','proposedAcceptanceScope','invariants','externalBackend']);
 assert(plan.version===1&&plan.mode==='review-only'&&plan.origin==='https://szsp.suitbim.com.cn:7100','INVALID_SITE_PLAN');
 strict(plan.applicationSource,['kind','tree','baseCommit','localValidation']);
 assert(plan.applicationSource.kind==='git-tree-snapshot-not-commit'&&gitObject.test(plan.applicationSource.tree)&&gitObject.test(plan.applicationSource.baseCommit),'FIXED_SOURCE_REQUIRED');
 assert(plan.applicationSource.localValidation==='validation.service-token-local-2026-11-04.json','LOCAL_EVIDENCE_REQUIRED');
 strict(plan.baseline,['liveRecheckedThisPreparation','evidence','controlHost','proxyHost','workerHost','controlImageID','gatewayImageID','webTarget','webIndexSHA256']);
 assert(plan.baseline.liveRecheckedThisPreparation===false,'THIS_CHECK_DOES_NOT_VERIFY_LIVE_STATE');
 assert(plan.baseline.controlHost==='192.168.99.55'&&plan.baseline.proxyHost==='192.168.99.57'&&plan.baseline.workerHost==='4090Wsl2','SITE_BOUNDARY_CHANGED');
 assert(Array.isArray(plan.baseline.evidence)&&plan.baseline.evidence.length>0&&plan.baseline.evidence.every(f=>/^validation\.[A-Za-z0-9.-]+\.json$/.test(f)),'INVALID_EVIDENCE_PATH');
 assert(image.test(plan.baseline.controlImageID)&&image.test(plan.baseline.gatewayImageID)&&digest.test(plan.baseline.webIndexSHA256),'BASELINE_PIN_REQUIRED');
 strict(plan.candidate,['imageReferenceKind','controlImageID','controlImageArchiveSHA256','webArchiveSHA256','webIndexSHA256','webTarget']);
 assert(plan.candidate.imageReferenceKind==='local-docker-image-id-pull-never','IMAGE_ID_IS_NOT_A_REGISTRY_MANIFEST_DIGEST');
 assert(plan.candidate.controlImageID===null||plan.candidate.controlImageID!==plan.baseline.controlImageID,'NEW_CONTROL_IMAGE_REQUIRED');
 for(const [key,value]of Object.entries(plan.candidate)){
  if(['imageReferenceKind','webTarget'].includes(key)||value===null)continue;
  assert((key==='controlImageID'?image:digest).test(value),'INVALID_CANDIDATE_PIN');
 }
 const target=/^\.happy-releases\/[A-Za-z0-9_-]+$/;
 assert(target.test(plan.baseline.webTarget)&&target.test(plan.candidate.webTarget)&&plan.candidate.webTarget!==plan.baseline.webTarget,'ISOLATED_WEB_TARGET_REQUIRED');
 strict(plan.paths,['controlUnit','releaseLink','hostConfig','deployEnv','stateDirectory','runtimePKI','webLink','webArtifacts']);
 assert.deepEqual(plan.paths,{controlUnit:'happy-control-pair.service',releaseLink:'/data/code/happy-control/release',hostConfig:'/data/code/happy-control/config/host.json',deployEnv:'/etc/happy-control/deploy.env',stateDirectory:'/data/code/happy-control/state',runtimePKI:'/run/happy-control/pki',webLink:'/root/bim-engine/web/html/happy',webArtifacts:'/root/bim-engine/script/happy-web-artifacts'},'EXISTING_PATHS_MUST_BE_PRESERVED');
 strict(plan.hostPatch,['serviceTokens']);strict(plan.hostPatch.serviceTokens,['maxGrantMs','clients']);
 const service=plan.hostPatch.serviceTokens;
 assert(Number.isSafeInteger(service.maxGrantMs)&&service.maxGrantMs>=1000&&service.maxGrantMs<=2592000000,'SERVICE_GRANT_LIMIT_EXCEEDED');
 assert(Array.isArray(service.clients)&&service.clients.length>0&&new Set(service.clients.map(c=>c.id)).size===service.clients.length,'UNIQUE_SERVICE_IDENTITIES_REQUIRED');
 for(const client of service.clients){strict(client,['id','userID','name','generation']);assert(id.test(client.id)&&id.test(client.userID)&&id.test(client.generation)&&typeof client.name==='string'&&client.name.length>0&&client.name.length<=128,'INVALID_SERVICE_IDENTITY');}
 strict(plan.proposedAcceptanceScope,['approved','workerID','machineID','projectID','projectRealpath','methods','sessionIDs','recommendedInitialGrantMs']);
 const scope=plan.proposedAcceptanceScope;
 assert(scope.approved===false,'A_PLAN_CANNOT_APPROVE_A_GRANT');
 assert(scope.workerID==='worker-4090wsl2'&&scope.machineID==='9c2c1c7e-28f3-4e9c-a77a-3064f31c3386'&&scope.projectID==='automation-test'&&scope.projectRealpath==='/home/dev/code/happy-automation-test','ONLY_EXISTING_ISOLATED_ACCEPTANCE_SCOPE');
 assert(Array.isArray(scope.methods)&&scope.methods.length>0&&new Set(scope.methods).size===scope.methods.length&&scope.methods.every(m=>methods.includes(m)),'INVALID_METHOD_SCOPE');
 assert(Array.isArray(scope.sessionIDs)&&scope.sessionIDs.length===0,'EXISTING_SESSIONS_NOT_AUTHORIZED');
 assert(Number.isSafeInteger(scope.recommendedInitialGrantMs)&&scope.recommendedInitialGrantMs>=1000&&scope.recommendedInitialGrantMs<=3600000&&scope.recommendedInitialGrantMs<=service.maxGrantMs,'FINITE_SHORT_CANARY_REQUIRED');
 assert.deepEqual(plan.invariants,{signedMaxGrantMs:3600000,restBind:'127.0.0.1:9010',privateGatewayBind:'192.168.99.55:9011',routePrefix:'/happy-control/v1/',reuseExistingTLS:true,changeProxyRoutes:false,restartOrRecreateExistingNginx:false,restartOrRecreateRelay:false,updateWorker:false,registerMcp:false,preferredRecovery:'revoke-services-keep-new-binary',downgradeRequiresStateCompatibilityTest:true,preserveCurrentStateAndRevocationsOnRollback:true,revokeServiceGrantsBeforeDowngrade:true,rollbackConfigAndImageTogether:true},'ROLLOUT_BOUNDARY_OR_ROLLBACK_GUARD_CHANGED');
 strict(plan.externalBackend,['secretProvider','secureDeliveryChannel','credentialsProvidedInChatOrURL']);assert(plan.externalBackend.credentialsProvidedInChatOrURL===false,'NO_CREDENTIALS_IN_PLAN');
 for(const name of ['secretProvider','secureDeliveryChannel'])assert(plan.externalBackend[name]===null||id.test(plan.externalBackend[name]),'PUBLIC_CONFIGURATION_REFERENCE_ONLY');
 const missing=[];
 function scan(value,prefix=''){
  if(unresolved(value)){missing.push(prefix);return;}
  if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))scan(child,prefix?prefix+'.'+key:key);
 }
 scan(plan);
 // Even fully filled public metadata is not deployment authorization or a successful live preflight.
 return {publicPlanValid:true,publicPlanComplete:missing.length===0,deploymentReady:false,mode:'review-only',missingFields:missing,
  requires:['explicit deployment authorization','live baseline/TLS/network and worker scope verification','immutable artifact load/build verification','real identity and scope approval','backend secret-provider and secure handoff verification'],serverContacted:false,secretsRead:false,realGrantCreated:false};
}
export function serviceHostPatch(plan){const result=reviewServiceTokenPlan(plan);assert(result.publicPlanComplete,'PUBLIC_PLAN_INCOMPLETE');return structuredClone(plan.hostPatch);}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const [operation,file,...extra]=process.argv.slice(2);assert(extra.length===0&&['--review','--host-patch'].includes(operation),'READ_ONLY_OPERATION_REQUIRED');const plan=file?JSON.parse(readFileSync(file,'utf8')):rolloutTemplate();const result=operation==='--review'?reviewServiceTokenPlan(plan):serviceHostPatch(plan);process.stdout.write(JSON.stringify(result,null,2)+'\n');}
 catch{process.stderr.write(JSON.stringify({ok:false,code:'SERVICE_TOKEN_PLAN_REJECTED',serverContacted:false,secretsRead:false})+'\n');process.exitCode=1;}
}
