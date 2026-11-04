import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AutomationControl, methods, projectMessage, redact, validatePolicy, type Policy } from './control';
import { Journal } from './journal';
import { serveJsonLines } from './main';
import type { Transport } from './relay';
import type { DecryptedMachine, DecryptedSession } from '../api';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const policy: Policy = { version: 1, serverUrl: 'https://relay.invalid', methods: [...methods], machines: [{ id: 'm1', directories: ['/fixture'] }], sessionIDs: ['s1'] };
const session = { id: 's1', active: true, metadata: { machineId: 'm1', path: '/fixture', flavor: 'codex', secret: 'NEVER_OUTPUT' }, encryption: { key: new Uint8Array([9,8,7]), variant: 'dataKey' }, agentState: {} } as unknown as DecryptedSession;
const machine = { id: 'm1', active: true, encryption: session.encryption, metadata: { secret: 'NEVER_OUTPUT' } } as DecryptedMachine;
function setup(p = structuredClone(policy)) {
    const dir = mkdtempSync(join(tmpdir(), 'happy-connector-test-')); dirs.push(dir);
    const journal = new Journal(dir);
    const transport = {
        machines: vi.fn(async () => [machine]),
        sessions: vi.fn(async () => ({ sessions: [session], nextCursor: null as string | null })),
        rpc: vi.fn(async (_m: DecryptedMachine, r: Record<string, unknown>): Promise<Record<string, unknown>> => r.operation === 'status'
            ? { version: 1, process: 'running' } : { version: 1, sessionID: 's1', state: r.operation === 'cancel' ? 'cancel_requested' : 'confirmed', process: 'running' }),
        messages: vi.fn(async () => ({ messages: [] as { id: string; seq: number; localId: string | null; content: unknown }[], hasMore: false })),
        send: vi.fn(async () => ({ id: 'msg1', seq: 10 })),
    };
    return { dir, journal, transport, control: new AutomationControl(transport as Transport, p, journal) };
}
const req = (method: string, fields: Record<string, unknown> = {}) => ({ version: 1, method, ...fields });
const create = req('tasks.create', { requestID: 'r1', machineID: 'm1', directory: '/fixture' });
const send = req('sessions.send', { requestID: 'send1', sessionID: 's1', text: 'do fixture work' });
const call = async (s: ReturnType<typeof setup>, input: unknown) => await s.control.handle(input) as any;

