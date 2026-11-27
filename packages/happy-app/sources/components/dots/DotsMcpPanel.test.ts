import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), ready: vi.fn(async () => {}), uuid: 0, background: null as null | ((state: string) => void) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: mocks.ready } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `33333333-3333-4333-8333-${String(++mocks.uuid).padStart(12, '0')}` }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return { Platform: { OS: 'web' }, View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
        AppState: { addEventListener: (_: string, callback: (state: string) => void) => { mocks.background = callback; return { remove: vi.fn() }; } } };
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc',
} } }) }));
import { DotsMcpPanel } from './DotsMcpPanel';
import { requestDotsMcp } from '@/sync/dotsMcpConnections';
const dotId = '22222222-2222-4222-8222-222222222222';
const view = () => ({ revision: 2, capabilities: { storedToken: 1 }, connections: [{ id: 'facts', name: '事实工具', config: { url: 'https://mcp.example/mcp' }, enabled: true,
    checkedAt: '2026-11-05T00:00:00Z', error: null, tools: [{ name: 'lookup', description: 'Read a fact' }] }],
    dots: [{ id: dotId, name: 'Dot A', connectionIDs: [] }, { id: 'other', name: 'Dot B', connectionIDs: [] }] });
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
function mockView(initial: any) {
    let data = structuredClone(initial);
    mocks.rpc.mockImplementation(async (_session, _method, request) => {
        const dot = data.dots.find((item: any) => item.id === request.dotId);
        if (request.action === 'bind') {
            dot.connectionIDs = request.connectionIDs;
            for (const id of Object.keys(dot.projectBindings ?? {})) if (!dot.connectionIDs.includes(id)) delete dot.projectBindings[id];
        } else if (request.action === 'bind-projects') {
            dot.projectBindings ??= {}; dot.projectBindings[request.connectionID] = request.projectIDs;
        }
        if (request.action !== 'list') data.revision++;
        return { ok: true, data: structuredClone(data) };
    });
}
beforeEach(() => { mocks.background = null; mocks.ready.mockReset(); mocks.ready.mockResolvedValue(undefined); mocks.rpc.mockReset(); mockView(view()); });

