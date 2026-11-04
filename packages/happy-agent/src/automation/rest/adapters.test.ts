import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createControlMcp, connectControlStdio } from './mcp';
import { projectResponse } from './projection';
import { openapi } from './openapi';
import { createDaemonTransport } from './daemonTransport';
import { encodeBase64, encrypt } from '../../encryption';
import type { DecryptedSession, DecryptedMachine } from '../../api';
import type { ProofClient } from './client';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => http } }));
beforeEach(() => { vi.resetAllMocks(); });
describe('daemon, SDK and contract adapters', () => {
    it('uses only known record keys and fresh encrypted state, rejects unknown keys and arbitrary RPC', async () => {
        const key = new Uint8Array(32).fill(19), encryption = { key, variant: 'dataKey' as const };
        const machine = { id: 'machine', encryption } as DecryptedMachine;
        const session = { id: 'known', metadata: { old: true }, encryption } as DecryptedSession;
        const encode = (v: unknown) => encodeBase64(encrypt(key, 'dataKey', v));
        http.get.mockResolvedValue({ data: { sessions: [
            { id: 'known', active: true, seq: 11, metadata: encode({ machineId: 'machine', path: '/approved', flavor: 'codex' }), agentState: encode({ requests: { permission1: {} } }) },
            { id: 'unknown', metadata: 'not-decryptable' },
        ], nextCursor: 'cursor_v1_next' } });
        const control = vi.fn(async () => ({ version: 1, process: 'unknown' }));
        const adapter = createDaemonTransport({ serverUrl: 'https://relay.invalid', token: 'fixture-private-bearer', machine: () => machine, sessions: () => [session], control });
        const page = await adapter.sessions(undefined, 10);
        expect(page.nextCursor).toBe('cursor_v1_next'); expect(page.sessions).toHaveLength(1);
        expect(page.sessions[0]).toMatchObject({ seq: 11, agentState: { requests: { permission1: {} } } });
        await expect(adapter.rpc(machine, { version: 1, operation: 'bash' })).rejects.toThrow('UNSUPPORTED_VERSION');
        expect(control).not.toHaveBeenCalled();
        expect(await adapter.rpc(machine, { version: 1, operation: 'status', sessionID: 'known' })).toMatchObject({ process: 'unknown' });
    });
    it('uses real MCP SDK discovery/calls with fixed REST mappings', async () => {
        const request = vi.fn(async () => ({ version: 1, ok: true, data: { machines: [] } }));
        const server = createControlMcp({ request } as unknown as ProofClient, () => 'approved-grant');
        const client = new Client({ name: 'fixture-client', version: '1' });
        const [a,b] = InMemoryTransport.createLinkedPair();
        try {
            await Promise.all([server.connect(a), client.connect(b)]);
            const tools = await client.listTools(); expect(tools.tools.map(t => t.name)).toContain('happy_cancel');
            expect(tools.tools.map(t => t.name)).not.toContain('shell');
            const result = await client.callTool({ name: 'happy_machines', arguments: { limit: 2 } });
            expect(result.isError).toBe(false); expect(request).toHaveBeenCalledWith('GET','/machines?limit=2',undefined,'approved-grant');
        } finally { await client.close(); await server.close(); }
    });
    it('drops arbitrary worker keys/metadata and redacts output text', () => {
        const result = projectResponse({ version: 1, ok: true, data: { sessionID: 's1', secret: 'NEVER', metadata: { token: 'NEVER' }, messages: [{ kind: 'text', text: 'Bearer PRIVATE token=SECRET' }] } });
        expect(JSON.stringify(result)).not.toMatch(/NEVER|PRIVATE|SECRET|metadata|secret/);
        expect(() => projectResponse({ ok: true, key: 'NEVER' })).toThrow('INVALID_WORKER_RESPONSE');
    });
    it('exposes OpenAPI security boundaries and strict mutation schemas', () => {
        expect(openapi.openapi).toBe('3.1.0');
        expect((openapi.paths['/tasks'].post as any).security).toEqual([{ ClientProof: [] }]);
        expect((openapi.paths['/connections/{id}/approve'].post as any).security).toEqual([{ OwnerBearer: [] }]);
        expect((openapi.paths['/tasks'].post as any).requestBody.content['application/json'].schema.additionalProperties).toBe(false);
        expect(openapi.paths['/sessions/{id}/result']).toBeDefined();
    });
});

it('forwards stdio authorization options and emits stable error envelopes', async () => {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const start = vi.spyOn(StdioServerTransport.prototype, 'start').mockResolvedValue();
    const request=vi.fn(), gate=vi.fn(async()=>{throw new Error('private fixture detail');});
    const server=await connectControlStdio({request} as unknown as ProofClient,()=> 'g',{authorize:gate,allowConnectionRequest:false});
    // Reconnect the same stdio-created server to an in-memory transport after closing the inert fixture transport.
    await server.close(); start.mockRestore();
    const actual=server;
    const client=new Client({name:'stdio-contract',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    try { await Promise.all([actual.connect(a),client.connect(b)]);
        expect((await client.listTools()).tools.some(t=>t.name==='happy_request_connection')).toBe(false);
        const response=await client.callTool({name:'happy_machines',arguments:{}});
        expect(response.structuredContent).toEqual({version:1,ok:false,error:{code:'CONTROL_UNAVAILABLE_OR_UNKNOWN',retryable:false}});
        expect(request).not.toHaveBeenCalled();
    } finally { await client.close();await actual.close(); }
});