describe('scoped JSONL automation contract', () => {
    it('creates a task receipt and never re-spawns a confirmed task', async () => {
        const s = setup();
        expect(await call(s, create)).toMatchObject({ ok: true, data: { taskID: 'r1', sessionID: 's1', state: 'confirmed' } });
        expect(await call(s, create)).toMatchObject({ ok: true });
        expect(s.transport.rpc.mock.calls.map(c => c[1].operation)).toEqual(['create', 'request']);
        expect(await call(s, { ...create, directory: '/other' })).toMatchObject({ ok: false });
    });
    it('persists unknown before dispatch, queries after timeout, never resends on lookup', async () => {
        const s = setup();
        s.transport.send.mockRejectedValueOnce(new Error('Authorization: Bearer PRIVATE'));
        expect(await call(s, send)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE_OR_UNKNOWN' } });
        expect(s.journal.get('send1')?.state).toBe('unknown');
        s.transport.messages.mockResolvedValueOnce({ messages: [{ id: 'msg1', seq: 10, localId: 'automation:send1', content: null }], hasMore: false });
        const restarted = new AutomationControl(s.transport as Transport, policy, new Journal(s.dir));
        expect(await restarted.handle(req('requests.get', { requestID: 'send1' }))).toMatchObject({ ok: true, data: { state: 'submitted', messageID: 'msg1' } });
        expect(s.transport.send).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(s.dir, readdirSync(s.dir)[0]), 'utf8')).not.toContain('do fixture work');
    });
    it('allows explicit same-key retry using receiver dedupe, rejects conflicting payloads', async () => {
        const s = setup();
        s.transport.send.mockRejectedValueOnce(new Error('timeout'));
        await call(s, send);
        expect(await call(s, { ...send, text: 'different payload' })).toMatchObject({ error: { code: 'REQUEST_ID_CONFLICT' } });
        expect(await call(s, send)).toMatchObject({ data: { state: 'submitted' } });
        expect(s.transport.send.mock.calls.map(c => (c as unknown[])[1])).toEqual(['send1', 'send1']);
    });
    it('returns unavailable when daemon confirms no receipt, without dispatching on query', async () => {
        const s = setup();
        s.transport.rpc.mockRejectedValueOnce(new Error('offline'));
        expect(await call(s, create)).toMatchObject({ ok: false });
        s.transport.rpc.mockResolvedValueOnce({ version: 1, errorCode: 'NOT_FOUND' });
        expect(await call(s, req('requests.get', { requestID: 'r1' }))).toMatchObject({ data: { state: 'unavailable', safeToRetrySameRequestID: true } });
        expect(s.transport.rpc.mock.calls.map(c => c[1].operation)).toEqual(['create', 'request']);
        expect(await call(s, create)).toMatchObject({ data: { state: 'confirmed' } });
    });
    it('keeps cancel ack separate from stopped and does not infer completion from idle', async () => {
        const s = setup();
        expect(await call(s, req('sessions.cancel', { requestID: 'c1', sessionID: 's1' }))).toMatchObject({ data: { state: 'cancel_requested', process: 'running' } });
        expect(await call(s, req('sessions.status', { sessionID: 's1' }))).toMatchObject({ data: { process: 'running', turn: { state: 'unknown' } } });
        s.transport.rpc.mockResolvedValueOnce({ version: 1, process: 'stopped' });
        expect(await call(s, req('sessions.status', { sessionID: 's1' }))).toMatchObject({ data: { process: 'stopped' } });
    });
    it('uses scoped log cursors and preserves failed/cancelled turn outcomes', async () => {
        const s = setup();
        s.transport.messages.mockResolvedValueOnce({ messages: [
            { id: 'msg1', seq: 11, localId: null, content: { role: 'session', content: { role: 'agent', turn: 't1', ev: { t: 'turn-end', status: 'failed' } } } },
        ], hasMore: true });
        expect(await call(s, req('sessions.logs', { sessionID: 's1', cursor: 10, limit: 1 }))).toMatchObject({ data: { nextCursor: 11, hasMore: true, turn: { state: 'failed' } } });
        expect(s.transport.messages).toHaveBeenCalledWith(session, 10, 1);
        expect(projectMessage({ id: 'msg', seq: 1, content: { role: 'session', content: { role: 'agent', ev: { t: 'turn-end', status: 'cancelled' } } } })).toMatchObject({ state: 'cancelled' });
    });
    it('paginates sessions beyond v1 150 limit and filters unauthorized records', async () => {
        const s = setup();
        s.transport.sessions.mockResolvedValueOnce({ sessions: [], nextCursor: 'cursor_v1_next' });
        expect(await call(s, req('sessions.status', { sessionID: 's1' }))).toMatchObject({ ok: true });
        expect(s.transport.sessions).toHaveBeenNthCalledWith(2, 'cursor_v1_next');
        s.transport.sessions.mockResolvedValueOnce({ sessions: [{ ...session, id: 'private' }], nextCursor: 'cursor_v1_next' });
        expect(await call(s, req('sessions.list'))).toMatchObject({ data: { sessions: [], nextCursor: 'cursor_v1_next' } });
    });
    it('denies prefixes, unauthorized targets, arbitrary options and revoked policy', async () => {
        const s = setup();
        for (const input of [
            req('sessions.send', { ...send, sessionID: 's' }),
            { ...create, machineID: 'm2' }, { ...create, shell: 'echo unsafe' },
            req('sessions.status', { sessionID: 's1', cursor: -1 }),
        ]) expect(await call(s, input)).toMatchObject({ ok: false });
        expect(s.transport.send).not.toHaveBeenCalled();
        const p = structuredClone(policy); p.sessionIDs = []; p.methods = ['requests.get'];
        await call(s, send);
        const revoked = new AutomationControl(s.transport as Transport, p, s.journal);
        expect(await revoked.handle(req('requests.get', { requestID: 'send1' }))).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });
    it('returns only allowlisted projections and sanitized errors', async () => {
        const s = setup();
        const result = JSON.stringify(await call(s, req('machines.list')));
        expect(result).not.toMatch(/NEVER_OUTPUT|encryption|dataEncryptionKey|metadata/);
        const text = 'Bearer abcdef token=secret123 api_key="hidden" sk-fixture123 ghp_fixture123';
        expect(redact(text)).not.toMatch(/abcdef|secret123|hidden|sk-fixture123|ghp_fixture123/);
        expect(redact('-----BEGIN PRIVATE KEY-----\nunfinished-secret')).toBe('[REDACTED]');
        s.transport.machines.mockRejectedValue(new Error('Bearer PRIVATE'));
        expect(JSON.stringify(await call(s, req('machines.list')))).not.toContain('PRIVATE');
    });
    it('JSONL survives invalid input and never writes credentials or prose to stdout', async () => {
        const s = setup(), input = new PassThrough(), output = new PassThrough();
        let text = ''; output.on('data', c => { text += c.toString(); });
        const running = serveJsonLines(s.control, input, output);
        input.end('{invalid\n' + JSON.stringify(req('machines.list')) + '\n');
        await running;
        const lines = text.trim().split('\n').map(l => JSON.parse(l));
        expect(lines).toHaveLength(2); expect(lines[0].error.code).toBe('INVALID_JSON'); expect(lines[1].ok).toBe(true);
    });
    it('requires valid policy, HTTPS for remote relay, and method scope', async () => {
        expect(() => validatePolicy(policy)).not.toThrow();
        expect(() => validatePolicy({ ...policy, serverUrl: 'http://remote.invalid' })).toThrow();
        expect(() => validatePolicy({ ...policy, serverUrl: 'https://user:pass@relay.invalid' })).toThrow();
        const s = setup({ ...policy, methods: ['machines.list'] });
        expect(await call(s, send)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });
});
