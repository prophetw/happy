import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import type { ApiSessionClient } from '@/api/apiSession';
import { startHappyServer } from './startHappyServer';

describe('Happy MCP tools', () => {
    it.each(['http', 'stdio'] as const)('exposes only title management through real %s MCP', async transport => {
        const client = {
            sessionId: 'session-1',
            sendClaudeSessionMessage: vi.fn(),
            rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn() },
        };
        const server = await startHappyServer(client as unknown as ApiSessionClient);
        const mcp = new Client({ name: 'happy-tools-test', version: '1.0.0' });
        try {
            await mcp.connect(transport === 'http'
                ? new StreamableHTTPClientTransport(new URL(server.url))
                : new StdioClientTransport({ command: process.execPath, args: [
                    '--import', 'tsx', fileURLToPath(new URL('../../codex/happyMcpStdioBridge.ts', import.meta.url)), '--url', server.url,
                ], stderr: 'pipe' }));
            expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(['change_title']);
            expect(server.toolNames).toEqual(['change_title']);
            expect(client.rpcHandlerManager.registerHandler).not.toHaveBeenCalled();
            const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'New task' } });
            expect(result.isError).not.toBe(true);
            expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'summary', summary: 'New task' }));
        } finally {
            await mcp.close();
            server.stop();
        }
    });
});
