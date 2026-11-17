import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), visibility: vi.fn(), confirm: vi.fn(), submit: vi.fn(), ready: vi.fn(), rpc: vi.fn(), data: null as any,
    credentials: { token: 'account', secret: 'secret' }, server: 'https://relay.example', authenticated: true }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator', 'ScrollView', 'Modal', 'TextInput'].map(name => [name, host(name)]));
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc' } } }),
    StyleSheet: { create: (styles: any) => typeof styles === 'function'
        ? styles({ colors: { text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc' } }) : styles } }));
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/hooks/useSessionVisibility', () => ({ useSessionVisibility: mocks.visibility }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) }, useRealtimeStatus: () => 'connected' }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: mocks.ready, getCredentials: () => mocks.credentials } }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: mocks.credentials, isAuthenticated: mocks.authenticated }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('expo-crypto', async () => {
    const { createHash } = await import('node:crypto');
    return { randomUUID: () => '33333333-3333-4333-8333-333333333333', CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
        digest: async (_algorithm: string, data: Uint8Array) => {
            const hash = createHash('sha256').update(data).digest();
            return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
        } };
});
vi.mock('@/text', () => ({ t: (key: string, params?: { key: string; revision: number }) => {
    if (key === 'common.recreateMemoryTitle') return '重新添加同名记忆？';
    if (key === 'common.recreateMemoryMessage') return `「${params!.key}」此前已忘记，当前墓碑为第 ${params!.revision} 版。确认重新添加为第 ${params!.revision + 1} 版吗？旧正文和历史版本不会恢复。`;
    if (key === 'common.create') return '创建';
    return key;
} }));
vi.mock('./DotsConnectionsPanel', () => ({ DotsConnectionsPanel: () => null }));
vi.mock('./DotRecoveryNotice', () => ({ DotRecoveryNotice: () => null }));
vi.mock('./DotObservationPanel', async () => {
    const module = await import('react'); return { DotObservationPanel: (props: any) => module.createElement('ObservationPanel', props) };
});
vi.mock('./useDotsWorkspace', () => ({ useDotsWorkspace: () => ({ ready: true, pending: null, error: null, notice: null, retry: vi.fn(), submit: mocks.submit,
    projection: { snapshot: { dots: [{ id: '22222222-2222-4222-8222-222222222222', sessionId: 'dot-session' }] }, details: { '22222222-2222-4222-8222-222222222222': { asOf: '2026-11-05T00:00:00Z',
        data: { dotId: '22222222-2222-4222-8222-222222222222', taskTotal: 0, tasks: [], memory: { access: ['read', 'write', 'forget'], total: 0, items: [], omittedCount: 0 } } } } },
    ...(mocks.data ?? {}),
}) }));
import { DotSessionContent } from './DotSessionContent';
beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
    mocks.data = null;
    mocks.credentials = { token: 'account', secret: 'secret' }; mocks.server = 'https://relay.example'; mocks.authenticated = true;
    mocks.ready.mockReset(); mocks.ready.mockResolvedValue(undefined);
    mocks.rpc.mockReset(); mocks.rpc.mockImplementation(async (_session, _method, request) => {
        if (_method === 'testloop-dot-observation') return { ok: false, error: 'observation_memory_not_found' };
        return { ok: true, data: {
        schemaVersion: 1, workspaceId: request.workspaceId, dotId: request.dotId, dotSessionId: request.dotSessionId,
        scope: request.scope, requestID: request.requestID, action: request.operation.action, keyDigest: 'sha256:' + 'b'.repeat(64),
        revision: request.operation.revision + 1, currentRevision: request.operation.revision + 1,
        currentStatus: request.operation.action === 'forget' ? 'deleted' : 'active', duplicate: false, indexing: 'pending',
    } }; });
    mocks.confirm.mockReset();
    mocks.submit.mockReset();
    mocks.navigate.mockReset();
});
it('confirms clear and stays in the current page until the host confirms a replacement session', async () => {
    let mounts = 0;
    function Composer() {
        React.useEffect(() => { mounts++; }, []);
        const [draft] = React.useState('不能丢失的草稿');
        return React.createElement('Composer', { draft });
    }
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: () => React.createElement(Composer) };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const clear = () => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '清空当前对话')!;

    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => clear().props.onPress());
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(renderer.root.findByType('Composer').props.draft).toBe('不能丢失的草稿');

    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => clear().props.onPress());
    expect(mocks.confirm).toHaveBeenLastCalledWith('清空当前对话？', expect.stringContaining('独立后台任务继续运行'), { confirmText: '清空对话' });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 1,
        requestId: '33333333-3333-4333-8333-333333333333', action: 'clear', dotId: '22222222-2222-4222-8222-222222222222' });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(renderer.root.findByType('Composer').props.draft).toBe('不能丢失的草稿');
    expect(mounts).toBe(1);

    mocks.data = { notice: '已为之后的模型上下文隔离此前历史；旧聊天、长期记忆、授权、任务记录和进行中目标均保留。' };
    await act(async () => renderer.update(React.createElement(DotSessionContent, props)));
    expect(JSON.stringify(renderer.root.findAllByType('Text').map((node: any) => node.props.children))).toContain('旧聊天、长期记忆');
    expect(renderer.root.findByType('Composer').props.draft).toBe('不能丢失的草稿');
    mocks.data = { projection: { snapshot: { ok: true, dots: [{ id: props.metadata.dotId, sessionId: 'new-dot-session' }] } } };
    await act(async () => renderer.update(React.createElement(DotSessionContent, props)));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('new-dot-session');
    await act(async () => renderer.unmount());
});

