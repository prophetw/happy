import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), ready: vi.fn(), background: null as null | ((state: string) => void),
    credentials: { token: 'account', secret: 'secret' }, server: 'https://relay.example', authenticated: true, pending: new Map<string, string>(), failWrite: false }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '44444444-4444-4444-8444-444444444444' }));
vi.mock('@/utils/parseToken', () => ({ parseToken: (token: string) => token }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return mocks.pending.get(key); }
    set(key: string, value: string) { if (mocks.failWrite) throw new Error('device storage full'); mocks.pending.set(key, value); }
} }));
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
    mocks.pending.clear(); mocks.failWrite = false;
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

it('explains an old dirty-directory wait without asking the user to clean their work', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => query.action === 'activity'
        ? { ok: true, data: { ...base, action: 'activity', page: paged([{ ...event, kind: 'run', status: 'waiting-resource',
            reason: 'integration_worktree_dirty', workId: turnId, turnId: null }]) } }
        : normal(session, method, query));
    const f = await render();
    expect(f.text()).toContain('工作 · 等待执行资源');
    expect(f.text()).toContain('保留改动并按原请求继续');
    expect(f.text()).toContain('无需清理目录');
    expect(f.text()).not.toContain('integration_worktree_dirty');
});

it('shows a temporarily unreadable running task with retry guidance instead of calling it blocked', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => query.action === 'activity'
        ? { ok: true, data: { ...base, action: 'activity', page: paged([{ ...event, kind: 'run', status: 'running',
            reason: 'WORKER_UNAVAILABLE', workId: turnId, turnId: null }]) } }
        : normal(session, method, query));
    const f = await render();
    expect(f.text()).toContain('工作 · 执行中'); expect(f.text()).toContain('自动重试状态查询');
    expect(f.text()).not.toContain('遇到阻塞'); expect(f.text()).not.toContain('WORKER_UNAVAILABLE');
});
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

const moveReceipt = (query: any, extra = {}) => ({ schemaVersion: 1, dotId, keyDigest, requestID: query.requestID,
    sourceScope: query.sourceScope ?? 'dot', targetScope: query.sourceScope === 'user' ? 'dot' : 'user', sourceRevision: 2,
    targetRevision: query.action === 'prepare' ? 0 : 1, targetExpectedRevision: 0,
    status: query.action === 'prepare' ? 'ready' : 'completed_locally', indexing: 'pending', cleanup: 'pending', ...extra });

it('moves from the native list in one press, checks both layers and distinguishes local completion from indexing', async () => {
    let moved = false;
    mocks.rpc.mockImplementation(async (_session, method, query) => {
        if (method === 'testloop-dot-memory-move') {
            if (query.action === 'move') moved = true;
            return { ok: true, data: moveReceipt(query) };
        }
        const data: any = response(query);
        if (moved && query.action === 'memories' && query.scope === 'dot') data.page = paged([]);
        return { ok: true, data };
    });
    const f = await render('memory');
    expect(mocks.rpc.mock.calls.some(call => call[1] === 'testloop-dot-memory-move')).toBe(false);
    await f.click('移至用户级');
    const moves = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2]);
    expect(moves.map(item => item.action)).toEqual(['prepare', 'move']);
    expect(moves[1]).toEqual({ schemaVersion: 1, action: 'move', dotId, keyDigest, sourceScope: 'dot', sourceRevision: 2,
        targetRevision: 0, requestID: moves[0].requestID });
    for (const scope of ['dot', 'user']) for (const action of ['overview', 'memories']) {
        expect(mocks.rpc.mock.calls.some(call => call[2].action === action && call[2].scope === scope)).toBe(true);
    }
    expect(f.text()).toContain('已在本地移至用户级'); expect(f.text()).toContain('索引中'); expect(f.text()).toContain('远端清理中');
    expect(f.button('查看记忆：偏好')).toBeUndefined();
    expect([...mocks.pending.values()].join()).not.toContain('新版');
    expect([...mocks.pending.keys()].join()).not.toContain('secret');
});

