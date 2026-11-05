import { afterEach, describe, expect, it } from 'vitest';
import { filterCatalogForGrant, resolveTaskOptions, validateGrantOptions, OptionsDenied,
    optionCatalogSchema, taskOptionsSchema, type LaunchOptionsPolicy, type OptionCatalogEntry } from './options';

const catalog: OptionCatalogEntry[] = [
    { agent: 'codex', models: ['gpt-6.1-sol', 'gpt-6-sol'], permissionModes: ['default', 'auto', 'safe-yolo', 'read-only', 'yolo'],
        efforts: ['low', 'medium', 'high'], defaultModel: 'gpt-6.1-sol', defaultPermissionMode: 'default', defaultEffort: 'high' },
    { agent: 'claude', models: ['default', 'claude-opus-5'], permissionModes: ['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'],
        efforts: ['low', 'medium', 'high'], defaultModel: 'default', defaultPermissionMode: 'default', defaultEffort: '' },
];
const policy: LaunchOptionsPolicy = { version: 1, agents: [
    { agent: 'codex', models: ['gpt-6-sol'], permissionModes: ['auto', 'yolo'] },
    { agent: 'claude', models: ['claude-opus-5'], permissionModes: ['acceptEdits'] },
] };
const resolve = (requested: Parameters<typeof resolveTaskOptions>[0], grant?: Parameters<typeof resolveTaskOptions>[2]) =>
    resolveTaskOptions(requested, policy, grant, 'codex', catalog);

it('accepts installed context-window model IDs without invalidating discovery for a Codex-only grant', () => {
    const model = 'ccs-claude-kimi--k3.1-pro[1M]';
    const live = { version: 1 as const, defaultAgent: 'codex', agents: [catalog[0], { ...catalog[1], models: ['default', model] }] };
    expect(optionCatalogSchema.safeParse(live).success).toBe(true);
    expect(taskOptionsSchema.safeParse({ agent: 'claude', model }).success).toBe(true);
    const codexOnly = { version: 1 as const, agents: [policy.agents[0]] };
    const filtered = filterCatalogForGrant(live, codexOnly, undefined);
    expect(filtered.agents.map(a => a.agent)).toEqual(['codex']);
    const approved = { version: 1 as const, agents: [{ agent: 'claude' as const, models: [model], permissionModes: ['default'] }] };
    expect(resolveTaskOptions({ agent: 'claude', model }, approved, undefined, 'codex', live.agents).model).toBe(model);
    for (const invalid of ['model with spaces', 'model;command', 'model$(command)', 'model\nvalue', '../model'])
        expect(taskOptionsSchema.safeParse({ model: invalid }).success).toBe(false);
});

