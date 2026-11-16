import Fastify from 'fastify';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { workspaceCatalogSchema, workspaceDetailSchema, workspaceListSchema, workspacePlanSchema,
    workspaceReadSchema, workspaceResultSchema, workspaceWriteSchema, workspaceOperationSchema, type WorkspaceWrite } from '@slopus/happy-wire';
import { happyOwnerVerifier, canonicalBody } from '../rest/auth';
import { MetadataStore } from '../rest/store';
import { ApiError } from '../rest/schema';
import { isServiceAuthorization } from '../rest/serviceTokens';
import { hash } from '../journal';
import { readWorkspaceOwnerConfig, workspaceOwnerScope, workspaceOwnerControlProjects } from './workspaceOwner';
import { readProductionConfig } from './config';

type JobReply = { ok: true; data: unknown } | { ok: false; error: { code: string } };
export type WorkspaceOwnerRunner = (ownerID: string, request: unknown, plan?: unknown, authorization?:string) => Promise<JobReply>;
type Intent = { ownerID: string; fingerprint: string; request: Exclude<WorkspaceWrite,{action:'plan'}>;
    status: 'pending'|'unknown'|'settled'; receipt?: z.infer<typeof workspaceOperationSchema>; error?: string; plan?: z.infer<typeof workspacePlanSchema> };
const base = '/api/workspace-owner/v1';
const beforeEffect = new Set(['WORKSPACE_MANAGER_BUSY','WORKSPACE_SCOPE_DENIED','OWNER_AUTH_REQUIRED','WORKSPACE_AUTHORIZATION_CHANGED',
    'WORKSPACE_PLAN_INVALID','WORKSPACE_PLAN_EXPIRED_OR_BLOCKED','WORKSPACE_PLAN_CHANGED','WORKSPACE_REVISION_CHANGED','WORKSPACE_HEAD_CHANGED',
    'WORKSPACE_UNSAVED_ARTIFACTS','WORKSPACE_NOT_IN_MAIN','WORKSPACE_NOT_UNCHANGED','WORKSPACE_EQUIVALENCE_UNCONFIRMED',
    'WORKSPACE_RESULT_UNCONFIRMED','WORKSPACE_MAIN_REMOTE_DIVERGED','WORKSPACE_DISPOSITION_NOT_AUTHORIZED','WORKSPACE_OPERATION_LIMIT']);
const storedIntentSchema=z.object({ownerID:z.string(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
    request:workspaceWriteSchema.refine(r=>r.action!=='plan'),status:z.enum(['pending','unknown','settled']),
    receipt:workspaceOperationSchema.optional(),error:z.string().optional(),plan:workspacePlanSchema.optional()}).strict();
const storedPlanSchema=z.object({ownerID:z.string(),machineID:z.string(),projectID:z.string(),workspaceID:z.string(),plan:workspacePlanSchema,expiresAt:z.number()}).strict();

/** Fixed child module, <=2 jobs. No Git/proc scan runs on the HTTP event loop. */
export function workspaceOwnerRunner(configFile: string, jobEntry: string): WorkspaceOwnerRunner {
    let running = 0;
    return (ownerID, request, plan, authorization) => {
        if (running >= 2) throw new ApiError('WORKSPACE_MANAGER_BUSY', 429);
        running++;
        return new Promise<JobReply>(resolve => {
            const child = fork(jobEntry, [], { stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env, HAPPY_WORKSPACE_OWNER_JOB: '1' } });
            let done = false,released=false;
            const release=()=>{if(!released){released=true;running--;}};
            const finish = (result: JobReply) => { if (!done) { done = true; resolve(result); } };
            child.once('error', () => {release();finish({ ok: false, error: { code: 'WORKSPACE_RESULT_UNKNOWN' } });});
            child.once('exit', () => {release();finish({ ok: false, error: { code: 'WORKSPACE_RESULT_UNKNOWN' } });});
            child.once('message', result => finish(result as JobReply));
            child.send({ configFile, ownerID, request, plan, authorization });
        });
    };
}

/** Browser owner control plane. Bearer is verified with the same Relay verifier
 * as Control owner routes, never persisted/logged/delegated to a model. A fixed
 * trusted backend child receives it only in private IPC for final authorization. */