async function render(dot?: string) {
    let renderer!: ReturnType<typeof create>; let authorized = true;
    await act(async () => { renderer = create(React.createElement(DotsMcpPanel, { sessionId: 'workspace', dotId: dot, current: () => authorized })); });
    renderers.push(renderer);
    const button = (name: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === name);
    const click = async (name: string) => { expect(button(name)).toBeTruthy(); await act(async () => button(name).props.onPress()); };
    const fill = async (label: string, value: string) => { await act(async () => renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === label).props.onChangeText(value)); };
    const disclosure = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel?.startsWith('查看 MCP：'));
    if (disclosure) await act(async () => disclosure.props.onPress());
    return { renderer, button, click, fill, revoke: () => { authorized = false; } };
}
it('requires explicit project selection for Happy background execution', async () => {
    const base = view();
    const data = { ...base, capabilities: { storedToken: 1, happyDelegation: 1 },
        connections: [{ ...base.connections[0], control: { grantID: 'fixture-grant', machineID: 'machine', expiresAt: Date.now() + 60000,
            methods: ['tasks.create'], projects: [{ id: 'a', directory: '/fixture/a' }, { id: 'b', directory: '/fixture/b' }] } }],
        dots: [{ ...base.dots[0], connectionIDs: ['facts'], projectBindings: {} }] };
    mockView(data);
    const f = await render(dotId);
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(false);
    expect(f.button('为 Dot A 启用项目 b').props.accessibilityState.checked).toBe(false);
    await f.click('为 Dot A 启用项目 a');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind-projects', dotId, connectionID: 'facts', projectIDs: ['a'], revision: 2 });
});
it('rechecks authorization after preparing the encrypted session and sends no stale mutation', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.fill('MCP 名称', 'Fixture');
    let finish!: () => void; mocks.ready.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const count = mocks.rpc.mock.calls.length;
    await act(async () => { f.button('检查并保存 MCP').props.onPress(); });
    f.revoke(); await act(async () => finish());
    expect(mocks.rpc).toHaveBeenCalledTimes(count);
});
it('preserves other selected projects when changing a Happy project checkbox', async () => {
    const base = view();
    const data = { ...base, connections: [{ ...base.connections[0], control: { grantID: 'fixture-grant', machineID: 'machine',
        expiresAt: Date.now() + 60000, methods: [], projects: [{ id: 'a', directory: '/fixture/a' }, { id: 'b', directory: '/fixture/b' }] } }],
        dots: [{ ...base.dots[0], connectionIDs: ['facts'], projectBindings: { facts: ['a', 'b'] } }] };
    mockView(data); const f = await render(dotId);
    await f.click('为 Dot A 启用项目 a');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind-projects', dotId, projectIDs: ['b'] });
});
it('checks and saves HTTP config with environment references through MCP RPC', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.fill('MCP 名称', 'Docs');
    await f.fill('MCP JSON 配置', JSON.stringify({ url: 'https://mcp.example/mcp', bearer_token_env_var: 'MY_TOKEN', enabled_tools: ['lookup'] }));
    await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)).toEqual(['workspace', 'testloop-mcp-connections', expect.objectContaining({ action: 'save', revision: 2, name: 'Docs',
        config: { url: 'https://mcp.example/mcp', bearer_token_env_var: 'MY_TOKEN', enabled_tools: ['lookup'] } })]);
});
it('fills and saves the Happy Control preset without embedding a credential', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.click('Happy Control 配置示例'); await f.click('检查并保存 MCP');
    const call = mocks.rpc.mock.calls.at(-1);
    expect(call).toEqual(['workspace', 'testloop-mcp-connections', expect.objectContaining({ action: 'save', revision: 2, name: 'Happy Control',
        config: { url: 'https://example.com/happy-control/mcp' } })]);
    expect(call?.[2].config).not.toHaveProperty('token');
    expect(JSON.stringify(call)).not.toContain('hsvc1');
});
it('keeps the stdio preset on the existing MCP save path', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.click('stdio 配置示例'); await f.fill('MCP 名称', 'Local'); await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)).toEqual(['workspace', 'testloop-mcp-connections', expect.objectContaining({ action: 'save', revision: 2, name: 'Local',
        config: { command: 'node', args: ['/absolute/path/server.mjs'], env_vars: ['MY_MCP_TOKEN'] } })]);
});
it('rejects invalid JSON before sending a mutation', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.fill('MCP 名称', 'Docs'); await f.fill('MCP JSON 配置', '{'); await f.click('检查并保存 MCP');
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.renderer.toJSON())).toContain('有效的 JSON');
});
it('binds only the selected Dot and supports disable/delete management', async () => {
    const f = await render(dotId);
    expect(f.button('为 Dot B 启用 MCP 事实工具')).toBeUndefined();
    await f.click('为 Dot A 启用 MCP 事实工具');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind', dotId, connectionIDs: ['facts'] });
    await f.click('停用 MCP：事实工具'); expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'enable', connectionID: 'facts', enabled: false });
    await f.click('删除 MCP：事实工具'); expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'delete', connectionID: 'facts' });
});
it('edits existing configuration and displays server-reported check failures', async () => {
    const f = await render(); await f.click('编辑 MCP：事实工具'); await f.fill('MCP 名称', 'Renamed'); await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'save', connectionID: 'facts', name: 'Renamed' });
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...view(), connections: [{ ...view().connections[0], error: 'mcp_environment_missing' }] } });
    await f.click('检查 MCP：事实工具'); expect(JSON.stringify(f.renderer.toJSON())).toContain('宿主缺少配置中引用的环境变量');
});
it('retains a stale edit after reading the new revision and blocks saving it over a concurrent change', async () => {
    const f = await render();
    await f.click('编辑 MCP：事实工具');
    await f.fill('MCP 名称', '我的草稿');
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'mcp_revision_changed' });
    await f.click('检查并保存 MCP');
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...view(), revision: 3,
        connections: [{ ...view().connections[0], name: '另一处保存的名称' }] } });
    await f.click('刷新 MCP 连接');
    const field = f.renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === 'MCP 名称');
    expect(field.props.value).toBe('我的草稿');
    expect(f.button('查看 MCP：另一处保存的名称')).toBeTruthy();
    expect(f.button('检查并保存 MCP').props.disabled).toBe(true);
    await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.map(call => call[2].action)).toEqual(['list', 'save', 'list']);
});