it('moves a user memory from native details only to the current Dot', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: true, data: moveReceipt(query) } : normal(session, method, query));
    const f = await render('memory'); await f.click('用户级记忆'); await f.click('查看记忆：偏好');
    await f.click('移至当前Dot');
    const moves = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move');
    expect(moves).toHaveLength(2); expect(moves[1][2]).toMatchObject({ action: 'move', dotId, sourceScope: 'user', sourceRevision: 2 });
    expect(f.text()).toContain('已在本地移至当前 Dot');
});

it.each(['memory_move_target_conflict', 'memory_move_source_changed', 'memory_move_not_authorized'])('shows a rejected prepare (%s) and never writes or confirms success', async error => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: false, error } : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare']);
    expect(f.text()).not.toContain('已在本地移至'); expect(f.button('恢复上次移动')).toBeUndefined();
    expect(f.text()).toContain(error === 'memory_move_target_conflict' ? '目标已有同名有效记忆，未覆盖' : error === 'memory_move_source_changed' ? '记忆已变化' : '移动授权不可用');
});

it.each([{ token: 'another-account', secret: 'another-secret' }, { token: 'account', secret: 'replacement-key' }])('does not send a late prepared move after credentials change (%j)', async credentials => {
    let resolve!: (value: unknown) => void;
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? new Promise(done => { resolve = () => done({ ok: true, data: moveReceipt(query) }); }) : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    mocks.credentials = credentials;
    await act(async () => { f.renderer.update(React.createElement(DotObservationPanel, f.props)); });
    await act(async () => { resolve(undefined); });
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare']);
    expect(f.text()).not.toContain('已在本地移至');
    if (credentials.token !== 'account') expect(f.button('恢复上次移动')).toBeUndefined();
});

it('persists an unconfirmed request across unmount, then resumes the same ID and original target CAS', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    let interrupted = true;
    mocks.rpc.mockImplementation(async (session, method, query) => {
        if (method !== 'testloop-dot-memory-move') return normal(session, method, query);
        if (query.action === 'move' && interrupted) { interrupted = false; throw new Error('timeout after target fsync'); }
        return { ok: true, data: moveReceipt(query, query.action === 'status' ? { status: 'target_saved', targetRevision: 1 }
            : query.action === 'move' ? { indexing: 'indexed', cleanup: 'complete' } : {}) };
    });
    const f = await render('memory'); await f.click('移至用户级');
    expect(f.text()).toContain('结果尚未确认');
    const original = mocks.rpc.mock.calls.find(call => call[2].action === 'move')![2];
    await act(async () => f.renderer.unmount()); renderers.splice(renderers.indexOf(f.renderer), 1);
    const reopened = await render('memory'); expect(reopened.button('恢复上次移动')).toBeTruthy();
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move')).toHaveLength(2);
    await reopened.click('恢复上次移动');
    const calls = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2]);
    expect(calls.map(call => call.action)).toEqual(['prepare', 'move', 'status', 'move']);
    expect(calls[3]).toEqual(original); expect(calls[3].targetRevision).toBe(0);
    expect(reopened.text()).toContain('已在本地移至用户级'); expect(reopened.text()).toContain('索引已完成');
    expect(reopened.button('恢复上次移动')).toBeUndefined();
});

it('keeps the confirmed local receipt when refreshing the two native lists fails', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    let moved = false;
    mocks.rpc.mockImplementation(async (session, method, query) => {
        if (method === 'testloop-dot-memory-move') {
            if (query.action === 'move') moved = true;
            return { ok: true, data: moveReceipt(query) };
        }
        if (moved) throw new Error('refresh offline');
        return normal(session, method, query);
    });
    const f = await render('memory'); await f.click('移至用户级');
    expect(f.text()).toContain('已在本地移至用户级'); expect(f.text()).toContain('两层列表刷新失败');
    expect(f.text()).not.toContain('移动暂未完成');
});