it('disables clearing while a host request is pending', async () => {
    mocks.data = { pending: { request: { action: 'inspect' }, timedOut: false } };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
        renderer = create(React.createElement(DotSessionContent, {
            session: { id: 'dot-session', presence: 'online' } as any, active: true,
            metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
            children: () => React.createElement('Composer'),
        }));
    });
    const clear = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '清空当前对话')!;
    expect(clear.props.disabled).toBe(true);
    await act(async () => clear.props.onPress());
    expect(mocks.confirm).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('waits for the clear receipt before following a replacement visible in the directory', async () => {
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: () => React.createElement('Composer') };
    const projection = { snapshot: { ok: true, dots: [{ id: props.metadata.dotId, sessionId: 'replacement' }] } };
    mocks.data = { projection, pending: { request: { action: 'clear' }, timedOut: true } };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    mocks.data = { projection, pending: null };
    await act(async () => renderer.update(React.createElement(DotSessionContent, props)));
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('replacement');
    await act(async () => renderer.unmount());
});

it('does not confirm a clear against a different account after the confirmation dialog was opened', async () => {
    let confirm!: (accepted: boolean) => void;
    mocks.confirm.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: () => React.createElement('Composer') };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    await act(async () => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '清空当前对话')!.props.onPress());
    mocks.credentials = { token: 'another-account', secret: 'another-secret' };
    await act(async () => renderer.update(React.createElement(DotSessionContent, props)));
    await act(async () => confirm(true));
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('saves an edited memory without sending a chat message or changing the composer draft', async () => {
    let mounts = 0; const requests: unknown[] = [];
    function Composer({ request }: { request: unknown }) {
        React.useEffect(() => { mounts++; }, []);
        const [draft, setDraft] = React.useState('原有草稿');
        React.useEffect(() => { if (request) requests.push(request); }, [request]);
        return React.createElement('Composer', { draft, setDraft });
    }
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: (request: unknown) => React.createElement(Composer, { request }) };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const tabs = () => renderer.root.findAllByType('Pressable').filter((node: any) => node.props.accessibilityRole === 'tab');
    const switchTo = async (title: string) => act(async () => tabs().find((node: any) => node.findByType('Text').props.children === title).props.onPress());
    await switchTo('记忆');
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    const panel = renderer.root.findByType('ObservationPanel'); expect(panel.props.mode).toBe('memory'); expect(panel.props.active).toBe(true);
    await act(async () => panel.props.onEditMemory('偏好', { revision: 2, value: '新偏好', kind: 'preference', expiresAt: null }));
    const refreshKey = panel.props.refreshKey;
    const confirm = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '保存记忆');
    await act(async () => confirm.props.onPress());
    expect(requests).toHaveLength(0);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('workspace-session', 'testloop-dot-memory-edit', expect.objectContaining({
        dotSessionId: 'dot-session', scope: 'dot', operation: { action: 'remember', key: '偏好', revision: 2, value: '新偏好', kind: 'preference', expiresAt: null },
    }));
    expect(JSON.stringify(renderer.toJSON())).toContain('记忆已保存');
    expect(renderer.root.findAllByType('TextInput')).toHaveLength(0);
    expect(renderer.root.findByType('ObservationPanel').props.refreshKey).toBeGreaterThan(refreshKey);
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    await act(async () => renderer.unmount());
});