it('does not retry unconfirmed writes and prevents requests after losing account scope', async () => {
    const f = await render(); mocks.rpc.mockRejectedValueOnce(new Error('offline')); await f.click('删除 MCP：事实工具');
    expect(mocks.rpc).toHaveBeenCalledTimes(2); expect(JSON.stringify(f.renderer.toJSON())).toContain('不会自动重发');
    f.revoke(); await f.click('刷新 MCP 连接'); expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
it('validates malformed RPC envelopes', async () => {
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { revision: 0 } });
    await expect(requestDotsMcp('workspace', { action: 'list' })).rejects.toThrow('mcp_response_unconfirmed');
});

it('accepts a pasted token in a masked field and clears it after saving', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.fill('MCP 名称', 'Private');
    await f.fill('MCP JSON 配置', JSON.stringify({ url: 'https://mcp.example/mcp' }));
    await f.fill('MCP Token', 'private-token');
    const field = f.renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === 'MCP Token');
    expect(field.props.secureTextEntry).toBe(true);
    await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'save', config: { url: 'https://mcp.example/mcp' }, token: 'private-token' });
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('private-token');
});
it('does not prefill or replace an existing token unless explicitly requested', async () => {
    mocks.rpc.mockResolvedValue({ ok: true, data: { ...view(), connections: [{ ...view().connections[0], tokenConfigured: true, credentialSource: 'stored' }] } });
    const result = { ...view(), connections: [{ ...view().connections[0], tokenConfigured: true, credentialSource: 'stored' }] };
    const f = await render(); await f.click('编辑 MCP：事实工具');
    mocks.rpc.mockResolvedValue({ ok: true, data: { ...result, revision: 3 } });
    const field = f.renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === 'MCP Token');
    expect(field.props.value).toBe(''); await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).not.toHaveProperty('token');
    mocks.rpc.mockResolvedValue({ ok: true, data: { ...result, revision: 4 } });
    await f.click('编辑 MCP：事实工具'); await f.click('清除已保存 Token'); await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toHaveProperty('token', null);
});
it('clears unsaved tokens on failure and when the app enters the background', async () => {
    const f = await render(); await f.click('添加 MCP 服务'); await f.fill('MCP 名称', 'Private'); await f.fill('MCP Token', 'private-token');
    await act(async () => mocks.background?.('background'));
    const field = () => f.renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === 'MCP Token');
    expect(field().props.value).toBe(''); await f.fill('MCP Token', 'replacement-token');
    mocks.rpc.mockRejectedValueOnce(new Error('offline')); await f.click('检查并保存 MCP'); expect(field().props.value).toBe('');
});

// Stateful RPC fixture applies the existing two-step backend contract, not UI logic.
function projectFixture() {
    const base = view();
    const connection = (id: string) => ({ ...base.connections[0], id, name: id, control: {
        grantID: 'fixture-grant', machineID: 'fixture-machine', expiresAt: Date.now() + 60000,
        methods: [], projects: [{ id: 'a', directory: '/fixture/a' }, { id: 'b', directory: '/fixture/b' }],
    } });
    let data = { ...base, connections: [connection('first'), connection('second')], dots: [
        { ...base.dots[0], connectionIDs: ['second'], projectBindings: { second: ['a'] } as Record<string, string[]> },
    ] };
    mocks.rpc.mockImplementation(async (_session, _method, request) => {
        if (request.action !== 'list') {
            expect(request.revision).toBe(data.revision);
            const dot = data.dots[0];
            if (request.action === 'bind') {
                dot.connectionIDs = request.connectionIDs;
                for (const id of Object.keys(dot.projectBindings)) if (!dot.connectionIDs.includes(id)) delete dot.projectBindings[id];
            } else if (request.action === 'bind-projects') {
                expect(dot.connectionIDs).toContain(request.connectionID);
                dot.projectBindings[request.connectionID] = request.projectIDs;
            }
            data.revision++;
        }
        return { ok: true, data: structuredClone(data) };
    });
    return { data };
}
it('selects all current children on explicit parent enable, saves individual changes and clears only that group', async () => {
    const { data } = projectFixture(); const f = await render(dotId);
    await f.click('为 Dot A 启用 MCP first');
    expect(data.dots[0].projectBindings.first).toEqual(['a', 'b']);
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(true);
    await f.click('为 Dot A 启用项目 a');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'bind-projects', connectionID: 'first', projectIDs: ['b'] });
    expect(data.dots[0].projectBindings.second).toEqual(['a']);
    await f.click('为 Dot A 启用 MCP first');
    expect(data.dots[0].projectBindings).toEqual({ second: ['a'] });
    expect(data.dots[0].connectionIDs).toEqual(['second']);
});
it('never expands restored partial grants on refresh, discovery or reopening', async () => {
    const { data } = projectFixture(); data.dots[0].connectionIDs.push('first'); data.dots[0].projectBindings.first = ['a'];
    const f = await render(dotId);
    data.connections[0].control.projects.push({ id: 'future', directory: '/fixture/future' });
    await f.click('刷新 MCP 连接');
    expect(f.button('为 Dot A 启用项目 b').props.accessibilityState.checked).toBe(false);
    expect(f.button('为 Dot A 启用项目 future').props.accessibilityState.checked).toBe(false);
    await render(dotId);
    expect(data.dots[0].projectBindings.first).toEqual(['a']);
    expect(mocks.rpc.mock.calls.every(call => call[2].action === 'list')).toBe(true);
});
it('keeps truthful connection-only state when project saving fails and never retries it on refresh', async () => {
    projectFixture(); const f = await render(dotId);
    const backend = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (...args) => args[2].action === 'bind-projects' ? { ok: false, error: 'mcp_project_limit' } : backend(...args));
    await f.click('为 Dot A 启用 MCP first');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(true);
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(false);
    expect(JSON.stringify(f.renderer.toJSON())).toContain('最多启用 16');
    await f.click('刷新 MCP 连接');
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'bind-projects')).toHaveLength(1);
});