it('requires an explicit recovery press for a matching journal discovered on another device', async () => {
    const normal = mocks.rpc.getMockImplementation()!, previousID = '55555555-5555-4555-8555-555555555555';
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: true, data: moveReceipt(query, { requestID: previousID, status: query.action === 'prepare' ? 'target_saved' : query.action === 'status' ? 'target_saved' : 'completed_locally' }) }
        : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare']);
    expect(f.text()).toContain('发现这条记忆上次未完成的移动');
    const pending = JSON.parse([...mocks.pending.values()][0]); expect(pending).toHaveLength(1); expect(pending[0].requestID).toBe(previousID);
    await f.click('恢复上次移动');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').at(-1)![2]).toMatchObject({ action: 'move', requestID: previousID, targetRevision: 0 });
});

it('stops an interrupted move explicitly while retaining both ledgers and never claims a rollback', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: true, data: moveReceipt(query, { status: query.action === 'prepare' ? 'ready' : query.action === 'cancel' ? 'abandoned' : 'needs_attention' }) }
        : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级'); expect(f.text()).toContain('尚不能确认完成');
    await f.click('停止本次移动并保留记录');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').at(-1)![2]).toEqual({
        schemaVersion: 1, action: 'cancel', dotId, requestID: '44444444-4444-4444-8444-444444444444' });
    expect(f.text()).toContain('已有副本保留'); expect(f.text()).toContain('不会回滚');
    expect(f.button('恢复上次移动')).toBeUndefined(); expect(f.button('查看记忆：偏好')).toBeTruthy();
});

it('discovers and stops an older unfinished source revision without moving the newly edited source', async () => {
    const normal = mocks.rpc.getMockImplementation()!, previousID = '55555555-5555-4555-8555-555555555555';
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: true, data: moveReceipt(query, { requestID: previousID, sourceRevision: 1, status: query.action === 'cancel' ? 'abandoned' : 'needs_attention' }) }
        : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare']);
    expect(JSON.parse([...mocks.pending.values()][0])[0]).toMatchObject({ requestID: previousID, sourceRevision: 1 });
    await f.click('恢复上次移动'); expect(f.text()).toContain('尚不能确认完成');
    await f.click('停止本次移动并保留记录');
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare', 'status', 'cancel']);
    expect(f.text()).toContain('已有副本保留'); expect(f.button('查看记忆：偏好')).toBeTruthy();
});

it('treats an old superseded destination version as a terminal receipt rather than endless indexing', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? { ok: true, data: moveReceipt(query, query.action === 'move' ? { indexing: 'superseded', cleanup: 'complete' } : {}) }
        : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    expect(f.text()).toContain('该目标版本后来已变更或失效'); expect(f.text()).not.toContain('索引中');
    expect(f.button('恢复上次移动')).toBeUndefined();
});

it('does not resume a prepared write automatically after backgrounding and returning', async () => {
    let resolve!: () => void;
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => method === 'testloop-dot-memory-move'
        ? new Promise(done => { resolve = () => done({ ok: true, data: moveReceipt(query) }); }) : normal(session, method, query));
    const f = await render('memory'); await f.click('移至用户级');
    await act(async () => { mocks.background!('background'); });
    await act(async () => { mocks.background!('active'); });
    await act(async () => { resolve(); });
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare']);
    expect(f.button('恢复上次移动')).toBeTruthy();
});

it('hides native move controls when the current memory permission is revoked', async () => {
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => query.action === 'overview'
        ? { ok: true, data: { ...overview(), memory: { ...overview().memory, access: ['read'] } } } : normal(session, method, query));
    const f = await render('memory'); expect(f.button('移至用户级')).toBeUndefined();
    await f.click('查看记忆：偏好'); expect(f.button('移至用户级')).toBeUndefined();
});

it('shows corrupt recovery storage and refuses to send a new native move', async () => {
    mocks.pending.set(JSON.stringify(['https://relay.example', 'account', workspaceId, 'workspace', dotId, 'dotSession']), 'invalid-json');
    const f = await render('memory'); expect(f.text()).toContain('本机移动恢复记录无法读取');
    await f.click('移至用户级');
    expect(mocks.rpc.mock.calls.some(call => call[1] === 'testloop-dot-memory-move')).toBe(false);
});