it('saves and explicitly confirms forgetting only the selected user-level memory', async () => {
    let request: { text: string } | null = null;
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online', metadata: { codexThreadId: 'native-thread' } } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: (value: any) => { request = value; return React.createElement('Composer'); } };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const panel = renderer.root.findByType('ObservationPanel');
    await act(async () => panel.props.onEditMemory('偏好', { revision: 1, value: '共享偏好', kind: 'preference', expiresAt: null }, 'user'));
    const send = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '保存记忆')!;
    await act(async () => send.props.onPress());
    expect(request).toBeNull();
    expect(mocks.rpc.mock.calls[0][2]).toMatchObject({ scope: 'user', operation: { action: 'remember', key: '偏好', revision: 1 } });
    await act(async () => renderer.root.findByType('ObservationPanel').props.onForgetMemory('偏好', 2, 'user'));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const forget = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '确认忘记')!;
    await act(async () => forget.props.onPress());
    expect(request).toBeNull();
    expect(mocks.rpc.mock.calls[1][2]).toMatchObject({ scope: 'user', operation: { action: 'forget', key: '偏好', revision: 2 } });
    await act(async () => renderer.unmount());
});

it('lets a new memory pick its kind instead of always saving a preference', async () => {
    let request: { text: string } | null = null;
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online', metadata: { codexThreadId: 'native-thread' } } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: (value: any) => { request = value; return React.createElement('Composer'); } };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const panel = renderer.root.findByType('ObservationPanel');
    await act(async () => panel.props.onAddMemory('user'));
    expect(renderer.root.findAllByType('Pressable').some((node: any) => node.props.accessibilityLabel === '记忆类型：事实')).toBe(true);
    const pressed = async (label: string) => { const node = renderer.root.findAllByType('Pressable').find((item: any) => item.props.accessibilityLabel === label)!;
        await act(async () => node.props.onPress()); };
    await pressed('记忆类型：事实');
    const inputs = renderer.root.findAllByType('TextInput') as any[];
    const input = (label: string) => inputs.find(node => node.props.accessibilityLabel === label)!;
    await act(async () => input('记忆名称').props.onChangeText('交付节奏'));
    await act(async () => input('记忆内容').props.onChangeText('每周三提交'));
    await act(async () => input('记忆有效期').props.onChangeText('2099-01-01T00:00:00Z'));
    await pressed('保存记忆');
    expect(request).toBeNull();
    await vi.waitFor(() => expect(mocks.rpc.mock.calls.find(call => call[1] === 'testloop-dot-memory-edit')?.[2]).toMatchObject({ scope: 'user', operation: { action: 'remember', key: '交付节奏', kind: 'fact', value: '每周三提交', revision: 0, expiresAt: '2099-01-01T00:00:00.000Z' } }));
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-observation')).toHaveLength(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('explains why a memory cannot be added before the workspace projection is ready', async () => {
    mocks.data = { ready: false };
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: () => React.createElement('Composer') };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const panel = renderer.root.findByType('ObservationPanel');
    await act(async () => panel.props.onAddMemory('dot'));
    expect(JSON.stringify(renderer.toJSON())).toContain('工作台数据还没就绪');
    await act(async () => renderer.unmount());
});

async function memoryForm(options: { add?: boolean; scope?: 'dot' | 'user' } = {}) {
    const requests: unknown[] = [];
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: '11111111-1111-4111-8111-111111111111', workspaceSessionId: 'workspace-session', dotId: '22222222-2222-4222-8222-222222222222' },
        children: (request: unknown) => { if (request) requests.push(request); return React.createElement('Composer', { draft: '原聊天草稿' }); } };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const button = (label: string) => renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === label)!;
    const input = (label: string) => renderer.root.findAllByType('TextInput').find((node: any) => node.props.accessibilityLabel === label)!;
    if (options.add) {
        await act(async () => renderer.root.findByType('ObservationPanel').props.onAddMemory(options.scope ?? 'dot'));
        await act(async () => input('记忆名称').props.onChangeText('偏好'));
    } else {
        await act(async () => renderer.root.findByType('ObservationPanel').props.onEditMemory('偏好', { revision: 2, value: '旧偏好', kind: 'preference', expiresAt: null }));
    }
    await act(async () => input('记忆内容').props.onChangeText('用户的新草稿'));
    return { renderer, props, requests, button, input, text: () => JSON.stringify(renderer.toJSON()) };
}

