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
const renderers: ReturnType<typeof create>[] = [];
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; const original = console.error; vi.spyOn(console, 'error').mockImplementation((message, ...args) => { if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return; original(message, ...args); }); });
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach(r => r.unmount())));
beforeEach(() => { mocks.rpc.mockReset(); mocks.credentials = { token: 'account-token', secret: 'account-secret' }; mocks.rpc.mockResolvedValue({ ok: true, data: { revision: 1, connections: [], dots: [{ id: dotId, name: '代码助理', connectionIDs: [], projectBindings: {} }] } }); });
it('offers only MCP connections and never calls the retired REST endpoint', async () => {
 let renderer!: ReturnType<typeof create>;
 await act(async () => { renderer = create(React.createElement(DotsConnectionsPanel, { sessionId: 'workspace', workspaceId, dotId, onClose: vi.fn() })); }); renderers.push(renderer);
 expect(mocks.rpc).toHaveBeenCalledWith('workspace', 'testloop-mcp-connections', { action: 'list' });
 expect(mocks.rpc.mock.calls.every(call => call[1] === 'testloop-mcp-connections')).toBe(true);
 expect(renderer.root.findAllByType('Pressable').some((n: any) => n.props.accessibilityLabel === '添加 MCP 服务')).toBe(true);
 expect(JSON.stringify(renderer.toJSON())).not.toMatch(/旧连接迁移|REST|迁移到 MCP/);
});
it('hides the connection view when its account no longer matches', async () => {
 let renderer!: ReturnType<typeof create>;
 const props = { sessionId: 'workspace', workspaceId, dotId, onClose: vi.fn() };
 await act(async () => { renderer = create(React.createElement(DotsConnectionsPanel, props)); }); renderers.push(renderer);
 mocks.credentials = { token: 'other-account', secret: 'other-secret' }; mocks.ensure.mockImplementationOnce(async () => {});
 // A mismatched workspace binding must not expose the old account's private view.
 await act(async () => renderer.update(React.createElement(DotsConnectionsPanel, { ...props, workspaceId: 'different-workspace' })));
 expect(renderer.toJSON()).toBeNull();
});
