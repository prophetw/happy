import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createControlMcp, connectControlStdio, toolContracts } from './mcp';
import { loadControlSkills } from './skills';
import { projectResponse } from './projection';
import { openapi } from './openapi';
import { createDaemonTransport } from './daemonTransport';
import { encodeBase64, encrypt } from '../../encryption';
import type { DecryptedSession, DecryptedMachine } from '../../api';
import type { ControlClient, ProofClient } from './client';
import { ServiceTokenClient } from './client';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const skillResultSchema = z.object({
    uri: z.string(),
    frontmatter: z.object({ name: z.string(), description: z.string() }).passthrough(),
    resources: z.union([z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() }).passthrough()), z.literal('dynamic')]),
}).passthrough();
const listSkillsResultSchema = z.object({ skills: z.array(skillResultSchema) }).passthrough();
const getSkillResultSchema = z.object({ skill: skillResultSchema }).passthrough();
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
            const tools = await client.listTools();
            expect(tools.tools.map(t => t.name).sort()).toEqual([...Object.keys(toolContracts), 'happy_request_connection'].sort());
            expect(tools.tools.map(t => t.name)).not.toContain('shell');
            const result = await client.callTool({ name: 'happy_machines', arguments: { limit: 2 } });
            expect(result.isError).toBe(false); expect(request).toHaveBeenCalledWith('GET','/machines?limit=2',undefined,'approved-grant');
            await client.callTool({ name: 'happy_projects', arguments: {} });
            expect(request).toHaveBeenCalledWith('GET','/projects',undefined,'approved-grant');
            await client.callTool({ name: 'happy_connection', arguments: {} });
            expect(request).toHaveBeenCalledWith('GET','/connections/approved-grant',undefined,'approved-grant');
            await client.callTool({ name: 'happy_result', arguments: { sessionID: 'fixture-session', turnID: 'fixture-turn', cursor: '12', limit: 2 } });
            expect(request).toHaveBeenCalledWith('GET','/sessions/fixture-session/result?cursor=12&limit=2&turnID=fixture-turn',undefined,'approved-grant');
            const calls = request.mock.calls.length;
            const invalid = await client.callTool({ name: 'happy_projects', arguments: { cursor: 'unexpected' } });
            expect(invalid.isError).toBe(true); expect(request).toHaveBeenCalledTimes(calls);
        } finally { await client.close(); await server.close(); }
    });
    it('serves verified packaged skills through a real 2.4 server and 1.29 client without REST calls', async () => {
        const request = vi.fn();
        const skills = await loadControlSkills();
        const server = createControlMcp({ request } as unknown as ProofClient, () => 'approved-grant', { skills });
        const client = new Client({ name: 'skills-fixture-client', version: '1' });
        const [a,b] = InMemoryTransport.createLinkedPair();
        try {
            await Promise.all([server.connect(a), client.connect(b)]);
            expect(client.getServerCapabilities()).toMatchObject({ extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } } });
            const listed = await client.request({ method: 'skills/list', params: {} } as any, listSkillsResultSchema);
            const skill = listed.skills.find(s => s.frontmatter.name === 'happy-control')!;
            expect(skill).toBeDefined();
            expect(skill.frontmatter.description).toContain('Use when');
            expect(new Set(listed.skills.map(s => s.uri)).size).toBe(listed.skills.length);
            const resources = Array.isArray(skill.resources) ? skill.resources : [];
            expect(resources.length).toBeGreaterThan(0);
            expect(new Set(resources.map(r => r.uri)).size).toBe(resources.length);
            const raw = readFileSync(fileURLToPath(new URL('../../../skills/happy-control/SKILL.md', import.meta.url)));
            const entry = resources.find(r => r.uri === skill.uri)!;
            expect(entry.digest).toBe(`sha256:${createHash('sha256').update(raw).digest('hex')}`);
            expect(entry.size).toBe(raw.byteLength);
            const got = await client.request({ method: 'skills/get', params: { uri: skill.uri } } as any, getSkillResultSchema);
            expect(got.skill).toEqual(skill);
            const read = await client.readResource({ uri: skill.uri });
            expect(read.contents[0]).toMatchObject({ uri: skill.uri, text: raw.toString('utf8') });
            expect(request).not.toHaveBeenCalled();
        } finally { await client.close(); await server.close(); }
    });
    it('keeps service bearer clients on the fixed REST origin and out of URLs and errors', async () => {
        const token = `hsvc1.fixture.${'a'.repeat(43)}`;
        const fetchMock = vi.fn(async () => ({ json: async () => ({ version: 1, ok: true, data: { projects: [] } }) }));
        const client: ControlClient = new ServiceTokenClient('https://control.fixture.invalid/happy-control/v1', token, { fetch: fetchMock as unknown as typeof fetch });
        expect(await client.request('GET', '/projects')).toMatchObject({ ok: true });
        expect(fetchMock).toHaveBeenCalledWith('https://control.fixture.invalid/happy-control/v1/projects', expect.objectContaining({
            method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error',
        }));
        await expect(client.request('GET', '/../account')).rejects.toThrow('INVALID_ROUTE');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fetchMock.mockRejectedValueOnce(new Error(`private ${token}`));
        await expect(client.request('GET', '/projects')).rejects.toThrow('CONTROL_UNAVAILABLE_OR_UNKNOWN');
        expect(() => new ServiceTokenClient('https://control.fixture.invalid/happy-control/v1', 'not-a-service-token')).toThrow('INVALID_SERVICE_TOKEN');
    });
    it('drops arbitrary worker keys/metadata and redacts output text', () => {
        const result = projectResponse({ version: 1, ok: true, data: { sessionID: 's1', secret: 'NEVER', metadata: { token: 'NEVER' }, messages: [{ kind: 'text', text: 'Bearer PRIVATE token=SECRET' }] } });
        expect(JSON.stringify(result)).not.toMatch(/NEVER|PRIVATE|SECRET|metadata|secret/);
        expect(() => projectResponse({ ok: true, key: 'NEVER' })).toThrow('INVALID_WORKER_RESPONSE');
    });
    it('exposes OpenAPI security boundaries and strict mutation schemas', () => {
        expect(openapi.openapi).toBe('3.1.0');
        expect((openapi.paths['/tasks'].post as any).security).toEqual([{ ClientProof: [] }, { ServiceBearer: [] }]);
        expect((openapi.paths['/connections'].post as any).security).toEqual([{ ClientProof: [] }]);
        expect((openapi.paths['/connections/{id}/approve'].post as any).security).toEqual([{ OwnerBearer: [] }]);
        expect((openapi.paths['/projects'].get as any).security).toEqual([{ ClientProof: [] }, { ServiceBearer: [] }]);
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