describe('launch option resolution', () => {
    it('keeps the exact legacy fixed launch when no allowlist exists', () => {
        expect(resolveTaskOptions({}, undefined, undefined, 'codex', catalog))
            .toEqual({ agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'default', effort: 'high' });
        expect(() => resolveTaskOptions({ permissionMode: 'yolo' }, undefined, undefined, 'codex', catalog)).toThrow(OptionsDenied);
    });
    it('uses per-agent defaults rather than the default agent’s model', () => {
        expect(resolve({ agent: 'claude' })).toEqual({ agent: 'claude', model: 'default', permissionMode: 'default', effort: '' });
    });
    it('allows only explicitly listed overrides, including yolo when granted', () => {
        expect(resolve({ model: 'gpt-6-sol', permissionMode: 'yolo', effort: 'low' }))
            .toEqual({ agent: 'codex', model: 'gpt-6-sol', permissionMode: 'yolo', effort: 'low' });
        expect(() => resolve({ permissionMode: 'safe-yolo' })).toThrow(OptionsDenied);
        expect(() => resolve({ model: 'claude-opus-5' })).toThrow(OptionsDenied);
        expect(() => resolve({ agent: 'claude', permissionMode: 'bypassPermissions' })).toThrow(OptionsDenied);
        expect(() => resolve({ agent: 'gemini' as never })).toThrow(OptionsDenied);
        expect(() => resolve({ effort: 'ultra' })).toThrow(OptionsDenied);
    });
    it('rejects values the live catalog does not offer even when allowlisted', () => {
        const stale: LaunchOptionsPolicy = { version: 1, agents: [{ agent: 'codex', models: ['gpt-9-nonexistent'], permissionModes: [] }] };
        expect(() => resolveTaskOptions({ model: 'gpt-9-nonexistent' }, stale, undefined, 'codex', catalog)).toThrow(OptionsDenied);
    });
    it('narrows further by the grant and keeps ambient defaults valid', () => {
        const grant = { agents: [{ agent: 'codex' as const, models: ['gpt-6-sol'], permissionModes: ['auto'] }] };
        expect(resolve({ permissionMode: 'auto' }, grant).permissionMode).toBe('auto');
        expect(() => resolve({ permissionMode: 'yolo' }, grant)).toThrow(OptionsDenied);
        expect(() => resolve({ agent: 'claude' }, grant)).toThrow(OptionsDenied);
        // No override requested: the ambient default launch stays permitted.
        expect(resolve({}, grant)).toEqual({ agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'default', effort: 'high' });
    });
    it('only accepts grant option subsets of the worker allowlist', () => {
        expect(validateGrantOptions({ agents: [{ agent: 'codex', models: ['gpt-6-sol'], permissionModes: ['yolo'] }] }, policy)).toBe(true);
        expect(validateGrantOptions({ agents: [{ agent: 'codex', models: [], permissionModes: ['safe-yolo'] }] }, policy)).toBe(false);
        expect(validateGrantOptions({ agents: [{ agent: 'codex', models: [], permissionModes: [] }] }, undefined)).toBe(false);
        expect(validateGrantOptions(undefined, undefined)).toBe(true);
    });
    it('filters discovery to what the grant can select, defaults included', () => {
        const open = filterCatalogForGrant({ version: 1, defaultAgent: 'codex', agents: catalog }, policy, undefined);
        const codex = open.agents.find(a => a.agent === 'codex')!;
        expect(codex.models).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
        expect(codex.permissionModes).toEqual(['default', 'auto', 'yolo']);
        expect(codex.defaultModel).toBe('gpt-6.1-sol');
        const narrowed = filterCatalogForGrant({ version: 1, defaultAgent: 'codex', agents: catalog }, policy,
            { agents: [{ agent: 'codex', models: [], permissionModes: ['yolo'] }] });
        expect(narrowed.agents).toHaveLength(1);
        expect(narrowed.agents[0].models).toEqual(['gpt-6.1-sol']);
        expect(narrowed.agents[0].permissionModes).toEqual(['default', 'yolo']);
        const legacy = filterCatalogForGrant({ version: 1, defaultAgent: 'codex', agents: catalog }, undefined, undefined);
        expect(legacy.agents).toEqual([{ agent: 'codex', models: [], permissionModes: [], efforts: [],
            defaultModel: 'gpt-6.1-sol', defaultPermissionMode: 'default', defaultEffort: 'high' }]);
    });
});

const fixturePath = new URL('../../../examples/rest-fixture.ts', import.meta.url).pathname;
const rigs: any[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(r => r.close())); });
async function setup(options: Record<string, unknown> = {}) {
    const { fixtureRig } = await import(fixturePath); const rig = await fixtureRig(options); rigs.push(rig); return rig;
}
const create = (r: any, grant: string, requestID: string, options?: unknown) =>
    r.client.request('POST', '/tasks', { requestID, machineID: 'machineA', projectID: 'projectA', ...(options ? { options } : {}) }, grant);

