import { it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, HostedDotConfig, HostedTaskGateway, loadHostedState, savePrivate, readPrivate, addOutput } from './hostedDotState';
import { createEnvelope } from '@slopus/happy-wire';
const config = () => HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'isolated', happyHome: '/tmp/happy',
    serverUrl: 'http://127.0.0.1:4567', directory: '/tmp/dot', executable: 'codex', args: [], model: 'test', provider: 'openai', instruction: 'chat', codexHome: '/tmp/codex' });
it('accepts ordinary host-bound MCP gateways and bounded service timeouts alongside Happy and memory', () => {
    const gateway = { version: 1, dotId: randomUUID(), sessionId: 'isolated', servers: {
        mcp_workbuddy: { command: '/usr/bin/node', args: ['/gateway.mjs', '/assistant', 'dot', 'connection', 'digest'],
            startup_timeout_sec: 30, tool_timeout_sec: 120, required: true, default_tools_approval_mode: 'approve' },
    } };
    expect(HostedTaskGateway.parse(gateway)).toEqual(gateway);
    for (const timeout of [0, 121]) expect(() => HostedTaskGateway.parse({ ...gateway, servers: {
        mcp_workbuddy: { ...gateway.servers.mcp_workbuddy, tool_timeout_sec: timeout },
    } })).toThrow();
    expect(() => HostedTaskGateway.parse({ ...gateway, servers: { arbitrary: gateway.servers.mcp_workbuddy } })).toThrow();
});
it('preserves input delivery state and stable output identity across process reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-journal-')), file = join(dir, 'state.json'), c = config();
    try {
        const state = loadHostedState(file, c);
        state.inputs.push({ epoch: 0, id: 'm1', seq: 7, text: 'identical text', status: 'dispatching', delivery: 'queue', beforeTurns: ['old'] });
        const envelope = createEnvelope('agent', { t: 'text', text: 'answer' }, { id: 'native-item' });
        addOutput(state, envelope); addOutput(state, envelope); savePrivate(file, state);
        const recovered = loadHostedState(file, c);
        expect(recovered.outputs).toHaveLength(1); expect(recovered.outputs[0].sent).toBe(false);
        expect(recovered.inputs[0].status).toBe('dispatching');
        expect(() => loadHostedState(file, { ...c, sessionId: 'different' })).toThrow('hosted_binding_changed');
        recovered.epoch++; addOutput(recovered, envelope); expect(recovered.outputs).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true }); }
});
it('rejects reserved identity environment variables and non-file state', () => {
    for (const name of ['CODEX_HOME', 'HOME', 'HAPPY_HOME_DIR', 'NODE_OPTIONS']) expect(() => HostedDotConfig.parse({ ...config(), environment: [name] })).toThrow();
    const dir = mkdtempSync(join(tmpdir(), 'hosted-file-'));
    try { writeFileSync(join(dir, 'real'), '{}'); symlinkSync(join(dir, 'real'), join(dir, 'link')); expect(() => readPrivate(join(dir, 'link'))).toThrow('hosted_file_invalid'); }
    finally { rmSync(dir, { recursive: true }); }
});
it('migrates effort-less config bindings, preserves explicit effort and retains reset epoch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-migrate-')), file = join(dir, 'state.json');
    try {
        const c = config(), state = loadHostedState(file, c);
        const { effort, ...legacy } = c;
        state.binding = hash(legacy); savePrivate(file, state);
        expect(loadHostedState(file, c).binding).toBe(hash(c));
        expect(HostedDotConfig.parse(legacy).effort).toBe('xhigh');
        expect(HostedDotConfig.parse({ ...legacy, effort: 'high' }).effort).toBe('high');
        expect(() => loadHostedState(file, { ...c, provider: 'other' })).toThrow('hosted_binding_changed');
        writeFileSync(join(dir, 'reset-epoch.json'), JSON.stringify({ epoch: 5 }));
        expect(loadHostedState(join(dir, 'new.json'), { ...c, directory: dir }).epoch).toBe(5);
    } finally { rmSync(dir, { recursive: true }); }
});
it('refuses to revive a journal older than the durable reset epoch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-stale-')), file = join(dir, 'state.json');
    try {
        const c = { ...config(), directory: dir }, state = loadHostedState(file, c);
        savePrivate(file, state); writeFileSync(join(dir, 'reset-epoch.json'), JSON.stringify({ epoch: 1 }));
        expect(() => loadHostedState(file, c)).toThrow('hosted_epoch_stale');
        expect(readPrivate(file).epoch).toBe(0);
    } finally { rmSync(dir, { recursive: true }); }
});


it('compacts only settled dispatch snapshots and preserves the v1 thread marker and receipts', async () => {
    const { compactSettledDispatchSnapshots, HostedDotJournal } = await import('./hostedDotState');
    const dir = mkdtempSync(join(tmpdir(), 'hosted-compact-')), file = join(dir, 'state.json'), c = config();
    try {
        const state = loadHostedState(file, c);
        const statuses = ['queued', 'dispatching', 'accepted', 'unknown', 'completed', 'failed', 'interrupted', 'rejected'] as const;
        state.inputs = statuses.map((status, i) => ({ epoch: 0, delivery: 'queue' as const, id: String(i), seq: i + 1,
            text: 'same text', status, turnId: `turn-${i}`, beforeTurns: ['old-a', 'old-b'] }));
        const original = structuredClone(state);
        compactSettledDispatchSnapshots(state);
        for (const row of state.inputs) {
            const expected = original.inputs.find(old => old.id === row.id)!;
            expect(row).toEqual({ ...expected, beforeTurns: ['completed', 'failed', 'interrupted'].includes(row.status) ? [] : expected.beforeTurns });
            expect(row.beforeTurns).toBeDefined();
        }
        expect(HostedDotJournal.parse(state)).toEqual(state);
        savePrivate(file, state);
        const recovered = loadHostedState(file, c);
        expect(recovered).toEqual(state);
        compactSettledDispatchSnapshots(recovered);
        expect(recovered).toEqual(state);
    } finally { rmSync(dir, { recursive: true }); }
});

it('keeps completed legacy history linear without changing unknown recovery evidence', async () => {
    const { compactSettledDispatchSnapshots, HOSTED_STATE_MAX_BYTES } = await import('./hostedDotState');
    const dir = mkdtempSync(join(tmpdir(), 'hosted-growth-')), file = join(dir, 'state.json'), c = config();
    try {
        const state = loadHostedState(file, c), ids = Array.from({ length: 1400 }, () => randomUUID());
        state.inputs = ids.map((turnId, i) => ({ epoch: 0, delivery: 'queue' as const, seq: i + 1, id: `input-${i}`,
            text: 'test', status: 'completed' as const, turnId, beforeTurns: ids.slice(0, i) }));
        expect(Buffer.byteLength(JSON.stringify(state))).toBeGreaterThan(HOSTED_STATE_MAX_BYTES);
        state.inputs.push({ epoch: 0, delivery: 'queue', seq: 1401, id: 'pending', text: 'test', status: 'unknown', beforeTurns: [...ids] });
        compactSettledDispatchSnapshots(state);
        expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(1024 * 1024);
        expect(state.inputs.at(-1)?.beforeTurns).toEqual(ids);
        expect(state.inputs).toHaveLength(1401);
        expect(state.inputs[1399].turnId).toBe(ids[1399]);
        expect(state.inputs[1399].beforeTurns).toEqual([]);
    } finally { rmSync(dir, { recursive: true }); }
});