const deletedReply = (request: any, revision = 3) => ({ ok: true, data: {
    schemaVersion: 1, dotId: request.dotId, asOf: '2026-11-17T00:00:00Z', snapshotId: 'sha256:' + 'a'.repeat(64),
    action: 'memory', section: 'versions', scope: request.scope,
    memory: { keyDigest: request.keyDigest, key: null, status: 'deleted', revision, deletedAt: '2026-11-17T00:00:00Z' },
    page: { items: [], total: 0, offset: 0, nextOffset: null } } });

it.each(['dot', 'user'] as const)('requires explicit confirmation and the current tombstone revision when recreating a forgotten memory: %s', async scope => {
    const success = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (session, method, request) => {
        if (method === 'testloop-dot-observation') return deletedReply(request);
        if (method === 'testloop-dot-memory-edit' && request.operation.revision === 0) return { ok: false, error: 'memory_edit_revision_conflict' };
        return success(session, method, request);
    });
    const f = await memoryForm({ add: true, scope });
    const writes = () => mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-edit');
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => f.button('保存记忆').props.onPress());
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][2].operation.revision).toBe(0);
    expect(f.input('记忆内容').props.value).toBe('用户的新草稿');
    mocks.confirm.mockResolvedValueOnce(true);
    await act(async () => f.button('保存记忆').props.onPress());
    await vi.waitFor(() => expect(writes()).toHaveLength(3));
    expect(mocks.confirm).toHaveBeenLastCalledWith('重新添加同名记忆？', expect.stringContaining('第 3 版'), { confirmText: '创建' });
    expect(writes().map(call => call[2].operation.revision)).toEqual([0, 0, 3]);
    expect(writes()[2][2]).toMatchObject({ scope, operation: { action: 'remember', key: '偏好', revision: 3, value: '用户的新草稿' } });
    await act(async () => f.renderer.unmount());
});

it('keeps a confirmed recreation on the original request after losing its acknowledgement', async () => {
    const success = mocks.rpc.getMockImplementation()!;
    let lose = true;
    mocks.confirm.mockResolvedValue(true);
    mocks.rpc.mockImplementation(async (session, method, request) => {
        if (method === 'testloop-dot-observation') return deletedReply(request);
        if (method === 'testloop-dot-memory-edit' && request.operation.revision === 0) return { ok: false, error: 'memory_edit_revision_conflict' };
        if (method === 'testloop-dot-memory-edit' && lose) { lose = false; throw new Error('reply lost'); }
        return success(session, method, request);
    });
    const f = await memoryForm({ add: true });
    await act(async () => f.button('保存记忆').props.onPress());
    const sent = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-edit').at(-1)![2];
    expect(sent.operation.revision).toBe(3);
    expect(f.text()).toContain('尚未收到可核对的保存回执');
    await act(async () => f.button('重试上次记忆操作').props.onPress());
    await vi.waitFor(() => expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-edit')).toHaveLength(3));
    const calls = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-edit');
    expect(calls.map(call => call[2].operation.revision)).toEqual([0, 3, 3]);
    expect(calls[2][2]).toEqual(sent);
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-observation')).toHaveLength(1);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    await act(async () => f.renderer.unmount());
});

it('re-reads and reconfirms a changed tombstone after the host rejects its stale CAS revision', async () => {
    const success = mocks.rpc.getMockImplementation()!;
    let revision = 3, firstWrite = true;
    mocks.confirm.mockResolvedValue(true);
    mocks.rpc.mockImplementation(async (session, method, request) => {
        if (method === 'testloop-dot-observation') return deletedReply(request, revision);
        if (method === 'testloop-dot-memory-edit' && request.operation.revision === 0) return { ok: false, error: 'memory_edit_revision_conflict' };
        if (method === 'testloop-dot-memory-edit' && request.operation.revision === 3 && firstWrite) {
            firstWrite = false; revision = 5; return { ok: false, error: 'memory_edit_revision_conflict' };
        }
        return success(session, method, request);
    });
    const f = await memoryForm({ add: true });
    await act(async () => f.button('保存记忆').props.onPress());
    expect(f.text()).toContain('这条记忆已有更新，未覆盖');
    await act(async () => f.button('保存记忆').props.onPress());
    const writes = mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-memory-edit');
    expect(writes.map(call => call[2].operation.revision)).toEqual([0, 3, 0, 5]);
    expect(mocks.rpc.mock.calls.filter(call => call[1] === 'testloop-dot-observation')).toHaveLength(2);
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.confirm).toHaveBeenLastCalledWith('重新添加同名记忆？', expect.stringContaining('第 5 版'), { confirmText: '创建' });
    await act(async () => f.renderer.unmount());
});

