import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { HumanInterventionHandler } from './humanIntervention';
import { startHappyServer } from './startHappyServer';

function setup() {
    let state: AgentState = {};
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const client = {
        sessionId: 'session-1',
        getAgentState: () => state,
        getMetadata: () => null,
        updateAgentState: vi.fn(async (update: (state: AgentState) => AgentState) => { state = update(state); }),
        sendUserAction: vi.fn(async (_text: string, _id: string) => {}),
        sendClaudeSessionMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn((name: string, handler: (input: unknown) => Promise<unknown>) => handlers.set(name, handler)),
            unregisterHandler: vi.fn((name: string) => handlers.delete(name)),
            invokeHandlerIfRegistered: vi.fn(async (_method: string, _data: unknown) => undefined),
        },
    };
    const push = { sendSessionNotification: vi.fn() };
    const handler = new HumanInterventionHandler(client as unknown as ApiSessionClient, push);
    return { client, push, handler, handlers, state: () => state };
}

const input = { kind: 'sudo' as const, instructions: 'Enter the password in the local terminal.' };

describe('human intervention', () => {
    it('persists before notifying, keeps details encrypted and deduplicates retries', async () => {
        const { handler, state, push } = setup();
        push.sendSessionNotification.mockImplementation(() => expect(state().humanIntervention?.instructions).toBe(input.instructions));
        const request = await handler.request(input);
        expect(await handler.request(input)).toEqual(request);
        expect(push.sendSessionNotification).toHaveBeenCalledOnce();
        expect(push.sendSessionNotification).toHaveBeenCalledWith({
            kind: 'intervention', metadata: null,
            data: { sessionId: 'session-1', requestId: request.requestId, type: 'human_intervention' },
        });
        expect(JSON.stringify(push.sendSessionNotification.mock.calls)).not.toContain(input.instructions);
        expect(request.message).toContain('end this turn');
    });

    it('does not replace an unresolved request or accept stale responses', async () => {
        const { handler, client } = setup();
        await handler.request(input);
        await expect(handler.request({ kind: 'uac', instructions: 'Confirm UAC.' })).rejects.toThrow('already pending');
        await expect(handler.reply({ id: 'old-request', status: 'resolved' })).rejects.toThrow('send your own reply');
        await expect(handler.reply({ id: 'old-request', status: 'cancelled' })).rejects.toThrow('send your own reply');
        expect(client.sendUserAction).not.toHaveBeenCalled();
        expect(client.rpcHandlerManager.invokeHandlerIfRegistered).not.toHaveBeenCalled();
    });

    it.each(['resolved', 'cancelled'] as const)('rejects legacy %s buttons without generating a message, clearing the reminder, or aborting', async status => {
        const { handler, client, state } = setup();
        const { requestId: id } = await handler.request(input);
        await expect(handler.reply({ id, status })).rejects.toThrow('send your own reply');
        expect(state().humanIntervention?.id).toBe(id);
        expect(state().completedHumanIntervention).toBeUndefined();
        expect(client.sendUserAction).not.toHaveBeenCalled();
        expect(client.rpcHandlerManager.invokeHandlerIfRegistered).not.toHaveBeenCalled();
        const restarted = new HumanInterventionHandler(client as unknown as ApiSessionClient);
        await expect(restarted.reply({ id, status })).rejects.toThrow('send your own reply');
        expect(state().humanIntervention?.id).toBe(id);
        expect(client.sendUserAction).not.toHaveBeenCalled();
    });

    it('rejects malformed requests and replies', async () => {
        const { handler } = setup();
        await expect(handler.request({ kind: 'sudo', instructions: ' ' })).rejects.toThrow();
        await expect(handler.reply({ id: 'id', status: 'approved', password: 'never-accepted' })).rejects.toThrow();
    });

    it.each(['http', 'stdio'] as const)('exposes the tool through real %s MCP and accepts the encrypted-RPC payload shape', async transport => {
        const { client, push, handlers, state } = setup();
        const server = await startHappyServer(client as unknown as ApiSessionClient, push);
        const mcp = new Client({ name: 'intervention-test', version: '1.0.0' });
        try {
            await mcp.connect(transport === 'http'
                ? new StreamableHTTPClientTransport(new URL(server.url))
                : new StdioClientTransport({ command: process.execPath, args: [
                    '--import', 'tsx', fileURLToPath(new URL('../../codex/happyMcpStdioBridge.ts', import.meta.url)), '--url', server.url,
                ], stderr: 'pipe' }));
            expect((await mcp.listTools()).tools.map(tool => tool.name)).toContain('request_human_intervention');
            const result = await mcp.callTool({ name: 'request_human_intervention', arguments: { kind: 'uac', instructions: 'Confirm the Windows prompt.' } });
            expect(result.isError).not.toBe(true);
            const id = state().humanIntervention!.id;
            await expect(handlers.get('human-intervention')!({ id, status: 'resolved' })).rejects.toThrow('send your own reply');
            expect(state().humanIntervention?.id).toBe(id);
            expect(client.sendUserAction).not.toHaveBeenCalled();
        } finally {
            await mcp.close();
            server.stop();
        }
    });
});
