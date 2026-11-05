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
const preview = { endpoint: 'https://control.example/happy-control/v1', grantID: 'new-grant', machineID: 'machine-a',
    projects: [{ id: 'project-a', directory: '/code/a' }, { id: 'project-b', directory: '/code/b' }],
    methods: ['tasks.create'], expiresAt: Date.now() + 3600000, digest: 'verified-scope' };
async function credentialForm(f: Awaited<ReturnType<typeof render>>) {
    await f.click('添加连接'); await f.change('连接名称', '新连接');
    await f.change('REST 服务地址', 'https://control.example/happy-control/v1/');
    await f.change('服务访问令牌', 'hsvc1.fixture.secret');
}
it('chooses an existing connection and grants only the selected project', async () => {
    const f = await render(dotId);
    expect(mocks.rpc).toHaveBeenCalledWith('workspace', 'testloop-rest-connections', { action: 'list' });
    await f.click('选择连接'); await f.click('使用连接：开发 REST');
    expect(f.button('启用项目 project-b').props.accessibilityState.checked).toBe(false);
    await f.click('启用项目 project-b'); await f.click('保存项目选择');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind', revision: 2, dotId,
        bindings: [{ connectionID: 'connection-a', projectIDs: ['project-b'] }] });
    await f.click('返回'); expect(f.button('我的连接')).toBeTruthy();
});
it('previews a masked credential without saving, then saves selected scope atomically', async () => {
    const f = await render(); await credentialForm(f);
    expect(f.field('服务访问令牌').props.secureTextEntry).toBe(true);
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { preview } }); await f.click('验证授权');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toEqual({ action: 'preview', endpoint: 'https://control.example/happy-control/v1/', token: 'hsvc1.fixture.secret' });
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'add')).toHaveLength(0);
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('hsvc1.fixture.secret');
    await f.click('授权给 代码助理'); await f.click('全选项目'); await f.click('保存连接与授权');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'add', name: '新连接', previewDigest: preview.digest,
        token: 'hsvc1.fixture.secret', assignment: { dotId, projectIDs: ['project-a', 'project-b'] } });
});
it('replaces an existing Dot grant through an explicit preview and project selection', async () => {
    const bound = view(); bound.dots[0].bindings = [{ connectionID: 'connection-a', projectIDs: ['project-a'] }] as never;
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: bound });
    const f = await render(dotId); await f.click('更新服务令牌：开发 REST');
    await f.change('服务访问令牌', 'hsvc1.fixture.secret');
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { preview } }); await f.click('验证授权');
    expect(f.button('保存并替换授权').props.disabled).toBe(true);
    await f.click('全选项目'); await f.click('保存并替换授权');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'replace', connectionID: 'connection-a',
        assignments: [{ dotId, projectIDs: ['project-a', 'project-b'] }], previewDigest: preview.digest });
});
it('clears the token and offers a read-only refresh after an unconfirmed response', async () => {
    const f = await render(); await credentialForm(f);
    mocks.rpc.mockRejectedValueOnce(new Error('transport interrupted')); await f.click('验证授权');
    expect(f.field('服务访问令牌').props.value).toBe('');
    expect(JSON.stringify(f.renderer.toJSON())).toContain('未收到保存结果');
    await f.click('刷新核对'); expect(mocks.rpc.mock.calls.at(-1)?.[2]).toEqual({ action: 'list' });
});
it('invalidates a verified credential when the app enters the background', async () => {
    const f = await render(); await credentialForm(f);
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { preview } }); await f.click('验证授权');
    await act(async () => mocks.background?.('background'));
    expect(f.field('服务访问令牌').props.value).toBe('');
    expect(f.button('验证授权').props.disabled).toBe(true);
});
it('ignores a late old-account response and clears the credential form', async () => {
    const f = await render(); await credentialForm(f);
    let resolve!: (value: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(done => { resolve = done; })); await f.click('验证授权');
    mocks.credentials = { token: 'other-account', secret: 'other-secret' };
    await act(async () => f.renderer.update(React.createElement(DotsConnectionsPanel, f.props)));
    await act(async () => resolve({ ok: true, data: { preview } }));
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('核对授权与项目');
    await f.click('添加连接'); expect(f.field('服务访问令牌').props.value).toBe('');
});
it('allows explicit removal from the Dot entry without collecting credentials', async () => {
    const bound = view(); bound.dots[0].bindings = [{ connectionID: 'connection-a', projectIDs: ['project-a'] }] as never;
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: bound }); const f = await render(dotId);
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0); await f.click('解除连接：开发 REST');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind', dotId, bindings: [] });
});
