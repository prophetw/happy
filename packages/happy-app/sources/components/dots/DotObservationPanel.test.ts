import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), ready: vi.fn(), background: null as null | ((state: string) => void),
    credentials: { token: 'account', secret: 'secret' }, server: 'https://relay.example', authenticated: true }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: mocks.credentials, isAuthenticated: mocks.authenticated }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: mocks.ready, getCredentials: () => mocks.credentials } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {
    workspace: { metadata: { testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId: '11111111-1111-4111-8111-111111111111' } } },
    dotSession: { metadata: { testloopDots: { schemaVersion: 1, kind: 'dot', workspaceId: '11111111-1111-4111-8111-111111111111',
        workspaceSessionId: 'workspace', dotId: '22222222-2222-4222-8222-222222222222' } } },
} }) } }));
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
        AppState: { addEventListener: (_: string, callback: (state: string) => void) => { mocks.background = callback; return { remove: vi.fn() }; } } };
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surfaceHigh: '#eee', divider: '#ccc' } } }) }));
import { DotObservationPanel } from './DotObservationPanel';
const workspaceId = '11111111-1111-4111-8111-111111111111', dotId = '22222222-2222-4222-8222-222222222222';
const turnId = '33333333-3333-4333-8333-333333333333', keyDigest = 'sha256:' + 'b'.repeat(64), snapshotId = 'sha256:' + 'a'.repeat(64);
const at = '2026-11-05T00:00:00Z', base = { schemaVersion: 1, dotId, asOf: at, snapshotId };
const overview = () => ({ ...base, action: 'overview', dot: { id: dotId, name: 'Dot A', instruction: '观察职责', createdAt: at },
    host: { status: 'healthy', heartbeatAt: at, error: null }, channel: { lastSuccessAt: at, error: null }, processing: false, tasks: [], taskTotal: 0,
    memory: { total: 1, access: ['read', 'write', 'forget'], counts: { effective: 1, unconfirmed: 0, expired: 0, deleted: 0 } },
    retention: { startedAt: at, retainedFrom: at, droppedEvents: 0, eventLimit: 500, selectionTurnLimit: 20, selectionTurns: [turnId] } });
const paged = (items: unknown[], extra = {}) => ({ items, total: items.length, offset: 0, nextOffset: null, ...extra });
const summary = { id: turnId, seq: 1, createdAt: at, status: 'applied', source: 'user', trigger: { text: '原交办', truncated: false }, contextAvailable: true, error: null };
const event = { id: '1', sequence: 1, at, kind: 'turn', entityId: turnId, status: 'applied', previousStatus: 'planning', reason: null,
    workId: null, turnId, keyDigest: null, label: null };
