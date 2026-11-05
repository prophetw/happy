import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), uuid: 0, background: null as null | ((state: string) => void) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `33333333-3333-4333-8333-${String(++mocks.uuid).padStart(12, '0')}` }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
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
beforeEach(() => { mocks.background = null; mocks.rpc.mockReset(); mocks.rpc.mockResolvedValue({ ok: true, data: view() }); });
async function render(dot?: string) {
    let renderer!: ReturnType<typeof create>; let authorized = true;
    await act(async () => { renderer = create(React.createElement(DotsMcpPanel, { sessionId: 'workspace', dotId: dot, current: () => authorized })); });
    renderers.push(renderer);
    const button = (name: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === name);
    const click = async (name: string) => { expect(button(name)).toBeTruthy(); await act(async () => button(name).props.onPress()); };
    const fill = async (label: string, value: string) => { await act(async () => renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === label).props.onChangeText(value)); };
    return { renderer, button, click, fill, revoke: () => { authorized = false; } };
}
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
    const f = await render(); await f.click('编辑 MCP：事实工具');
    const field = f.renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === 'MCP Token');
    expect(field.props.value).toBe(''); await f.click('检查并保存 MCP');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).not.toHaveProperty('token');
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