it('retries a definitively rejected selection only when explicitly requested', async () => {
    const { data } = projectFixture();
    const f = await render(dotId);
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'mcp_project_limit' });
    await f.click('为 Dot A 启用 MCP first');
    expect(data.dots[0].connectionIDs).toEqual(['second']);
    await f.click('重试保存选择');
    expect(data.dots[0].projectBindings.first).toEqual(['a', 'b']);
    expect(f.button('重试保存选择')).toBeUndefined();
});

it('shows a pending selection while binding and selects only the click snapshot after the response', async () => {
    const { data } = projectFixture(); const f = await render(dotId);
    const backend = mocks.rpc.getMockImplementation()!;
    let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    expect(f.button('为 Dot A 启用 MCP first').props.disabled).toBe(false);
    data.connections[0].control.projects.push({ id: 'future', directory: '/fixture/future' });
    await act(async () => finish());
    expect(data.dots[0].projectBindings.first).toEqual(['a', 'b']);
    expect(f.button('为 Dot A 启用项目 future').props.accessibilityState.checked).toBe(false);
});
it('does not save project selections after losing scope during the parent RPC', async () => {
    projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementationOnce(async (...args) => { const reply = await backend(...args); f.revoke(); return reply; });
    await f.click('为 Dot A 启用 MCP first');
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'bind-projects')).toHaveLength(0);
});

it('shows pending parent and children before a slow RPC, and coalesces cancellation before project grant', async () => {
    const { data } = projectFixture(); const f = await render(dotId);
    const backend = mocks.rpc.getMockImplementation()!;
    let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(true);
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(true);
    expect(JSON.stringify(f.renderer.toJSON())).toContain('正在保存选择');
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('已保存。');
    await f.click('为 Dot A 启用 MCP first');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(false);
    await act(async () => finish());
    expect(data.dots[0].connectionIDs).toEqual(['second']);
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'bind-projects')).toHaveLength(0);
});
it('uses the latest individual selection after a slow parent acknowledgement', async () => {
    const { data } = projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    await f.click('为 Dot A 启用项目 a');
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(false);
    await act(async () => finish());
    expect(data.dots[0].projectBindings).toEqual({ second: ['a'], first: ['b'] });
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'bind-projects').map(call => call[2].projectIDs)).toEqual([['b']]);
});

