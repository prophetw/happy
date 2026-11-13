import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hash } from '../journal';
import type { ControlClient } from './client';
import { ApiError, identifier, scopeSchema, taskTitleSchema } from './schema';
import { executionSchema } from './execution';
import { taskOptionsSchema } from './options';
import { loadControlSkills } from './skills';

const page = { cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(200).optional() };
const events = { sessionID: identifier, after_seq: z.number().int().nonnegative().optional(), cursor: z.string().min(1).max(256).optional(), limit: z.number().int().min(1).max(500).optional() };
export const toolContracts = {
    happy_connection: { method: 'GET', schema: z.object({}).strict(), route: (_: any, grantID: string) => `/connections/${identifier.parse(grantID)}` },
    happy_machines: { method: 'GET', schema: z.object(page).strict(), route: (_: any) => '/machines', query: true },
    happy_projects: { method: 'GET', schema: z.object({}).strict(), route: (_: any) => '/projects' },
    happy_sessions: { method: 'GET', schema: z.object(page).strict(), route: (_: any) => '/sessions', query: true },
    happy_create_task: { method: 'POST', schema: z.object({ requestID: identifier, machineID: identifier, projectID: identifier, title: taskTitleSchema.optional(), options: taskOptionsSchema.optional(), execution: executionSchema.optional() }).strict(), route: (_: any) => '/tasks' },
    happy_options: { method: 'GET', schema: z.object({ machineID: identifier }).strict(), route: (_: any) => '/options', query: true },
    happy_send: { method: 'POST', schema: z.object({ sessionID: identifier, requestID: identifier, text: z.string().min(1).max(100000) }).strict(), route: (a: any) => `/sessions/${a.sessionID}/messages`, omit: 'sessionID' },
    happy_status: { method: 'GET', schema: z.object(events).strict(), route: (a: any) => `/sessions/${a.sessionID}/status`, query: true, omit: 'sessionID' },
    happy_events: { method: 'GET', schema: z.object(events).strict(), route: (a: any) => `/sessions/${a.sessionID}/events`, query: true, omit: 'sessionID' },
    happy_result: { method: 'GET', schema: z.object({ ...events, turnID: identifier }).strict(), route: (a: any) => `/sessions/${a.sessionID}/result`, query: true, omit: 'sessionID' },
    happy_cancel: { method: 'POST', schema: z.object({ sessionID: identifier, requestID: identifier, sendRequestID: identifier.optional() }).strict(), route: (a: any) => `/sessions/${a.sessionID}/cancel`, omit: 'sessionID' },
    happy_request_status: { method: 'GET', schema: z.object({ requestID: identifier }).strict(), route: (a: any) => `/requests/${a.requestID}`, omit: 'requestID' },
} as const;
export async function callControlTool(client: ControlClient, grantID: string, name: keyof typeof toolContracts, input: unknown) {
    const contract = toolContracts[name];
    if (!contract) throw new Error('UNKNOWN_TOOL');
    const args = contract.schema.parse(input) as Record<string, unknown>, values = { ...args };
    if ('omit' in contract) delete values[contract.omit];
    let route = contract.route(args, grantID);
    if ('query' in contract && contract.query) {
        const query = new URLSearchParams(Object.entries(values).filter(([,v]) => v !== undefined).map(([k,v]) => [k, String(v)] as [string, string]));
        if (query.size) route += `?${query}`;
    }
    return client.request(contract.method, route, contract.method === 'POST' ? values : undefined, grantID);
}
/** Create/send stay two durable operations, with deterministic child IDs visible on uncertainty. */
export async function startTask(client: ControlClient, grantID: string, input: { requestID: string; machineID: string; projectID: string; text: string;
    options?: { agent?: string; model?: string; permissionMode?: string; effort?: string } }) {
    identifier.parse(input.requestID);
    const requests = { create: hash(`${input.requestID}:create`), send: hash(`${input.requestID}:send`) };
    let created: any;
    try { created = await callControlTool(client, grantID, 'happy_create_task', { requestID: requests.create, machineID: input.machineID, projectID: input.projectID, ...(input.options ? { options: input.options } : {}) }); }
    catch { return { requests, phase: 'create', result: { ok: false, error: { code: 'CONTROL_UNAVAILABLE_OR_UNKNOWN', retryable: false } } }; }
    if (!created.ok || created.data?.state !== 'confirmed' || !created.data?.sessionID) return { requests, phase: 'create', result: created };
    let sent: any;
    try { sent = await callControlTool(client, grantID, 'happy_send', { requestID: requests.send, sessionID: created.data.sessionID, text: input.text }); }
    catch { return { requests, phase: 'send', sessionID: created.data.sessionID, result: { ok: false, error: { code: 'CONTROL_UNAVAILABLE_OR_UNKNOWN', retryable: false } } }; }
    return { requests, phase: 'send', taskID: requests.create, sessionID: created.data.sessionID, result: sent };
}
export type ControlMcpOptions = { authorize?: (name: string, input: unknown) => Promise<void>; allowConnectionRequest?: boolean; skills?: SkillCatalog };
export function createControlMcp(client: ControlClient, grant: () => string, options: ControlMcpOptions = {}) {
    const failure = (error: unknown): CallToolResult => {
        const data = { version: 1, ok: false, error: { code: error instanceof ApiError ? error.code : 'CONTROL_UNAVAILABLE_OR_UNKNOWN', retryable: false } };
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: true };
    };
    const server = new McpServer({ name: 'happy-control', version: '1.0.0' });
    for (const [name, contract] of Object.entries(toolContracts)) server.registerTool(name, {
        description: `Happy task control: ${name}. Create a session, then send the instruction with a stable requestID. The default continues the authorized original checkout and preserves existing edits; dirty work is allowed. Use worktree for independent parallel code work; it starts from committed HEAD, without uncommitted original edits. Same checkout writes serialize; independent checkouts in the same project can run together within its configured concurrency. Declare shared service/database/port resources when used. Queued work starts automatically when its actual conflicts clear. A failed status read does not mean the task stopped. Reconcile the original request before any retry; never repeat an uncertain mutation or cancel/recreate it as recovery. Never change the user's permissionMode. Cancel may target sendRequestID.`,
        inputSchema: contract.schema,
    }, async (input: unknown): Promise<CallToolResult> => {
        try {
            await options.authorize?.(name, input);
            const result = await callControlTool(client, grant(), name as keyof typeof toolContracts, input);
            return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: result.ok === false };
        } catch (error) { return failure(error); }
    });
    if (options.allowConnectionRequest !== false) server.registerTool('happy_request_connection', { description: 'Request a scoped connection; requires explicit approval in Happy. Does not grant access.', inputSchema: scopeSchema }, async args => {
        try { await options.authorize?.('happy_request_connection', args); const result = await client.request('POST', '/connections', scopeSchema.parse(args)); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
        catch (error) { return failure(error); }
    });
    options.skills?.attach(server);
    return server;
}
export async function connectControlStdio(client: ControlClient, grant: () => string, options: ControlMcpOptions = {}) {
    const skills = options.skills ?? await loadControlSkills();
    const server = createControlMcp(client, grant, { ...options, skills }); await server.connect(new StdioServerTransport()); return server;
}
