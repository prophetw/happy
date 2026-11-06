import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), background: null as null | ((state: string) => void),
    credentials: { token: 'account-token', secret: 'account-secret' }, ensure: vi.fn(async () => {}), uuid: 0 }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: mocks.credentials, isAuthenticated: true }) }));
vi.mock('@/sync/sync', () => ({ sync: { getCredentials: () => mocks.credentials, ensureSessionReady: mocks.ensure } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://relay.example' }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: { workspace: { metadata: { testloopDots: {
    schemaVersion: 1, kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111',
} } } } }) } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `33333333-3333-4333-8333-${String(++mocks.uuid).padStart(12, '0')}` }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'),
        ScrollView: host('ScrollView'), Modal: host('Modal'), ActivityIndicator: host('ActivityIndicator'),
        AppState: { addEventListener: (_: string, callback: (value: string) => void) => { mocks.background = callback; return { remove: vi.fn() }; } } };
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc',
} } }) }));
import { DotsConnectionsPanel } from './DotsConnectionsPanel';
const workspaceId = '11111111-1111-4111-8111-111111111111', dotId = '22222222-2222-4222-8222-222222222222';
const view = () => ({ revision: 2, capabilities: { credentialPreview: 1, replaceAuthorization: 1 }, connections: [{ id: 'connection-a', name: '开发 REST', endpoint: 'https://control.example/happy-control/v1',
    grantID: 'grant-a', machineID: 'machine-a', projects: [{ id: 'project-a', directory: '/code/a' }, { id: 'project-b', directory: '/code/b' }],
    methods: ['tasks.create', 'sessions.send'], expiresAt: Date.now() + 3600000, enabled: true, source: 'configured', checkedAt: new Date().toISOString(),
    error: null, credentialSource: 'stored', credentialConfigured: true, status: 'verified' }],
    dots: [{ id: dotId, name: '代码助理', source: 'explicit', bindings: [] }] });
const renderers: ReturnType<typeof create>[] = [];
beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach(renderer => renderer.unmount())));
const mcpView = () => ({ revision: 4, capabilities: { storedToken: 1, happyDelegation: 1, migrateRest: 1 }, connections: [],
    dots: [{ id: dotId, name: '代码助理', connectionIDs: [] }] });
beforeEach(() => {
    mocks.rpc.mockReset(); mocks.credentials = { token: 'account-token', secret: 'account-secret' };
    mocks.rpc.mockImplementation(async (_session, method) => ({ ok: true, data: method === 'testloop-rest-connections' ? view() : mcpView() }));
});
async function render(dot?: string) {
    let renderer!: ReturnType<typeof create>;
    const props = { sessionId: 'workspace', workspaceId, dotId: dot, onClose: vi.fn() };
    await act(async () => { renderer = create(React.createElement(DotsConnectionsPanel, props)); }); renderers.push(renderer);
    const field = (name: string) => renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === name)!;
    const button = (name: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === name)!;
    const change = async (name: string, value: string) => act(async () => field(name).props.onChangeText(value));
    const click = async (name: string) => act(async () => button(name).props.onPress());
    return { renderer, props, field, change, click, button };
}
it('opens MCP by default, including a specific Dot, without querying the REST connection interface', async () => {
    const f = await render(dotId);
    expect(mocks.rpc).toHaveBeenCalledWith('workspace', 'testloop-mcp-connections', { action: 'list' });
    expect(mocks.rpc.mock.calls.every(call => call[1] === 'testloop-mcp-connections')).toBe(true);
    expect(f.button('添加 MCP 服务')).toBeTruthy();
    expect(f.button('添加连接')).toBeUndefined();
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
});
it('shows legacy records only after explicit navigation and offers no REST token editor', async () => {
    const old = view(); old.dots[0].bindings = [{ connectionID: 'connection-a', projectIDs: ['project-a'] }] as never;
    mocks.rpc.mockImplementation(async (_session, method) => ({ ok: true, data: method === 'testloop-rest-connections' ? old : mcpView() }));
    const f = await render(); await f.click('旧连接迁移');
    expect(JSON.stringify(f.renderer.toJSON())).toContain('/code/a');
    expect(f.button('迁移到 MCP：开发 REST')).toBeTruthy();
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    expect(mocks.rpc.mock.calls.every(call => call[2].action === 'list')).toBe(true);
});
it('migrates once using both revisions, then opens the unified MCP interface', async () => {
    const f = await render(); await f.click('旧连接迁移'); await f.click('迁移到 MCP：开发 REST');
    const writes = mocks.rpc.mock.calls.filter(call => call[2].action !== 'list');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual(['workspace', 'testloop-mcp-connections', expect.objectContaining({
        action: 'migrate-rest', connectionID: 'connection-a', revision: 4, restRevision: 2,
    })]);
    expect(f.button('添加 MCP 服务')).toBeTruthy();
});
it('resolves a lost migration response by explicit refresh without sending migration twice', async () => {
    let migrated = false;
    mocks.rpc.mockImplementation(async (_session, method, request) => {
        if (request.action === 'migrate-rest') { migrated = true; throw Error('private transport details'); }
        const old = view();
        if (migrated) Object.assign(old.connections[0], { migratedToMcp: 'mcp-existing' });
        return { ok: true, data: method === 'testloop-rest-connections' ? old : mcpView() };
    });
    const f = await render(); await f.click('旧连接迁移'); await f.click('迁移到 MCP：开发 REST');
    expect(JSON.stringify(f.renderer.toJSON())).toContain('未收到操作结果');
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('private transport details');
    expect(f.button('迁移到 MCP：开发 REST')).toBeUndefined();
    await f.click('刷新旧连接');
    expect(JSON.stringify(f.renderer.toJSON())).toContain('已迁移到 MCP');
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'migrate-rest')).toHaveLength(1);
});
it('discards a late legacy response after switching account and returns to MCP', async () => {
    let finish!: (value: unknown) => void;
    mocks.rpc.mockImplementation(async (_session, method) => method === 'testloop-rest-connections'
        ? await new Promise(resolve => { finish = resolve; }) : { ok: true, data: mcpView() });
    const f = await render(); await f.click('旧连接迁移');
    mocks.credentials = { token: 'new-account', secret: 'new-secret' };
    await act(async () => f.renderer.update(React.createElement(DotsConnectionsPanel, f.props)));
    const old = view(); old.connections[0].name = 'Old private connection';
    await act(async () => finish({ ok: true, data: old }));
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('Old private connection');
    expect(f.button('添加 MCP 服务')).toBeTruthy();
});
it('disables migration when the host has not advertised migration support', async () => {
    mocks.rpc.mockImplementation(async (_session, method) => ({ ok: true, data: method === 'testloop-rest-connections'
        ? view() : { ...mcpView(), capabilities: { storedToken: 1 } } }));
    const f = await render(); await f.click('旧连接迁移');
    expect(f.button('迁移到 MCP：开发 REST').props.disabled).toBe(true);
    expect(mocks.rpc.mock.calls.every(call => call[2].action === 'list')).toBe(true);
});