it('serializes slow project writes and keeps a later cancellation and another group isolated', async () => {
    const { data } = projectFixture(); const f = await render(dotId);
    await f.click('为 Dot A 启用 MCP first');
    const backend = mocks.rpc.getMockImplementation()!; let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用项目 a').props.onPress());
    const sent = mocks.rpc.mock.calls.length;
    await f.click('为 Dot A 启用项目 b');
    // Only one write may be in flight, so responses cannot overtake each other.
    expect(mocks.rpc).toHaveBeenCalledTimes(sent);
    expect(f.button('为 Dot A 启用项目 b').props.accessibilityState.checked).toBe(false);
    await act(async () => finish());
    expect(data.dots[0].projectBindings).toEqual({ first: [], second: ['a'] });
    expect(data.dots[0].connectionIDs).toContain('first');
});
it('coalesces rapid parent on/off/on into the final selection', async () => {
    const { data } = projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    await f.click('为 Dot A 启用 MCP first'); await f.click('为 Dot A 启用 MCP first');
    await act(async () => finish());
    expect(data.dots[0].projectBindings.first).toEqual(['a', 'b']);
    expect(mocks.rpc.mock.calls.filter(call => call[2].action !== 'list').map(call => call[2].action)).toEqual(['bind', 'bind-projects']);
});
it('rolls back a rejected parent draft and never displays saved success', async () => {
    projectFixture(); const f = await render(dotId);
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'mcp_scope_denied' });
    await f.click('为 Dot A 启用 MCP first');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(false);
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('已保存。');
    expect(JSON.stringify(f.renderer.toJSON())).toContain('超出当前连接授权范围');
});
it('reconciles an unknown committed write by reading, never by replaying or continuing queued edits', async () => {
    const { data } = projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementationOnce(async (...args) => { await backend(...args); throw Error('lost ack'); });
    await f.click('为 Dot A 启用 MCP first');
    expect(data.dots[0].connectionIDs).toContain('first');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(false);
    expect(f.button('为 Dot A 启用 MCP first').props.disabled).toBe(true);
    const sent = mocks.rpc.mock.calls.length;
    await f.click('为 Dot A 启用 MCP first');
    expect(mocks.rpc).toHaveBeenCalledTimes(sent);
    await f.click('刷新 MCP 连接');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(true);
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(false);
    expect(mocks.rpc.mock.calls.filter(call => call[2].action !== 'list')).toHaveLength(1);
});
it('renders the pending selection even while session preparation has not resolved', async () => {
    projectFixture(); const f = await render(dotId); let finish!: () => void;
    mocks.ready.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const sent = mocks.rpc.mock.calls.length;
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    expect(f.button('为 Dot A 启用项目 a').props.accessibilityState.checked).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledTimes(sent);
    await act(async () => finish());
});
it('ignores an old selection response after changing session scope', async () => {
    projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    let finish!: () => void;
    mocks.rpc.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return backend(...args); });
    await act(async () => f.button('为 Dot A 启用 MCP first').props.onPress());
    await act(async () => f.renderer.update(React.createElement(DotsMcpPanel, { sessionId: 'different-workspace', dotId, current: () => true })));
    await act(async () => finish());
    await f.click('查看 MCP：first');
    expect(f.button('为 Dot A 启用 MCP first').props.accessibilityState.checked).toBe(false);
    expect(mocks.rpc.mock.calls.filter(call => call[2].action === 'bind-projects')).toHaveLength(0);
});

it.each(['bind', 'bind-projects'])('stops after a duplicate-ID %s acknowledgement instead of confirming a missing selection', async action => {
    projectFixture(); const f = await render(dotId); const backend = mocks.rpc.getMockImplementation()!;
    let corrupted = false;
    mocks.rpc.mockImplementation(async (...args) => {
        const result = await backend(...args);
        if (!corrupted && args[2].action === action) {
            corrupted = true;
            if (action === 'bind') result.data.dots[0].connectionIDs = ['second', 'second'];
            else result.data.dots[0].projectBindings.first = ['a', 'a'];
        }
        return result;
    });
    await f.click('为 Dot A 启用 MCP first');
    const writes = mocks.rpc.mock.calls.filter(call => call[2].action !== 'list');
    expect(writes).toHaveLength(action === 'bind' ? 1 : 2);
    expect(f.button('为 Dot A 启用 MCP first').props.disabled).toBe(true);
    expect(JSON.stringify(f.renderer.toJSON())).toContain('保存结果待核对');
    expect(JSON.stringify(f.renderer.toJSON())).not.toContain('已保存。');
    await f.click('为 Dot A 启用 MCP first');
    expect(mocks.rpc.mock.calls.filter(call => call[2].action !== 'list')).toHaveLength(writes.length);
});
