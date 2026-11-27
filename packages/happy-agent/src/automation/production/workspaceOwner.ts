import { z } from 'zod';
import { workspacePolicySchema, type ActivityProbe } from '../rest/workspaceLifecycle';
import { privateRead } from '../rest/privateFs';
import { readProductionConfig } from './config';
import { ApiError, directoryAllowed, directoryProjectID } from '../rest/schema';
import { isServiceAuthorization } from '../rest/serviceTokens';
import { canonicalBody } from '../rest/auth';
import { openWorkspaceLifecycle } from './workspaces';
import { workspaceReadSchema, workspaceWriteSchema, workspaceDeliveryRequestSchema } from '@slopus/happy-wire';

const absolute = z.string().startsWith('/').max(4096);
export const workspaceOwnerConfigSchema = z.object({ version: z.literal(1), workerConfig: absolute, stateDirectory: absolute,
    homeDirectory: absolute.optional(),
    processProbeSocket: absolute.optional(),
    listen: z.object({ host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535) }).strict(),
    origins: z.array(z.string().url().refine(s => new URL(s).origin === s)).min(1).max(10),
    projects: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), name: z.string().min(1).max(100), policyFile: absolute }).strict()).min(1).max(50),
}).strict();
export function readWorkspaceOwnerConfig(file: string) {
    return workspaceOwnerConfigSchema.parse(JSON.parse(privateRead(file, 32768).toString('utf8')));
}
/** Re-read registration/policy for every authenticated request and every child job. */
export function workspaceOwnerScope(file: string, ownerID: string) {
    const config = readWorkspaceOwnerConfig(file), worker = readProductionConfig(config.workerConfig);
    if (worker.role !== 'worker' || worker.registration.userID !== ownerID) throw new ApiError('WORKSPACE_SCOPE_DENIED', 403);
    const projects = config.projects.map(project => {
        const policy = workspacePolicySchema.parse(JSON.parse(privateRead(project.policyFile, 32768).toString('utf8')));
        const known=worker.registration.projects.find(p=>p.directory===policy.root);
        if (policy.projectID !== project.id || policy.machineID !== worker.registration.machineID
            || !(known?known.id===policy.projectID:worker.registration.directorySelection&&directoryAllowed(policy.root,worker.registration.directorySelection.roots)
                &&policy.projectID===directoryProjectID(policy.root))) throw new ApiError('WORKSPACE_SCOPE_DENIED', 403);
        return { ...project, policy };
    });
    return { config, worker, projects };
}
/** Existing Control owner-management scope, including live signed Worker
 * capability projection. This never creates a connection, grant or task. */