describe('REST option discovery and allowlisted task creation', () => {
    it('discovers defaults only when the owner configured no allowlist', async () => {
        const r = await setup(), grant = await r.connect(); await r.startWorker();
        const reply = await r.client.request('GET', '/options?machineID=machineA', undefined, grant);
        expect(reply.ok).toBe(true);
        expect(reply.data.defaultAgent).toBe('codex');
        expect(reply.data.agents).toEqual([{ agent: 'codex', models: [], permissionModes: [], efforts: [],
            defaultModel: 'gpt-6.1-sol', defaultPermissionMode: 'default', defaultEffort: 'high' }]);
        const created = await create(r, grant, 'legacy');
        expect(created.data.options).toEqual({ agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'default', effort: 'high' });
        expect((await create(r, grant, 'denied', { permissionMode: 'yolo' })).error.code).toBe('OPTION_DENIED');
        expect(r.spawnCount).toBe(1);
    });
    it('discovers the narrowed catalog and spawns with an allowlisted yolo selection', async () => {
        const r = await setup({ launchOptions: policy }), grant = await r.connect(); await r.startWorker();
        const reply = await r.client.request('GET', '/options?machineID=machineA', undefined, grant);
        const codex = reply.data.agents.find((a: any) => a.agent === 'codex');
        expect(codex.models).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
        expect(codex.permissionModes).toEqual(['default', 'auto', 'yolo']);
        expect(reply.data.agents.find((a: any) => a.agent === 'claude').defaultEffort).toBe('');
        const created = await create(r, grant, 'yolo-task', { model: 'gpt-6-sol', permissionMode: 'yolo', effort: 'low' });
        expect(created.ok).toBe(true);
        expect(created.data.options).toEqual({ agent: 'codex', model: 'gpt-6-sol', permissionMode: 'yolo', effort: 'low' });
        expect(r.launches[0].options).toEqual({ agent: 'codex', model: 'gpt-6-sol', permissionMode: 'yolo', effort: 'low' });
        const claude = await create(r, grant, 'claude-task', { agent: 'claude', model: 'claude-opus-5', permissionMode: 'acceptEdits' });
        expect(claude.data.options).toEqual({ agent: 'claude', model: 'claude-opus-5', permissionMode: 'acceptEdits', effort: '' });
        expect((await create(r, grant, 'rogue', { permissionMode: 'safe-yolo' })).error.code).toBe('OPTION_DENIED');
        expect((await create(r, grant, 'rogue2', { agent: 'claude', permissionMode: 'bypassPermissions' })).error.code).toBe('OPTION_DENIED');
        expect(r.spawnCount).toBe(2);
    });
    it('enforces the grant’s own approved subset independently of the worker allowlist', async () => {
        const r = await setup({ launchOptions: policy });
        const grant = await r.connect({ options: { agents: [{ agent: 'codex', models: ['gpt-6-sol'], permissionModes: ['yolo'] }] } });
        await r.startWorker();
        const reply = await r.client.request('GET', '/options?machineID=machineA', undefined, grant);
        expect(reply.data.agents).toHaveLength(1);
        expect(reply.data.agents[0].models).toEqual(['gpt-6.1-sol', 'gpt-6-sol']);
        expect(reply.data.agents[0].permissionModes).toEqual(['default', 'yolo']);
        expect((await create(r, grant, 'auto-denied', { permissionMode: 'auto' })).error.code).toBe('OPTION_DENIED');
        expect((await create(r, grant, 'claude-denied', { agent: 'claude' })).error.code).toBe('OPTION_DENIED');
        expect((await create(r, grant, 'yolo-ok', { permissionMode: 'yolo' })).ok).toBe(true);
        expect(r.spawnCount).toBe(1);
    });
    it('rejects grant requests outside the worker allowlist and cross-machine discovery', async () => {
        const r = await setup({ launchOptions: policy });
        const denied = await r.client.request('POST', '/connections', { workerID: 'worker', machineID: 'machineA', projectID: 'projectA',
            methods: ['tasks.create'], expiresAt: Date.now() + 60000,
            options: { agents: [{ agent: 'codex', models: [], permissionModes: ['safe-yolo'] }] } });
        expect(denied.error.code).toBe('SCOPE_DENIED');
        const grant = await r.connect(); await r.startWorker();
        expect((await r.client.request('GET', '/options?machineID=other', undefined, grant)).error.code).toBe('SCOPE_DENIED');
    });
    it('keeps idempotency per options payload and passes options through startTask', async () => {
        const r = await setup({ launchOptions: policy }), grant = await r.connect(); await r.startWorker();
        expect((await create(r, grant, 'same', { permissionMode: 'yolo' })).ok).toBe(true);
        expect((await create(r, grant, 'same', { permissionMode: 'auto' })).error.code).toBe('REQUEST_ID_CONFLICT');
        expect((await create(r, grant, 'same', { permissionMode: 'yolo' })).ok).toBe(true);
        expect(r.spawnCount).toBe(1);
        const { startTask } = await import('./mcp');
        const started = await startTask(r.client, grant, { requestID: 'composite', machineID: 'machineA', projectID: 'projectA', text: 'fixture task',
            options: { agent: 'claude', permissionMode: 'acceptEdits' } });
        expect(started.result.data.state).toBe('submitted');
        expect(r.launches.at(-1).options).toEqual({ agent: 'claude', model: 'default', permissionMode: 'acceptEdits', effort: '' });
        // A delegated claude session must remain usable for status/logs, not
        // just for the initial send (flavor check in the core session lookup).
        expect((await r.client.request('GET', `/sessions/${started.sessionID}/status`, undefined, grant)).ok).toBe(true);
    });
});