it('rejects UTF-8 JSON values over 4096 bytes locally without creating a retry attempt', async () => {
    const f = await memoryForm();
    await act(async () => f.input('记忆内容').props.onChangeText('中'.repeat(1365)));
    await act(async () => f.button('保存记忆').props.onPress());
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(f.text()).toContain('记忆内容或版本无法核对，请检查输入后重试。');
    expect(f.input('记忆内容').props.editable).toBe(true);
    expect(f.button('保存记忆')).toBeDefined();
    await act(async () => f.renderer.unmount());
});

it('keeps an uncertain write frozen and retries the same request without double dispatch', async () => {
    const success = mocks.rpc.getMockImplementation()!;
    let reject!: (error: Error) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise((_, rejectRequest) => { reject = rejectRequest; }));
    const f = await memoryForm(), save = f.button('保存记忆');
    await act(async () => { save.props.onPress(); save.props.onPress(); });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(f.button('保存记忆').props.disabled).toBe(true);
    const sent = mocks.rpc.mock.calls[0][2];
    await act(async () => reject(new Error('reply lost after saving')));
    expect(f.text()).toContain('尚未收到可核对的保存回执');
    expect(f.input('记忆内容').props.value).toBe('用户的新草稿');
    expect(f.input('记忆内容').props.editable).toBe(false);
    mocks.rpc.mockImplementation(success);
    await act(async () => f.button('重试上次记忆操作').props.onPress());
    expect(mocks.rpc.mock.calls[1][2]).toEqual(sent);
    expect(f.requests).toHaveLength(0);
    expect(f.text()).toContain('记忆已保存');
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    await act(async () => f.renderer.unmount());
});

it('can close and reopen an uncertain memory operation without changing its request', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('reply lost'));
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    const sent = mocks.rpc.mock.calls[0][2];
    await act(async () => f.button('关闭').props.onPress());
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    await act(async () => f.button('恢复上次记忆操作').props.onPress());
    expect(f.input('记忆内容').props.value).toBe('用户的新草稿');
    await act(async () => f.button('重试上次记忆操作').props.onPress());
    expect(mocks.rpc.mock.calls[1][2]).toEqual(sent);
    await act(async () => f.renderer.unmount());
});

it('preserves an editable draft when the host refuses an outdated memory revision', async () => {
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'memory_edit_revision_conflict' });
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    expect(f.text()).toContain('这条记忆已有更新，未覆盖');
    expect(f.input('记忆内容').props.value).toBe('用户的新草稿');
    expect(f.input('记忆内容').props.editable).toBe(true);
    expect(f.text()).not.toContain('记忆已保存');
    expect(f.requests).toHaveLength(0);
    await act(async () => f.renderer.unmount());
});

it.each([{ active: false, ready: false }, { active: true, ready: false }])('records a completed write while the same Dot is temporarily unavailable: %j', async visibility => {
    const success = mocks.rpc.getMockImplementation()!;
    let resolve!: (receipt: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolveRequest => { resolve = resolveRequest; }));
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    const sent = mocks.rpc.mock.calls[0];
    mocks.data = { ready: visibility.ready };
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, { ...f.props, active: visibility.active })));
    await act(async () => resolve(await success(...sent)));
    mocks.data = null;
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, f.props)));
    expect(f.text()).toContain('记忆已保存');
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    await act(async () => f.renderer.root.findByType('ObservationPanel').props.onEditMemory('偏好', { revision: 3, value: '用户的新草稿', kind: 'preference', expiresAt: null }));
    await act(async () => f.input('记忆内容').props.onChangeText('再次编辑的内容'));
    await act(async () => f.button('保存记忆').props.onPress());
    expect(mocks.rpc.mock.calls[1][2].operation).toMatchObject({ revision: 3, value: '再次编辑的内容' });
    await act(async () => f.renderer.unmount());
});