export function createWorkspaceOwnerApi(options: { configFile: string; jobEntry: string; verifyOwner?: (authorization: string|undefined) => Promise<string>;
    verifyControl?: (authorization:string|undefined,ownerID:string)=>Promise<string[]>; run?: WorkspaceOwnerRunner; now?: () => number }) {
    const config = readWorkspaceOwnerConfig(options.configFile), now = options.now ?? Date.now;
    // Read only registration to select the account verifier; no signing keys loaded.
    const worker = readProductionConfig(config.workerConfig);
    if (worker.role !== 'worker') throw new ApiError('WORKSPACE_SCOPE_DENIED', 403);
    const verifyOwner = options.verifyOwner ?? happyOwnerVerifier(worker.relayURL);
    const verifyControl=options.verifyControl??((authorization,ownerID)=>workspaceOwnerControlProjects(options.configFile,authorization,ownerID));
    const run = options.run ?? workspaceOwnerRunner(options.configFile, options.jobEntry);
    const plans = new MetadataStore(join(config.stateDirectory, 'plans'), 128 * 1024);
    const intents = new MetadataStore(join(config.stateDirectory, 'intents'), 128 * 1024);
    const active = new Map<string, Promise<unknown>>(), reads = new Set<Promise<unknown>>();
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    const owners = new WeakMap<object,string>();
    const allowedProjects = new WeakMap<object,Set<string>>();
    const admitted = new WeakSet<object>();
    const limits=new Map<string,{count:number;until:number}>();
    const readIntent=(key:string):Intent|null=>{const value=intents.get<unknown>(key);return value?storedIntentSchema.parse(value) as Intent:null;};
    app.addHook('onRequest', async (req, reply) => {
        reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
        if (req.url === '/health') return;
        // All management routes are POST. A fixture may mount public GET assets;
        // production has no file-serving route and unknown paths remain 404.
        if (req.method === 'GET') return;
        const old=limits.get(req.ip),limit=old&&old.until>now()?old:{count:0,until:now()+60000};
        if(++limit.count>240)throw new ApiError('RATE_LIMITED',429);limits.set(req.ip,limit);
        if(limits.size>1000)for(const [key,value]of limits)if(value.until<now())limits.delete(key);
        if (!config.origins.includes(req.headers.origin ?? '')) throw new ApiError('OWNER_ORIGIN_REQUIRED',403);
        if (req.headers.authorization?.startsWith('Happy')||isServiceAuthorization(req.headers.authorization)) throw new ApiError('OWNER_AUTH_REQUIRED',401);
        const ownerID = await verifyOwner(req.headers.authorization);
        workspaceOwnerScope(options.configFile, ownerID); owners.set(req, ownerID);
        allowedProjects.set(req,new Set(await verifyControl(req.headers.authorization,ownerID)));
    });
    app.setErrorHandler((error,req,reply) => {
        const code = error instanceof ApiError ? error.code : error instanceof ZodError ? 'INVALID_REQUEST' : 'WORKSPACE_INSPECTION_UNCONFIRMED';
        reply.code(error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 503).send({ version:1,ok:false,error:{code},dispatch:admitted.has(req)?'unknown':'not_started' });
    });
    app.setNotFoundHandler((_req,reply) => reply.code(404).send({ version:1,ok:false,error:{code:'NOT_FOUND'} }));
    const ok = (data: unknown) => ({ version:1,ok:true,data });
    const scope = (ownerID: string, request: { machineID:string;projectID:string }, allowed?:Set<string>) => {
        const s = workspaceOwnerScope(options.configFile,ownerID);
        if (request.machineID !== s.worker.registration.machineID || !s.projects.some(p=>p.id===request.projectID) || allowed&&!allowed.has(request.projectID)) throw new ApiError('WORKSPACE_SCOPE_DENIED',403);
        return s;
    };
    const execute = async (ownerID: string, request: unknown, plan?: unknown,authorization?:string) => {
        const job = run(ownerID,request,plan,authorization); reads.add(job);
        let result: JobReply;
        try { result = await job; } finally { reads.delete(job); }
        if (!result.ok) throw new ApiError(result.error.code,409);
        return result.data;
    };
    app.get('/health', async () => ({ service:'workspace-owner',contractVersion:1,sourceSHA:process.env.HAPPY_WORKSPACE_SOURCE_SHA ?? 'development',activeJobs:reads.size }));
    app.post(`${base}/catalog`,async req => {
        const s = workspaceOwnerScope(options.configFile,owners.get(req)!);
        return ok(workspaceCatalogSchema.parse({ ownerID:owners.get(req)!, machineID:s.worker.registration.machineID,machineName:s.worker.registration.name,automaticGC:false,
            projects:s.projects.filter(p=>allowedProjects.get(req)!.has(p.id)).map(p=>({id:p.id,name:p.name,allowApply:p.policy.allowApply,allowArchive:p.policy.allowArchive,allowDiscard:p.policy.allowDiscard})) }));
    });
    app.post(`${base}/read`,async req => {
        const request=workspaceReadSchema.parse(req.body),ownerID=owners.get(req)!;scope(ownerID,request,allowedProjects.get(req));
        const data=await execute(ownerID,request,undefined,req.headers.authorization);
        scope(ownerID,request,new Set(await verifyControl(req.headers.authorization,ownerID)));
        if(request.action==='inventory')return ok(workspaceListSchema.parse(data));
        if(request.action==='detail')return ok(workspaceDetailSchema.parse(data));
        const result=workspaceResultSchema.parse(data);
        if(request.operationID) {
            const intent=readIntent(`operation:${ownerID}:${request.operationID}`);
            if(intent && (intent.request.machineID!==request.machineID||intent.request.projectID!==request.projectID||intent.request.workspaceID!==request.workspaceID))throw new ApiError('WORKSPACE_SCOPE_DENIED',403);
            return ok({operationID:request.operationID,status:result.operation?(result.operation.state==='applying'?'unknown':'settled')
                :active.has(`operation:${ownerID}:${request.operationID}`)?'pending':intent?.status==='settled'?'settled':'unknown',receipt:result.operation??intent?.receipt,error:intent?.error});
        }
        return ok(result);
    });
    app.post(`${base}/write`,async req => {
        const request=workspaceWriteSchema.parse(req.body),ownerID=owners.get(req)!;scope(ownerID,request,allowedProjects.get(req));
        if(request.action==='plan') {
            plans.pruneExpired(now());
            if(plans.list('proof:').length>=100)throw new ApiError('WORKSPACE_PLAN_LIMIT',429);
            const plan=workspacePlanSchema.parse(await execute(ownerID,request,undefined,req.headers.authorization)),ticket=randomUUID();
            scope(ownerID,request,new Set(await verifyControl(req.headers.authorization,ownerID)));
            plans.set(`proof:${ticket}`,{ownerID,machineID:request.machineID,projectID:request.projectID,workspaceID:request.workspaceID,plan,expiresAt:plan.expiresAt});
            return ok({ticket,plan});
        }
        const key=`operation:${ownerID}:${request.operationID}`,fp=hash(canonicalBody(request));
        let intent=readIntent(key);
        if(intent)admitted.add(req);
        if(intent && intent.fingerprint!==fp)throw new ApiError('WORKSPACE_OPERATION_CONFLICT',409);
        if(intent?.status==='settled')return ok({operationID:request.operationID,status:intent.status,receipt:intent.receipt,error:intent.error});
        if(active.has(key))return active.get(key);
        let plan: unknown;
        if(request.action==='apply') {
            const raw=plans.get<unknown>(`proof:${request.ticket}`),saved=raw?storedPlanSchema.parse(raw):null;
            if(saved && (saved.ownerID!==ownerID||saved.machineID!==request.machineID||saved.projectID!==request.projectID||saved.workspaceID!==request.workspaceID))throw new ApiError('WORKSPACE_PLAN_INVALID',409);
            plan=saved?.plan ?? intent?.plan;
            if(!plan||workspacePlanSchema.parse(plan).id!==request.confirmedPlanID)throw new ApiError('WORKSPACE_PLAN_INVALID',409);
            if(now()>workspacePlanSchema.parse(plan).expiresAt && !intent)throw new ApiError('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED',409);
        }
        const previouslyUncertain=!!intent;
        if(!intent) {
            if(intents.list('operation:').length>=2000)throw new ApiError('WORKSPACE_OPERATION_LIMIT',409);
            intent={ownerID,fingerprint:fp,request,status:'pending',...(request.action==='apply'?{plan:workspacePlanSchema.parse(plan)}:{})};
            if(!intents.claim(key,intent))throw new ApiError('WORKSPACE_OPERATION_CONFLICT',409);
        }
        admitted.add(req);
        const current=intent;
        const promise=(async()=>{
            try {current.receipt=workspaceOperationSchema.parse(await execute(ownerID,request,plan,req.headers.authorization));current.status=current.receipt.state==='applying'?'unknown':'settled';}
            catch(error) {current.status=!previouslyUncertain&&error instanceof ApiError&&beforeEffect.has(error.code)?'settled':'unknown';current.error=error instanceof ApiError?error.code:'WORKSPACE_RESULT_UNKNOWN';}
            intents.set(key,current);
            // Revocation/account/project changes while a job ran do not return content.
            scope(ownerID,request,new Set(await verifyControl(req.headers.authorization,ownerID)));
            return ok({operationID:request.operationID,status:current.status,receipt:current.receipt,error:current.error});
        })().finally(()=>active.delete(key));
        active.set(key,promise);return promise;
    });
    app.addHook('onClose',async()=>{await Promise.allSettled([...active.values(),...reads]);});
    return app;
}
