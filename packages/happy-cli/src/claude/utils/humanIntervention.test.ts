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
        await expect(handler.reply({ id: 'old-request', status: 'resolved' })).rejects.toThrow('no longer pending');
        await expect(handler.reply({ id: 'old-request', status: 'cancelled' })).rejects.toThrow('no longer pending');
        expect(client.sendUserAction).not.toHaveBeenCalled();
        expect(client.rpcHandlerManager.invokeHandlerIfRegistered).not.toHaveBeenCalled();
    });

    it.each(['resolved', 'cancelled'] as const)('durably sends a %s follow-up before clearing and makes retries idempotent', async status => {
        const { handler, client, state } = setup();
        const { requestId: id } = await handler.request(input);
        client.sendUserAction.mockImplementation(async () => { expect(state().humanIntervention?.id).toBe(id); });
        await Promise.all([handler.reply({ id, status }), handler.reply({ id, status })]);
        expect(client.sendUserAction).toHaveBeenCalledOnce();
        expect(client.sendUserAction).toHaveBeenCalledWith(
            expect.stringContaining(status === 'resolved' ? 'Check the actual command result' : 'Stop the affected task'),
            `human-intervention:${id}:${status}`,
        );
        expect(state().humanIntervention).toBeNull();
        expect(state().completedHumanIntervention).toEqual({ id, status });
        if (status === 'cancelled') expect(client.rpcHandlerManager.invokeHandlerIfRegistered).toHaveBeenCalledExactlyOnceWith('abort', expect.objectContaining({ reason: expect.stringContaining('cancelled') }));
        else expect(client.rpcHandlerManager.invokeHandlerIfRegistered).not.toHaveBeenCalled();
        const restarted = new HumanInterventionHandler(client as unknown as ApiSessionClient);
        await restarted.reply({ id, status });
        expect(client.sendUserAction).toHaveBeenCalledOnce();
        await expect(restarted.reply({ id, status: status === 'resolved' ? 'cancelled' : 'resolved' })).rejects.toThrow('differently');
    });

    it('keeps the request pending on delivery failure and supports retry', async () => {
        const { handler, client, state } = setup();
        const { requestId: id } = await handler.request(input);
        client.sendUserAction.mockRejectedValueOnce(new Error('network unavailable'));
        await expect(handler.reply({ id, status: 'resolved' })).rejects.toThrow('network unavailable');
        expect(state().humanIntervention?.id).toBe(id);
        const restarted = new HumanInterventionHandler(client as unknown as ApiSessionClient);
        await expect(restarted.reply({ id, status: 'cancelled' })).rejects.toThrow('differently');
        await handler.reply({ id, status: 'resolved' });
        expect(state().humanIntervention).toBeNull();
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
            await handlers.get('human-intervention')!({ id, status: 'resolved' });
            expect(state().humanIntervention).toBeNull();
            expect(client.sendUserAction).toHaveBeenCalledOnce();
        } finally {
            await mcp.close();
            server.stop();
        }
    });
});
