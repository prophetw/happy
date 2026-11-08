import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), visibility: vi.fn(), confirm: vi.fn(), submit: vi.fn(), data: null as any }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator', 'ScrollView', 'Modal', 'TextInput'].map(name => [name, host(name)]));
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc' } } }) }));
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/hooks/useSessionVisibility', () => ({ useSessionVisibility: mocks.visibility }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) }, useRealtimeStatus: () => 'connected' }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: vi.fn() } }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '33333333-3333-4333-8333-333333333333' }));
vi.mock('./DotsConnectionsPanel', () => ({ DotsConnectionsPanel: () => null }));
vi.mock('./DotRecoveryNotice', () => ({ DotRecoveryNotice: () => null }));
vi.mock('./DotObservationPanel', async () => {
    const module = await import('react'); return { DotObservationPanel: (props: any) => module.createElement('ObservationPanel', props) };
});
vi.mock('./useDotsWorkspace', () => ({ useDotsWorkspace: () => ({ ready: true, pending: null, error: null, notice: null, retry: vi.fn(), submit: mocks.submit,
    projection: { snapshot: { dots: [{ id: 'dot-id', sessionId: 'dot-session' }] }, details: { 'dot-id': { asOf: '2026-11-05T00:00:00Z',
        data: { dotId: 'dot-id', taskTotal: 0, tasks: [], memory: { access: ['read', 'write', 'forget'], total: 0, items: [], omittedCount: 0 } } } } },
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
    mocks.confirm.mockReset();
    mocks.submit.mockReset();
    mocks.navigate.mockReset();
});
it('confirms destructive clear and returns to the workspace while the host rotates the session', async () => {
    let mounts = 0;
    function Composer() {
        React.useEffect(() => { mounts++; }, []);
        const [draft] = React.useState('不能丢失的草稿');
        return React.createElement('Composer', { draft });
    }
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: 'workspace-id', workspaceSessionId: 'workspace-session', dotId: 'dot-id' },
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
        requestId: '33333333-3333-4333-8333-333333333333', action: 'clear', dotId: 'dot-id' });
    expect(mocks.navigate).toHaveBeenCalledWith('workspace-session');
    expect(renderer.root.findByType('Composer').props.draft).toBe('不能丢失的草稿');
    expect(mounts).toBe(1);

    mocks.data = { notice: '已为之后的模型上下文隔离此前历史；旧聊天、长期记忆、授权、任务记录和进行中目标均保留。' };
    await act(async () => renderer.update(React.createElement(DotSessionContent, props)));
    expect(JSON.stringify(renderer.root.findAllByType('Text').map((node: any) => node.props.children))).toContain('旧聊天、长期记忆');
    expect(renderer.root.findByType('Composer').props.draft).toBe('不能丢失的草稿');
    await act(async () => renderer.unmount());
});

it('disables clearing while a host request is pending', async () => {
    mocks.data = { pending: { request: { action: 'inspect' }, timedOut: false } };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
        renderer = create(React.createElement(DotSessionContent, {
            session: { id: 'dot-session', presence: 'online' } as any, active: true,
            metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: 'workspace-id', workspaceSessionId: 'workspace-session', dotId: 'dot-id' },
            children: () => React.createElement('Composer'),
        }));
    });
    const clear = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '清空当前对话')!;
    expect(clear.props.disabled).toBe(true);
    await act(async () => clear.props.onPress());
    expect(mocks.confirm).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('keeps the real composer mounted through observer tabs and routes memory editing into that conversation', async () => {
    let mounts = 0; const requests: unknown[] = [];
    function Composer({ request }: { request: unknown }) {
        React.useEffect(() => { mounts++; }, []);
        const [draft, setDraft] = React.useState('原有草稿');
        React.useEffect(() => { if (request) requests.push(request); }, [request]);
        return React.createElement('Composer', { draft, setDraft });
    }
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: 'workspace-id', workspaceSessionId: 'workspace-session', dotId: 'dot-id' },
        children: (request: unknown) => React.createElement(Composer, { request }) };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const tabs = () => renderer.root.findAllByType('Pressable').filter((node: any) => node.props.accessibilityRole === 'tab');
    const switchTo = async (title: string) => act(async () => tabs().find((node: any) => node.findByType('Text').props.children === title).props.onPress());
    await switchTo('记忆');
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    const panel = renderer.root.findByType('ObservationPanel'); expect(panel.props.mode).toBe('memory'); expect(panel.props.active).toBe(true);
    await act(async () => panel.props.onEditMemory('偏好', { revision: 2, value: '新偏好', kind: 'preference', expiresAt: null }));
    const confirm = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '带入对话并确认');
    await act(async () => confirm.props.onPress());
    expect(requests).toHaveLength(1); expect(JSON.stringify(requests)).toContain('新偏好');
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    await switchTo('本轮依据'); expect(renderer.root.findByType('ObservationPanel').props.mode).toBe('basis');
    await act(async () => renderer.unmount());
});

it('carries user-level scope explicitly into the existing edit and forget conversation', async () => {
    let request: { text: string } | null = null;
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online', metadata: { codexThreadId: 'native-thread' } } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: 'workspace-id', workspaceSessionId: 'workspace-session', dotId: 'dot-id' },
        children: (value: any) => { request = value; return React.createElement('Composer'); } };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const panel = renderer.root.findByType('ObservationPanel');
    await act(async () => panel.props.onEditMemory('偏好', { revision: 1, value: '共享偏好', kind: 'preference', expiresAt: null }, 'user'));
    const send = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '带入对话')!;
    await act(async () => send.props.onPress());
    expect(request!.text).toContain('用户级（所有 Dot 共享）记忆');
    expect(request!.text).toContain('直接保存并告知结果');
    await act(async () => panel.props.onForgetMemory('偏好', 'user'));
    expect(request!.text).toContain('请忘记用户级（所有 Dot 共享）记忆');
    await act(async () => renderer.unmount());
});
