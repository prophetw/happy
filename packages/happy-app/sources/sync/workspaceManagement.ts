import { workspaceCatalogSchema, workspaceDetailSchema, workspaceListSchema, workspaceMutationResultSchema,
    workspaceRequestReclaimSchema, workspaceReclaimProgressSchema, workspaceResultSchema, workspaceDeliveryReceiptSchema, workspaceDeliveryRequestSchema, type WorkspaceDeliveryRequest, workspaceTicketSchema, workspaceReadSchema, workspaceWriteSchema, workspaceOwnerRpcRequestSchema, WORKSPACE_OWNER_MACHINE_RPC, type WorkspaceOwnerRpcRequest,
    type WorkspaceRead, type WorkspaceWrite } from '@slopus/happy-wire';
import type { ZodType } from 'zod';
function decoded<T>(schema:ZodType<T>,raw:unknown):T {
    const result=schema.safeParse(raw);if(!result.success)throw Error('WORKSPACE_RESULT_UNKNOWN');return result.data;
}

export class WorkspaceManagerError extends Error {
    constructor(code:string,readonly rejected=false){super(code);}
}

type OwnerTransport = (request: WorkspaceOwnerRpcRequest) => Promise<{ status: number; body: unknown }>;

function unavailable(request: WorkspaceOwnerRpcRequest, readError: string) {
    return Error(request.route === 'write' || request.route === 'delivery' || request.route === 'reclaim' ? 'WORKSPACE_RESULT_UNKNOWN' : readError);
}

export function workspaceManagerClient(token: string, current: () => boolean, endpoint = '/api/workspace-owner/v1') {
    return workspaceClient(async request => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), request.route === 'delivery' ? 150_000 : 20_000);
        try {
            const response = await fetch(endpoint + '/' + request.route, {
                method: 'POST', signal: controller.signal, body: JSON.stringify(request.body),
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            });
            return { status: response.status, body: await response.json() };
        } catch {
            throw unavailable(request, 'WORKSPACE_MANAGER_UNAVAILABLE');
        } finally { clearTimeout(timer); }
    }, current);
}

type MachineRpc = (machineID: string, method: string, request: WorkspaceOwnerRpcRequest) => Promise<unknown>;

export function workspaceManagerRpcClient(machineID: string, current: () => boolean, rpc: MachineRpc) {
    return workspaceClient(async request => {
        let reply: unknown;
        try {
            reply = await rpc(machineID, WORKSPACE_OWNER_MACHINE_RPC, request);
        } catch (error) {
            if (error instanceof Error && /method not available|machine encryption not found/i.test(error.message)) {
                throw new WorkspaceManagerError('WORKSPACE_MACHINE_UNAVAILABLE', true);
            }
            throw unavailable(request, 'WORKSPACE_MACHINE_UNAVAILABLE');
        }
        if (!reply || typeof reply !== 'object' || !('status' in reply) || !('body' in reply) || typeof reply.status !== 'number') {
            throw unavailable(request, 'WORKSPACE_MACHINE_UNAVAILABLE');
        }
        return { status: reply.status, body: reply.body };
    }, current, machineID);
}

