import { workspaceCatalogSchema, workspaceDetailSchema, workspaceListSchema, workspaceMutationResultSchema,
    workspaceResultSchema, workspaceDeliveryReceiptSchema, workspaceDeliveryRequestSchema, type WorkspaceDeliveryRequest, workspaceTicketSchema, workspaceReadSchema, workspaceWriteSchema, type WorkspaceRead, type WorkspaceWrite } from '@slopus/happy-wire';
import type { ZodType } from 'zod';
function decoded<T>(schema:ZodType<T>,raw:unknown):T {
    const result=schema.safeParse(raw);if(!result.success)throw Error('WORKSPACE_RESULT_UNKNOWN');return result.data;
}

export class WorkspaceManagerError extends Error {
    constructor(code:string,readonly rejected=false){super(code);}
}

export function workspaceManagerClient(token: string, current: () => boolean, endpoint = '/api/workspace-owner/v1') {
    const request = async (path: string, body: unknown, timeout=20_000): Promise<unknown> => {
        if (!current()) throw Error('WORKSPACE_SCOPE_CHANGED');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(endpoint + path, { method: 'POST', signal: controller.signal,
                headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body:JSON.stringify(body) });
            if (!current()) throw Error('WORKSPACE_SCOPE_CHANGED');
            let result: { version?: unknown; ok?: unknown; data?: unknown; dispatch?:unknown; error?: { code?: unknown } };
            try { result = await response.json(); } catch { throw Error('WORKSPACE_MANAGER_UNAVAILABLE'); }
            if (!response.ok || result.version !== 1 || result.ok !== true) throw new WorkspaceManagerError(typeof result.error?.code === 'string'
                && /^[A-Z_]{1,100}$/.test(result.error.code) ? result.error.code : 'WORKSPACE_MANAGER_UNAVAILABLE',
                response.status>=400&&response.status<500&&result.version===1&&result.ok===false&&result.dispatch==='not_started');
            return result.data;
        } finally { clearTimeout(timer); }
    };
    return {
        catalog: async () => decoded(workspaceCatalogSchema,await request('/catalog', {})),
        inventory: async (input: Extract<WorkspaceRead,{action:'inventory'|'delivery-inventory'}>) => {
            let data;
            try {
                data=decoded(workspaceListSchema,await request('/read',workspaceReadSchema.parse(input)));
            } catch(error) {
                if(input.action!=='delivery-inventory'||!(error instanceof WorkspaceManagerError)||error.message!=='INVALID_REQUEST')throw error;
                const {machineID,projectID,limit,after,requestID}=input;
                if(requestID)return {total:0,returned:0,items:[],next:null};
                data=decoded(workspaceListSchema,await request('/read',workspaceReadSchema.parse({action:'inventory',machineID,projectID,limit,after})));
            }
            if(data.items.some(item=>item.projectID!==input.projectID))throw Error('WORKSPACE_SCOPE_CHANGED');
            return data;
        },
        detail: async (input: Extract<WorkspaceRead,{action:'detail'}>) => {
            const data=decoded(workspaceDetailSchema,await request('/read',workspaceReadSchema.parse(input)));
            if(data.item.id!==input.workspaceID||data.item.projectID!==input.projectID||data.plan.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return data;
        },
        result: async (input: Extract<WorkspaceRead,{action:'result'}>) => {
            const data = await request('/read',workspaceReadSchema.parse(input));
            if(input.operationID){const result=decoded(workspaceMutationResultSchema,data);if(result.operationID!==input.operationID)throw Error('WORKSPACE_RESULT_UNKNOWN');return result;}
            const result=decoded(workspaceResultSchema,data);if(result.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return result;
        },
        deliver: async (input:WorkspaceDeliveryRequest) => {
            const data=decoded(workspaceDeliveryReceiptSchema,await request('/delivery',workspaceDeliveryRequestSchema.parse(input),150_000));
            if(data.operationID!==input.operationID) throw Error('WORKSPACE_RESULT_UNKNOWN');
            return data;
        },
        plan: async (input: Extract<WorkspaceWrite,{action:'plan'}>) => {
            const data=decoded(workspaceTicketSchema,await request('/write',workspaceWriteSchema.parse(input)));
            if(data.plan.workspaceID!==input.workspaceID)throw Error('WORKSPACE_SCOPE_CHANGED');return data;
        },
        mutate: async (input: Exclude<WorkspaceWrite,{action:'plan'}>) => {
            const data = decoded(workspaceMutationResultSchema,await request('/write',workspaceWriteSchema.parse(input)));
            if (data.operationID !== input.operationID) throw Error('WORKSPACE_RESULT_UNKNOWN');
            return data;
        },
    };
}
export type WorkspaceManagerClient = ReturnType<typeof workspaceManagerClient>;