it('freezes an unknown write received while inactive until the same request is verified', async () => {
    let reject!: (error: Error) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise((_, rejectRequest) => { reject = rejectRequest; }));
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    const sent = mocks.rpc.mock.calls[0][2];
    mocks.data = { ready: false };
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, { ...f.props, active: false })));
    await act(async () => reject(new Error('reply lost')));
    mocks.data = null;
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, f.props)));
    expect(f.input('记忆内容').props.editable).toBe(false);
    expect(f.text()).toContain('尚未收到可核对的保存回执');
    await act(async () => f.button('重试上次记忆操作').props.onPress());
    expect(mocks.rpc.mock.calls[1][2]).toEqual(sent);
    await act(async () => f.renderer.unmount());
});

it('restores a conflict draft after closing, refreshing and reopening the same scoped memory', async () => {
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'memory_edit_revision_conflict' });
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    await act(async () => f.button('关闭').props.onPress());
    await act(async () => f.renderer.root.findByType('ObservationPanel').props.onEditMemory('偏好', { revision: 1, value: '共享层原内容', kind: 'preference', expiresAt: null }, 'user'));
    expect(f.input('记忆内容').props.value).toBe('共享层原内容');
    await act(async () => f.button('关闭').props.onPress());
    await act(async () => f.renderer.root.findByType('ObservationPanel').props.onEditMemory('偏好', { revision: 3, value: '当前已保存的内容', kind: 'preference', expiresAt: null }, 'dot'));
    expect(f.input('记忆内容').props.value).toBe('用户的新草稿');
    expect(f.text()).toContain('当前已保存的内容');
    await act(async () => f.button('保存记忆').props.onPress());
    expect(mocks.rpc.mock.calls[1][2].operation).toMatchObject({ key: '偏好', revision: 3, value: '用户的新草稿' });
    await act(async () => f.renderer.unmount());
});

it.each(['account', 'session', 'signed-out'] as const)('ignores an in-flight memory receipt after the %s binding changes', async changed => {
    const success = mocks.rpc.getMockImplementation()!;
    let resolve!: (receipt: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolveRequest => { resolve = resolveRequest; }));
    const f = await memoryForm(), oldSave = f.button('保存记忆').props.onPress;
    await act(async () => oldSave());
    const sent = mocks.rpc.mock.calls[0];
    const next = changed === 'session' ? { ...f.props, session: { ...f.props.session, id: 'replacement-session' } } : f.props;
    if (changed === 'account') mocks.credentials = { token: 'other-account', secret: 'other-secret' };
    if (changed === 'signed-out') mocks.authenticated = false;
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, next)));
    await act(async () => { resolve(await success(...sent)); oldSave(); });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(f.text()).not.toContain('记忆已保存');
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    await act(async () => f.renderer.unmount());
});

it('does not mistake a later authorization refusal for proof that the previous unknown write never happened', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('reply lost'));
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'memory_edit_not_authorized' });
    const f = await memoryForm();
    await act(async () => f.button('保存记忆').props.onPress());
    await act(async () => f.button('重试上次记忆操作').props.onPress());
    expect(f.text()).toContain('上次请求结果仍待核对');
    expect(f.input('记忆内容').props.editable).toBe(false);
    expect(mocks.rpc.mock.calls[1][2]).toEqual(mocks.rpc.mock.calls[0][2]);
    await act(async () => f.renderer.unmount());
});

it('ignores a delayed save receipt after switching Dot and rejects the old save handler', async () => {
    const success = mocks.rpc.getMockImplementation()!;
    let resolve!: (receipt: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolveRequest => { resolve = resolveRequest; }));
    const f = await memoryForm(), save = f.button('保存记忆').props.onPress;
    await act(async () => save());
    const oldCall = mocks.rpc.mock.calls[0];
    const newDot = '55555555-5555-4555-8555-555555555555';
    const next = { ...f.props, session: { ...f.props.session, id: 'second-session' }, metadata: { ...f.props.metadata, dotId: newDot } };
    mocks.data = { projection: { snapshot: { dots: [{ id: newDot, sessionId: 'second-session' }] }, details: {} } };
    await act(async () => f.renderer.update(React.createElement(DotSessionContent, next)));
    await act(async () => { resolve(await success(...oldCall)); save(); });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(f.text()).not.toContain('记忆已保存');
    expect(f.renderer.root.findAllByType('TextInput')).toHaveLength(0);
    await act(async () => f.renderer.root.findByType('ObservationPanel').props.onEditMemory('第二条', { revision: 4, value: '另一范围', kind: 'fact', expiresAt: null }));
    await act(async () => f.button('保存记忆').props.onPress());
    expect(mocks.rpc.mock.calls[1][2]).toMatchObject({ dotId: newDot, dotSessionId: 'second-session', operation: { key: '第二条', revision: 4 } });
    expect(f.requests).toHaveLength(0);
    await act(async () => f.renderer.unmount());
});