function workspaceClient(send: OwnerTransport, current: () => boolean, machineID?: string) {
    const request = async (route: WorkspaceOwnerRpcRequest['route'], body: unknown): Promise<unknown> => {
        if (!current()) throw Error('WORKSPACE_SCOPE_CHANGED');
        const input = workspaceOwnerRpcRequestSchema.parse({ route, body });
        if (machineID && 'machineID' in input.body && input.body.machineID !== machineID) throw Error('WORKSPACE_SCOPE_DENIED');
        const response = await send(input);
        if (!current()) throw Error('WORKSPACE_SCOPE_CHANGED');
        const result = response.body as { version?: unknown; ok?: unknown; data?: unknown; dispatch?: unknown; error?: { code?: unknown } } | null;
        if (response.status < 200 || response.status >= 300 || result?.version !== 1 || result.ok !== true) {
            const code = result?.error?.code;
            throw new WorkspaceManagerError(typeof code === 'string' && /^[A-Z_]{1,100}$/.test(code)
                ? code : 'WORKSPACE_MANAGER_UNAVAILABLE', response.status >= 400 && response.status < 500
                && result?.version === 1 && result.ok === false && result.dispatch === 'not_started');
        }
        return result.data;
    };
    const guidedRead = async (body: WorkspaceRead):Promise<unknown> => {
        try { return await request('read',workspaceReadSchema.parse(body)); }
        catch (error) {
            // Only retry an older endpoint's explicit schema rejection.
            if ('reclaim' in body && body.reclaim && error instanceof WorkspaceManagerError && error.message==='INVALID_REQUEST') {
                const {reclaim: _reclaim, ...older}=body;
                return guidedRead(older);
            }
            if (!('guidance' in body) || !body.guidance || !(error instanceof WorkspaceManagerError) || error.message!=='INVALID_REQUEST') throw error;
            const {guidance: _, ...legacy}=body;
            return request('read',workspaceReadSchema.parse(legacy));
        }
    };
    return {
        catalog: async () => {
            const catalog = decoded(workspaceCatalogSchema, await request('catalog', {}));
            if (machineID && catalog.machineID !== machineID) throw Error('WORKSPACE_SCOPE_DENIED');
            return catalog;
        },
        inventory: async (input: Extract<WorkspaceRead,{action:'inventory'|'delivery-inventory'}>) => {
            let data;
            try {
                data=decoded(workspaceListSchema,await guidedRead(input));
            } catch(error) {
                if(input.action!=='delivery-inventory'||!(error instanceof WorkspaceManagerError)||error.message!=='INVALID_REQUEST')throw error;
                const {machineID,projectID,limit,after,requestID}=input;
                if(requestID)return {total:0,returned:0,items:[],next:null};
                data=decoded(workspaceListSchema,await request('read',workspaceReadSchema.parse({action:'inventory',machineID,projectID,limit,after})));
            }
            if(data.items.some(item=>item.projectID!==input.projectID))throw Error('WORKSPACE_SCOPE_CHANGED');
            return data;
        },
        detail: async (input: Extract<WorkspaceRead,{action:'detail'}>) => {
            const data=decoded(workspaceDetailSchema,await guidedRead(input));
            if(data.item.id!==input.workspaceID||data.item.projectID!==input.projectID||data.plan.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return data;
        },
        result: async (input: Extract<WorkspaceRead,{action:'result'}>) => {
            const data = await request('read',workspaceReadSchema.parse(input));
            if(input.operationID){const result=decoded(workspaceMutationResultSchema,data);if(result.operationID!==input.operationID)throw Error('WORKSPACE_RESULT_UNKNOWN');return result;}
            const result=decoded(workspaceResultSchema,data);if(result.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return result;
        },
        deliver: async (input:WorkspaceDeliveryRequest) => {
            const data=decoded(workspaceDeliveryReceiptSchema,await request('delivery',workspaceDeliveryRequestSchema.parse(input)));
            if(data.operationID!==input.operationID) throw Error('WORKSPACE_RESULT_UNKNOWN');
            return data;
        },
        reclaim: async (input: {machineID:string;projectID:string;workspaceID:string}) =>
            decoded(workspaceReclaimProgressSchema,await request('reclaim',workspaceRequestReclaimSchema.parse(input))),
        plan: async (input: Extract<WorkspaceWrite,{action:'plan'}>) => {
            const data=decoded(workspaceTicketSchema,await request('write',workspaceWriteSchema.parse(input)));
            if(data.plan.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return data;
        },
        mutate: async (input: Exclude<WorkspaceWrite,{action:'plan'}>) => {
            const data = decoded(workspaceMutationResultSchema,await request('write',workspaceWriteSchema.parse(input)));
            if (data.operationID !== input.operationID) throw Error('WORKSPACE_RESULT_UNKNOWN');
            return data;
        },
    };
}
export type WorkspaceManagerClient = ReturnType<typeof workspaceManagerClient>;