export async function workspaceOwnerControlProjects(file:string,authorization:string|undefined,ownerID:string,readOnly=false) {
    if(!authorization?.startsWith('Bearer ')||isServiceAuthorization(authorization))throw new ApiError('OWNER_AUTH_REQUIRED',401);
    const scope=workspaceOwnerScope(file,ownerID),endpoint=new URL(scope.worker.endpoint);
    let response:Response;
    try {response=await fetch(endpoint.href.replace(/\/$/,'')+'/service-connections/options',{
        headers:{authorization,origin:endpoint.origin},redirect:'error',signal:AbortSignal.timeout(10000) as NonNullable<Parameters<typeof fetch>[1]>['signal'],
    });}catch{throw new ApiError('WORKSPACE_CONTROL_UNAVAILABLE',503);}
    if(!response.ok)throw new ApiError('WORKSPACE_CONTROL_UNAVAILABLE',503);
    const worker=z.object({id:z.string(),machineID:z.string(),projects:z.array(z.object({id:z.string(),directory:z.string()})).max(100),
        directorySelection:z.object({roots:z.array(z.string()).max(100)}).optional(),directoryScopes:z.literal(1).optional(),projectScopes:z.literal(1).optional()});
    let result:{data:{workers:z.infer<typeof worker>[]}};
    try {result=z.object({version:z.literal(1),ok:z.literal(true),data:z.object({workers:z.array(worker).max(100)})}).parse(await response.json());}
    catch{throw new ApiError('WORKSPACE_CONTROL_UNAVAILABLE',503);}
    const remote=result.data.workers.find(w=>w.id===scope.worker.registration.id&&w.machineID===scope.worker.registration.machineID);
    if(!remote||!readOnly&&!remote.projectScopes&&!remote.directoryScopes)throw new ApiError('WORKSPACE_CONTROL_UNAVAILABLE',503);
    return scope.projects.filter(p=>{
        const known=remote.projects.find(x=>x.directory===p.policy.root);
        return known?known.id===p.id:(readOnly||remote.directoryScopes===1)&&remote.directorySelection&&directoryAllowed(p.policy.root,remote.directorySelection.roots)
            &&p.id===directoryProjectID(p.policy.root);
    }).map(p=>p.id);
}
export async function executeWorkspaceOwnerJob(file: string, ownerID: string, raw: unknown, plan?: unknown, dependencies: { activity?: ActivityProbe;authorize?:()=>Promise<void> } = {}) {
    const read = workspaceReadSchema.safeParse(raw), delivery=workspaceDeliveryRequestSchema.safeParse(raw);
    const request = read.success ? read.data : delivery.success ? delivery.data : workspaceWriteSchema.parse(raw);
    const scope = workspaceOwnerScope(file, ownerID), project = scope.projects.find(p => p.id === request.projectID);
    if (!project || request.machineID !== scope.worker.registration.machineID) throw new ApiError('WORKSPACE_SCOPE_DENIED', 403);
    const validateLocal=()=>{
        const latest=workspaceOwnerScope(file,ownerID),policy=latest.projects.find(p=>p.id===request.projectID)?.policy;
        if(latest.worker.registration.machineID!==request.machineID||!policy||canonicalBody(policy)!==canonicalBody(project.policy))throw new ApiError('WORKSPACE_AUTHORIZATION_CHANGED',403);
    };
    const { lifecycle } = openWorkspaceLifecycle(scope.config.workerConfig, project.policyFile, {
        homeDirectory: scope.config.homeDirectory,
        activity: dependencies.activity,
        processProbeSocket: scope.config.processProbeSocket,
        readOnly: ['inventory','delivery-inventory','detail','result','plan'].includes(request.action),
        ownerDirectorySelection:true,authorizationCurrent:validateLocal,
        authorize: async () => {
            validateLocal();await dependencies.authorize?.();validateLocal();
        },
    });
    if (request.action === 'inventory') {
        const page = await lifecycle.inventory(request.limit, request.after);
        const items = [];
        for (const item of page.items) {
            const plan = await lifecycle.plan(item.id);
            items.push({ ...lifecycle.overview(item.id), plan, reasons: plan.reasons, lastVerification: plan.checkedAt });
        }
        return { total: page.total, returned: items.length, next: page.next, items };
    }
    if (request.action === 'delivery-inventory') return lifecycle.deliveryInventory(request.limit,request.after,request.view,request.requestID);
    if (request.action === 'detail') return lifecycle.detail(request.workspaceID);
    if (request.action === 'result') return lifecycle.result(request.workspaceID, request.operationID, true);
    if (request.action === 'plan') return lifecycle.plan(request.workspaceID);
    if (request.action === 'adopt') return lifecycle.adopt(request.workspaceID, request.operationID, request.revision, request.head);
    if (request.action === 'resolve') return lifecycle.resolve(request.workspaceID, { operationID: request.operationID,
        expectedRevision: request.revision, head: request.head, kind: request.kind, source: `owner-ui:${request.operationID}` });
    if (request.action === 'finalize-integrated') return lifecycle.finalizeIntegrated(request.workspaceID, request.operationID, request.head, request.evidence, ownerID);
    if (request.action==='start-delivery'||request.action==='resume-delivery') return lifecycle.deliver(request,ownerID);
    return lifecycle.apply(plan as Parameters<typeof lifecycle.apply>[0], request.operationID);
}