it('shows queue/resource/location state and routes targeted cancellation through the existing user composer',async()=>{
    const task={id:'11111111-1111-4111-8111-111111111111',title:'隔离代码任务',kind:'delegate',status:'queued',needsReview:false,projectID:'project',goalPhase:null,
        instruction:'写入独立文件',runId:null,reason:null,nextWakeAt:null,finishedAt:null,executionSessionId:'actual-session',executionOutcome:null,businessVerification:'unverified',steps:[],result:null,resultTruncated:false,
        queueReason:'execution_slot',canCancel:true,execution:{mode:'worktree',directory:'/fixture/worktrees/task-a',branch:'dot-task/task-a',projectID:'project'}};
    const snapshot={dots:[{id:'22222222-2222-4222-8222-222222222222',sessionId:'dot-session'}]},detail={dotId:'22222222-2222-4222-8222-222222222222',taskTotal:1,tasks:[task],memory:null};
    mocks.data={projection:{snapshot,details:{'22222222-2222-4222-8222-222222222222':{asOf:'2026-11-09T00:00:00Z',data:detail}}}};
    let request:any,renderer!:ReturnType<typeof create>;
    const props={session:{id:'dot-session',presence:'online'} as any,active:true,metadata:{schemaVersion:1 as const,kind:'dot' as const,workspaceId:'11111111-1111-4111-8111-111111111111',workspaceSessionId:'workspace-session',dotId:'22222222-2222-4222-8222-222222222222'},children:(value:unknown)=>{request=value;return React.createElement('Composer');}};
    await act(async()=>{renderer=create(React.createElement(DotSessionContent,props));});
    await act(async()=>renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityRole==='tab'&&node.findByType('Text').props.children==='工作').props.onPress());
    const open=()=>renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityLabel==='查看工作项：隔离代码任务')!;await act(async()=>open().props.onPress());
    const text=()=>JSON.stringify(renderer.root.findAllByType('Text').map((node:any)=>node.props.children));
    expect(text()).toContain('已排队，尚未开始');expect(text()).toContain('dot-task/task-a');expect(text()).toContain('/fixture/worktrees/task-a');
    for(const [reason,label] of [['project-limit','等待本项目执行名额'],['machine-limit','等待机器硬上限名额'],['resource-wait','等待共享排他资源']]) {
        task.queueReason=reason;
        await act(async()=>renderer.update(React.createElement(DotSessionContent,props)));
        expect(text()).toContain(label);
    }
    const cancel=renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityLabel==='在对话中取消此工作')!;expect(cancel).toBeDefined();await act(async()=>cancel.props.onPress());
    expect(request.text).toContain(task.id);expect(request.text).toContain('只取消这一交办');expect(mocks.submit).not.toHaveBeenCalled();
    task.status='waiting-resource';task.queueReason='session_turn';await act(async()=>renderer.update(React.createElement(DotSessionContent,props)));await act(async()=>renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityRole==='tab'&&node.findByType('Text').props.children==='工作').props.onPress());await act(async()=>open().props.onPress());expect(text()).toContain('等待执行资源');expect(text()).toContain('等待同会话前一交办结束');
    task.status='running';task.queueReason='';await act(async()=>renderer.update(React.createElement(DotSessionContent,props)));await act(async()=>renderer.root.findAllByType('Pressable').find((node:any)=>node.props.accessibilityRole==='tab'&&node.findByType('Text').props.children==='工作').props.onPress());await act(async()=>open().props.onPress());expect(text()).toContain('执行中');
    task.status='canceled';task.canCancel=false;await act(async()=>renderer.update(React.createElement(DotSessionContent,props)));expect(text()).toContain('已取消');expect(renderer.root.findAllByType('Pressable').some((node:any)=>node.props.accessibilityLabel==='在对话中取消此工作')).toBe(false);
    await act(async()=>renderer.unmount());
});
