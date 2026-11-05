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
const view = () => ({ revision: 2, connections: [{ id: 'connection-a', name: '开发 REST', endpoint: 'https://control.example/happy-control/v1',
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
beforeEach(() => { mocks.rpc.mockReset(); mocks.rpc.mockResolvedValue({ ok: true, data: view() }); mocks.credentials = { token: 'account-token', secret: 'account-secret' }; });
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
it('uses workspace RPC and saves only the explicitly selected Dot project', async () => {
    const f = await render();
    expect(mocks.rpc).toHaveBeenCalledWith('workspace', 'testloop-rest-connections', { action: 'list' });
    expect(f.button('代码助理 使用 开发 REST 的 project-b').props.accessibilityState.checked).toBe(false);
    await f.click('代码助理 使用 开发 REST 的 project-b'); await f.click('保存 代码助理 的授权选择');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind', revision: 2, dotId,
        bindings: [{ connectionID: 'connection-a', projectIDs: ['project-b'] }] });
});
it('masks the token, submits it only through RPC, then clears it after an unconfirmed save', async () => {
    const f = await render(), token = 'hsvc1.fixture.secret';
    await f.change('连接名称', '新连接'); await f.change('REST 服务地址', 'https://control.example/happy-control/v1'); await f.change('服务访问令牌', token);
    expect(f.field('服务访问令牌').props.secureTextEntry).toBe(true);
    mocks.rpc.mockRejectedValueOnce(new Error('transport interrupted')); await f.click('核验并保存连接');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'add', token, name: '新连接', revision: 2 });
    expect(f.field('服务访问令牌').props.value).toBe('');
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain(token); expect(JSON.stringify(f.renderer.toJSON())).toContain('未确认操作结果');
});
it('clears the token on background', async () => {
    const f = await render(); await f.change('服务访问令牌', 'temporary-token'); await act(async () => mocks.background?.('background'));
    expect(f.field('服务访问令牌').props.value).toBe('');
});
it('ignores a late old-account response', async () => {
    const f = await render(); await f.change('连接名称', '旧账户连接'); await f.change('REST 服务地址', 'https://control.example/happy-control/v1'); await f.change('服务访问令牌', 'old-token');
    let resolve!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(done => { resolve = done; })); await f.click('核验并保存连接');
    mocks.credentials = { token: 'other-account', secret: 'other-secret' };
    await act(async () => f.renderer.update(React.createElement(DotsConnectionsPanel, f.props)));
    const old = view(); old.connections[0].name = '旧账户响应'; await act(async () => resolve({ ok: true, data: old }));
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('旧账户响应'); expect(f.field('服务访问令牌').props.value).toBe('');
});
it('the Dot entry can explicitly remove all project bindings without collecting a credential', async () => {
    const f = await render(dotId); expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0); await f.click('保存 代码助理 的授权选择');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind', dotId, bindings: [] });
});