function response(query: any): unknown {
    if (query.action === 'overview') return { ...overview(), scope: query.scope ?? 'dot' };
    if (query.action === 'activity') return { ...base, action: 'activity', page: paged([event]) };
    if (query.action === 'memories') return { ...base, action: 'memories', scope: query.scope ?? 'dot', page: paged([{ keyDigest, key: '偏好', revision: 2, status: 'effective', preview: { text: '新版', truncated: false } }]) };
    if (query.action === 'turns') return { ...base, action: 'turns', page: paged([summary]) };
    if (query.action === 'memory' && query.section === 'usage') return { ...base, action: 'memory', scope: query.scope ?? 'dot', section: 'usage', memory: { keyDigest, key: '偏好', revision: 2, status: 'effective', deletedAt: null }, page: paged([{ ...summary, memoryRevision: 1 }]) };
    if (query.action === 'memory') return { ...base, action: 'memory', scope: query.scope ?? 'dot', section: 'versions', memory: { keyDigest, key: '偏好', revision: 2, status: 'effective', deletedAt: null },
        page: paged([2, 1].map(revision => ({ revision, action: 'remember', kind: 'preference', value: revision === 2 ? '新版' : '旧版', source: 'user', sourceRef: 'message:1',
            verified: true, expiresAt: null, recordedAt: at, confirmedAt: at, historical: revision === 1 }))) };
    if (query.action === 'turn' && query.section === 'overview') return { ...base, action: 'turn', section: 'overview', turnId, turn: { ...summary, reply: { text: '原回复', truncated: false },
        frozenAt: at, identity: { name: '当时的名称', instruction: '当时的职责' }, decisionKind: 'reply', decision: { text: '{"kind":"reply"}', truncated: false }, inputDigest: snapshotId, calls: [], relatedWork: [], originRunId: null,
        historyTotal: 0, memoryReadable: true, selectionAvailable: true, selectionPolicyVersion: 1, deliveries: [{ status: 'stored_verified', messageSeq: 2, attempts: 1, error: null }] } };
    if (query.action === 'turn' && query.section === 'memory') return { ...base, action: 'turn', section: 'memory', turnId, contextAvailable: true, backgroundOmitted: 2, catalogOmitted: 3,
        page: paged([{ keyDigest, key: '偏好', revision: 1, value: '旧版', kind: 'preference', source: 'user', sourceRef: null, verified: true, expiresAt: null, expired: false, locations: ['background', 'catalog'] }]) };
    if (query.action === 'turn' && query.section === 'selection') return { ...base, action: 'turn', section: 'selection', turnId, available: true,
        policy: { version: 1, asOf: at, enabled: true, maxEntries: 10, maxBytes: 8192 }, page: paged([{ keyDigest, key: '偏好', revision: 1, reason: 'entry_limit' }]) };
    throw new Error('unexpected test request');
}
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
beforeEach(() => {
    mocks.rpc.mockReset(); mocks.ready.mockReset(); mocks.ready.mockResolvedValue(undefined); mocks.authenticated = true;
    mocks.credentials = { token: 'account', secret: 'secret' }; mocks.server = 'https://relay.example';
    mocks.rpc.mockImplementation(async (_session: string, _method: string, query: unknown) => ({ ok: true, data: response(query) }));
});
async function render(mode: 'activity' | 'memory' | 'basis' = 'activity') {
    const props = { sessionId: 'workspace', workspaceId, dotId, dotSessionId: 'dotSession', active: true, mode, presence: 'online',
        onExecution: vi.fn(), onEditMemory: vi.fn(), onForgetMemory: vi.fn(), onAddMemory: vi.fn() };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DotObservationPanel, props)); }); renderers.push(renderer);
    const button = (name: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === name);
    const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name).props.onPress()); };
    return { renderer, props, button, click, text: () => JSON.stringify(renderer.toJSON()) };
}
it('opens the frozen context from activity and distinguishes memory locations and selection reasons', async () => {
    const f = await render(); expect(f.text()).toContain('宿主：'); expect(f.text()).toContain('对话 · 已处理');
    await f.click('查看本轮依据'); expect(f.text()).toContain('当时的职责');
    await f.click('带入的记忆'); expect(f.text()).toContain('旧版'); expect(f.text()).toContain('有效背景、管理目录');
    await f.click('记忆选择原因'); expect(f.text()).toContain('达到条数上限');
    expect(mocks.rpc.mock.calls.every(call => call[1] === 'testloop-dot-observation')).toBe(true);
});
it('shows versions, links actual historical usage and keeps editing in the existing conversation flow', async () => {
    const f = await render('memory'); await f.click('查看记忆：偏好'); expect(f.text()).toContain('旧版'); expect(f.text()).toContain('新版');
    await f.click('编辑这条记忆'); expect(f.props.onEditMemory).toHaveBeenCalledWith('偏好', expect.objectContaining({ revision: 2, value: '新版' }), 'dot');
    await f.click('请求忘记这条记忆'); expect(f.props.onForgetMemory).toHaveBeenCalledWith('偏好', 'dot');
    await f.click('查看历史带入记录'); expect(f.text()).toContain('带入第 1 版');
    await f.click('检查第 1 轮'); expect(f.text()).toContain('原交办');
});
it('preserves the snapshot token on pagination and reports a stale page', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => query.action === 'activity'
        ? query.offset ? { ok: false, error: 'observation_snapshot_changed' } : { ok: true, data: { ...base, action: 'activity', page: paged([event], { total: 2, nextOffset: 1 }) } }
        : normal(session, method, query));
    const f = await render(); await f.click('下一页');
    expect(mocks.rpc.mock.calls.some(call => call[2].snapshotId === snapshotId && call[2].offset === 1)).toBe(true);
    expect(f.text()).toContain('数据已变化'); expect(f.text()).not.toContain('当前没有此类记录');
});
it('displays unsupported hosts as unavailable rather than an empty directory', async () => {
    mocks.rpc.mockRejectedValue(new Error('RPC missing')); const f = await render();
    expect(f.text()).toContain('宿主是否支持观察台'); expect(f.text()).not.toContain('当前没有此类记录');
});
it('hides data and drops an in-flight result on account change', async () => {
    const f = await render(); let resolve!: (value: unknown) => void;
    mocks.rpc.mockImplementation(() => new Promise(done => { resolve = done; }));
    await f.click('刷新观察台'); mocks.credentials = { token: 'new-account', secret: 'new-secret' }; mocks.authenticated = false;
    await act(async () => { f.renderer.update(React.createElement(DotObservationPanel, f.props)); });
    await act(async () => { resolve({ ok: true, data: response({ action: 'activity' }) }); });
    expect(f.text()).not.toContain('对话 · 已处理'); expect(f.text()).not.toContain('观察职责');
});
it('clears observations while backgrounded and reloads on return without polling', async () => {
    const f = await render(); const calls = mocks.rpc.mock.calls.length;
    await act(async () => { mocks.background!('background'); }); expect(f.text()).not.toContain('对话 · 已处理');
    expect(mocks.rpc).toHaveBeenCalledTimes(calls);
    await act(async () => { mocks.background!('active'); }); expect(f.text()).toContain('对话 · 已处理');
    expect(mocks.rpc).toHaveBeenCalledTimes(calls + 2);
});

it('routes same-key user memories and every edit/forget action to the selected scope', async () => {
    const f = await render('memory');
    await f.click('用户级记忆');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'memories', scope: 'user' });
    await f.click('查看记忆：偏好');
    expect(mocks.rpc.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'memory', scope: 'user', keyDigest });
    await f.click('编辑这条记忆');
    expect(f.props.onEditMemory).toHaveBeenLastCalledWith('偏好', expect.objectContaining({ revision: 2 }), 'user');
    await f.click('请求忘记这条记忆');
    expect(f.props.onForgetMemory).toHaveBeenLastCalledWith('偏好', 'user');
    await f.click('Dot级记忆');
    await f.click('添加记忆');
    expect(f.props.onAddMemory).toHaveBeenCalledWith('dot');
});
it('does not display Dot memories as user memories when authentication is unavailable', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => query.scope === 'user'
        ? { ok: false, error: 'observation_user_memory_unavailable' } : normal(session, method, query));
    const f = await render('memory');
    await f.click('用户级记忆');
    expect(f.text()).toContain('用户级记忆暂不可用');
    expect(f.button('查看记忆：偏好')).toBeUndefined();
});