it('does not send when persisting the recovery request fails and keeps confirmed receipts if cleanup persistence fails', async () => {
    const f = await render('memory'); mocks.failWrite = true; await f.click('移至用户级');
    expect(f.text()).toContain('本机无法保存移动恢复记录');
    expect(mocks.rpc.mock.calls.some(call => call[1] === 'testloop-dot-memory-move')).toBe(false);
    mocks.failWrite = false;
    const normal = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, query) => {
        if (method !== 'testloop-dot-memory-move') return normal(session, method, query);
        if (query.action === 'move') mocks.failWrite = true;
        return { ok: true, data: moveReceipt(query, query.action === 'move' ? { indexing: 'indexed', cleanup: 'complete' } : {}) };
    });
    await f.click('移至用户级');
    expect(f.text()).toContain('已在本地移至用户级'); expect(f.text()).toContain('本机恢复记录未能更新');
    expect(f.text()).not.toContain('移动暂未完成');
});

it.each(['expired', 'deleted'])('finds an unfinished journal from a native %s entry using only prepare, then explicitly stops it', async status => {
    const previousID = '55555555-5555-4555-8555-555555555555';
    mocks.rpc.mockImplementation(async (_session, method, query) => {
        if (method === 'testloop-dot-memory-move') return { ok: true, data: moveReceipt(query, {
            requestID: previousID, sourceRevision: 1, status: query.action === 'cancel' ? 'abandoned' : 'needs_attention' }) };
        const data: any = response(query);
        if (query.action === 'memories') data.page.items = [{ keyDigest, key: '偏好', revision: 3, status, preview: { text: '已删除敏感正文', truncated: false } }];
        if (query.action === 'memory') data.memory = { ...data.memory, revision: 3, status, deletedAt: status === 'deleted' ? at : null };
        return { ok: true, data };
    });
    const f = await render('memory'); expect(f.button('移至用户级')).toBeUndefined();
    if (status === 'deleted') {
        expect(f.text()).not.toContain('已删除敏感正文');
        await f.click('查看记忆：偏好');
        expect(f.text()).not.toContain('新版'); expect(f.text()).not.toContain('旧版');
    }
    await f.click('核对未完成移动');
    const calls = () => mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2]);
    expect(calls().map(call => call.action)).toEqual(['prepare']); expect(calls()[0].sourceRevision).toBe(3);
    expect(JSON.parse([...mocks.pending.values()][0])[0]).toMatchObject({ requestID: previousID, sourceRevision: 1, targetRevision: 0 });
    await f.click('停止本次移动并保留记录');
    expect(calls().map(call => call.action)).toEqual(['prepare', 'cancel']); expect(f.text()).toContain('已有副本保留');
});

it('keeps non-effective entry inspection read-only when there is no journal, including a newly ready source', async () => {
    let ready = false;
    mocks.rpc.mockImplementation(async (_session, method, query) => {
        if (method === 'testloop-dot-memory-move') return ready
            ? { ok: true, data: moveReceipt(query, { sourceRevision: 3, duplicate: false }) }
            : { ok: false, error: 'memory_move_source_unavailable' };
        const data: any = response(query);
        if (query.action === 'memories') data.page.items = [{ keyDigest, key: '偏好', revision: 3, status: 'expired' }];
        return { ok: true, data };
    });
    const f = await render('memory'); await f.click('核对未完成移动');
    expect(f.text()).toContain('未找到可恢复的移动记录'); expect(f.text()).toContain('本次未发起移动');
    expect(mocks.pending.size).toBe(0);
    ready = true; await f.click('核对未完成移动');
    expect(f.text()).toContain('本次仅核对，未发起移动'); expect(mocks.pending.size).toBe(0);
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-move').map(call => call[2].action)).toEqual(['prepare', 'prepare']);
});
