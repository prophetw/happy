import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), submit: vi.fn(), navigate: vi.fn(), data: null as any }));
const dot = { id: '55555555-5555-4555-8555-555555555555', name: '写作助理', instruction: '整理通知',
    sessionId: 'dot-session', status: 'active' as const };
const deleteRequest = { schemaVersion: 1 as const, requestId: '33333333-3333-4333-8333-333333333333',
    action: 'delete' as const, dotId: dot.id };

vi.mock('react-native', async () => {
    const module = await import('react');
    const host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return { ...Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator', 'ScrollView', 'Modal', 'TextInput'].map(name => [name, host(name)])),
        StyleSheet: { create: (value: unknown) => value } };
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    text: '#000', textSecondary: '#666', textLink: '#00c', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc',
} } }) }));
vi.mock('@expo/vector-icons', async () => {
    const module = await import('react'); return { Ionicons: (props: any) => module.createElement('Ionicons', props) };
});
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({}) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => '33333333-3333-4333-8333-333333333333' }));
vi.mock('@/modal', () => ({ Modal: { confirm: mocks.confirm } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ sessions: {} }) },
    useSession: () => ({ presence: 'online', thinking: false }),
}));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: vi.fn() } }));
vi.mock('@/sync/testloopDotsNavigation', () => ({ createTestloopDotsNavigationGuard: () => ({
    update: vi.fn(), invalidate: vi.fn(), begin: vi.fn(),
}) }));
vi.mock('./DotsConnectionsPanel', () => ({ DotsConnectionsPanel: () => null }));
vi.mock('./useDotsWorkspace', () => ({ useDotsWorkspace: () => ({
    ready: true, pending: null, error: null, notice: null, archiveError: null, archivePending: false,
    submit: mocks.submit, retry: vi.fn(), retryArchive: vi.fn(),
    projection: {
        snapshot: { schemaVersion: 1, workspaceId: 'workspace-id', revision: 1, requestId: 'list-request', ok: true, dots: [dot] },
        receipts: {}, deletions: {}, details: {}, pendingRequest: null,
    },
    ...(mocks.data ?? {}),
}) }));

import { DotsWorkspacePanel } from './DotsWorkspaceHome';

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

const press = async (node: any) => act(async () => node.props.onPress());
const button = (renderer: ReturnType<typeof create>, label: string) =>
    renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === label)!;
const management = (renderer: ReturnType<typeof create>) => renderer.root.findByType('Modal');

it('keeps deletion behind confirmation and pending, preserves failures, and closes only after the current snapshot removes the Dot', async () => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
        renderer = create(React.createElement(DotsWorkspacePanel, {
            session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
        }));
    });
    await press(button(renderer, '管理 写作助理'));
    expect(management(renderer).props.visible).toBe(true);
    expect(JSON.stringify(renderer.root.findAllByType('Text').map((node: any) => node.props.children))).toContain('危险操作');

    mocks.confirm.mockResolvedValueOnce(false);
    await press(button(renderer, '删除 Dot'));
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(management(renderer).props.visible).toBe(true);
    expect(button(renderer, '打开 写作助理 的专属对话')).toBeTruthy();

    mocks.confirm.mockResolvedValueOnce(true);
    await press(button(renderer, '删除 Dot'));
    expect(mocks.confirm).toHaveBeenLastCalledWith('删除「写作助理」？', expect.stringContaining('不会物理删除'),
        { confirmText: '删除 Dot', destructive: true });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(deleteRequest);
    expect(management(renderer).props.visible).toBe(true);
    expect(button(renderer, '打开 写作助理 的专属对话')).toBeTruthy();

    mocks.data = { pending: { request: deleteRequest, timedOut: false } };
    await act(async () => renderer.update(React.createElement(DotsWorkspacePanel, {
        session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
    })));
    expect(button(renderer, '删除 Dot').props.disabled).toBe(true);
    await press(button(renderer, '删除 Dot'));
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.submit).toHaveBeenCalledTimes(1);

    mocks.data = {
        error: '后台未接受本次操作（delete_failed）。',
        projection: {
            snapshot: { schemaVersion: 1, workspaceId: 'workspace-id', revision: 2, requestId: deleteRequest.requestId, ok: false, dots: [dot] },
            receipts: { [deleteRequest.requestId]: { ok: false, error: 'delete_failed', dots: [dot] } },
            deletions: {}, details: {}, pendingRequest: null,
        },
    };
    await act(async () => renderer.update(React.createElement(DotsWorkspacePanel, {
        session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
    })));
    expect(management(renderer).props.visible).toBe(true);
    expect(JSON.stringify(renderer.root.findAllByType('Text').map((node: any) => node.props.children))).toContain('delete_failed');

    const deletedDot = { id: dot.id, sessionId: dot.sessionId };
    mocks.data = {
        projection: {
            snapshot: { schemaVersion: 1, workspaceId: 'workspace-id', revision: 2, requestId: deleteRequest.requestId, ok: true, dots: [dot] },
            receipts: { [deleteRequest.requestId]: { ok: true, revision: 2, dots: [], deletedDot } },
            deletions: {}, details: {}, pendingRequest: null,
        },
    };
    await act(async () => renderer.update(React.createElement(DotsWorkspacePanel, {
        session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
    })));
    expect(management(renderer).props.visible).toBe(true);
    expect(button(renderer, '打开 写作助理 的专属对话')).toBeTruthy();

    mocks.data = {
        notice: '已删除 Dot；Happy 会话与历史记录保留，本地归档会按持久回执自动核对。',
        projection: {
            snapshot: { schemaVersion: 1, workspaceId: 'workspace-id', revision: 2, requestId: deleteRequest.requestId, ok: true, dots: [], deletedDot },
            receipts: { [deleteRequest.requestId]: { ok: true, revision: 2, dots: [], deletedDot } },
            deletions: { [deleteRequest.requestId]: { ...deleteRequest, ...deletedDot, revision: 2 } }, details: {}, pendingRequest: null,
        },
    };
    await act(async () => renderer.update(React.createElement(DotsWorkspacePanel, {
        session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
    })));
    expect(management(renderer).props.visible).toBe(false);
    expect(renderer.root.findAllByType('Pressable').some((node: any) => node.props.accessibilityLabel === '打开 写作助理 的专属对话')).toBe(false);
    expect(mocks.navigate).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('shows archive mirror failure separately with an explicit idempotent retry control', async () => {
    const retryArchive = vi.fn();
    mocks.data = { archiveError: '宿主已删除 Dot，但本地会话归档尚未完成；历史记录仍保留，可单独重试本地归档。', retryArchive };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
        renderer = create(React.createElement(DotsWorkspacePanel, {
            session: { id: 'workspace-session' } as any, workspaceId: 'workspace-id', active: true,
        }));
    });
    expect(JSON.stringify(renderer.root.findAllByType('Text').map((node: any) => node.props.children))).toContain('宿主已删除 Dot');
    await press(button(renderer, '重试本地归档'));
    expect(retryArchive).toHaveBeenCalledExactlyOnceWith();
    await act(async () => renderer.unmount());
});
