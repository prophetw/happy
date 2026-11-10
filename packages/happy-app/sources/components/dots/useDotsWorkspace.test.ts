import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { TESTLOOP_DOTS_PREFIX, testloopDotsCommand } from '@/sync/testloopDots';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const dotId = '55555555-5555-4555-8555-555555555555';
const clearId = '33333333-3333-4333-8333-333333333333';
const deleteId = '44444444-4444-4444-8444-444444444444';
const listId = '66666666-6666-4666-8666-666666666666';
const dot = { id: dotId, name: '写作助理', instruction: '整理通知', sessionId: 'dot-session', status: 'active' as const };
const clearRequest = { schemaVersion: 1 as const, requestId: clearId, action: 'clear' as const, dotId };
const deleteRequest = { schemaVersion: 1 as const, requestId: deleteId, action: 'delete' as const, dotId };
const mocks = vi.hoisted(() => ({
    messages: [] as any[], values: [] as any[], sendMessage: vi.fn(), ensureSessionReady: vi.fn(),
    archive: vi.fn(), updateIdentity: vi.fn(), read: vi.fn(), loaded: false, token: 'token',
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => listId }));
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({
    credentials: { token: mocks.token, secret: 'secret' }, isAuthenticated: true,
}) }));
vi.mock('@/hooks/useSessionVisibility', () => ({ useSessionVisibility: vi.fn() }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'https://test.invalid' }));
vi.mock('@/sync/storage', () => ({
    useRealtimeStatus: () => 'connected',
    useSessionMessages: () => ({ messages: mocks.messages, isLoaded: mocks.loaded }),
    storage: { getState: () => ({ sessions: {
        'workspace-session': { id: 'workspace-session', active: true, metadata: { testloopDots: {
            schemaVersion: 1, kind: 'workspace', workspaceId,
        } } },
        'dot-session': { id: 'dot-session', active: true, metadata: { lifecycleState: 'running', testloopDots: {
            schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: 'workspace-session', dotId,
        } } },
    } }) },
}));
vi.mock('@/sync/sync', () => ({ sync: {
    getCredentials: () => ({ token: mocks.token, secret: 'secret' }),
    sendMessage: mocks.sendMessage, ensureSessionReady: mocks.ensureSessionReady,
} }));
vi.mock('@/sync/ops', () => ({ sessionArchiveTestloopDot: mocks.archive, sessionUpdateDotIdentity: mocks.updateIdentity }));

vi.mock('@/sync/dotsWorkspaceRead', () => ({ readDotsWorkspace: mocks.read }));

import { useDotsWorkspace } from './useDotsWorkspace';

function Harness({ index = 0 }: { index?: number }) {
    const value = useDotsWorkspace('workspace-session', workspaceId, true);
    mocks.values[index] = value;
    return null;
}

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
    mocks.messages = [];
    mocks.loaded = false; mocks.token = 'token';
    mocks.read.mockReset().mockRejectedValue(new Error('offline'));
    mocks.values = [];
    mocks.sendMessage.mockReset().mockResolvedValue(true);
    mocks.ensureSessionReady.mockReset().mockResolvedValue(undefined);
    mocks.archive.mockReset().mockResolvedValue(undefined);
    mocks.updateIdentity.mockReset().mockResolvedValue(undefined);
});

const command = (request: typeof clearRequest | typeof deleteRequest) => ({
    kind: 'user-text', id: `command-${request.action}`, createdAt: 1, text: testloopDotsCommand(request),
});
const receipt = (requestId: string, revision: number, dots: unknown[], extra = {}, id = `receipt-${requestId}-${revision}`) => ({
    kind: 'agent-text', id, createdAt: revision + 10, meta: { sentFrom: 'testloop-assistant' },
    text: TESTLOOP_DOTS_PREFIX + JSON.stringify({ schemaVersion: 1, workspaceId, revision, requestId, ok: true, dots, ...extra }),
});
const render = async (indexes = [0]) => {
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
        renderer = create(React.createElement(React.Fragment, null, indexes.map(index => React.createElement(Harness, { key: index, index }))));
    });
    return renderer;
};
const update = async (renderer: ReturnType<typeof create>, indexes = [0]) => act(async () => {
    renderer.update(React.createElement(React.Fragment, null, indexes.map(index => React.createElement(Harness, { key: index, index }))));
});

it('announces clear only while the current host projection retains the same Dot/session binding', async () => {
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(clearRequest); });
    expect(mocks.sendMessage).toHaveBeenCalledWith('workspace-session', testloopDotsCommand(clearRequest), expect.objectContaining({
        displayText: '清空 Dot 当前对话上下文',
    }));
    mocks.messages = [command(clearRequest), receipt(clearId, 1, [dot])];
    await update(renderer);
    expect(mocks.values[0].pending).toBeNull();
    expect(mocks.values[0].error).toBeNull();
    expect(mocks.values[0].notice).toContain('已清空旧聊天并重置模型上下文');
    expect(mocks.archive).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('keeps historical deletion receipts silent while still reconciling the local archive', async () => {
    mocks.messages = [command(deleteRequest), receipt(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } })];
    const renderer = await render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('dot-session', dotId);
    expect(mocks.values[0].notice).toBeNull();
    await act(async () => renderer.unmount());
});

it('waits for the latest projection before confirming deletion, then separately retries a failed archive mirror', async () => {
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(deleteRequest); });
    mocks.messages = [
        command(deleteRequest),
        receipt(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } }),
        receipt(listId, 3, [dot]),
    ];
    await update(renderer);
    expect(mocks.values[0].pending).toBeNull();
    expect(mocks.values[0].error).toContain('等待最新列表确认目标已消失');
    expect(mocks.values[0].notice).toBeNull();
    expect(mocks.archive).not.toHaveBeenCalled();

    mocks.messages = [...mocks.messages, receipt(listId, 4, [], {}, 'latest-without-dot')];
    mocks.archive.mockRejectedValueOnce(new Error('metadata failed'));
    await update(renderer);
    expect(mocks.values[0].error).toBeNull();
    expect(mocks.values[0].notice).toContain('已删除 Dot');
    expect(mocks.ensureSessionReady).toHaveBeenCalledWith('dot-session');
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('dot-session', dotId);
    expect(mocks.values[0].archiveError).toContain('宿主已删除 Dot');

    await act(async () => { await mocks.values[0].retryArchive(); });
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    expect(mocks.values[0].archiveError).toBeNull();
    expect(mocks.values[0].notice).toContain('已删除 Dot');
    await act(async () => renderer.unmount());
});

it('shares one in-flight archive attempt by dotId across workspace observers', async () => {
    let finish!: () => void;
    mocks.archive.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    mocks.messages = [command(deleteRequest), receipt(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } })];
    const renderer = await render([0, 1]);
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('dot-session', dotId);
    expect(mocks.values[0].archivePending).toBe(true);
    expect(mocks.values[1].archivePending).toBe(true);
    await act(async () => { finish(); });
    expect(mocks.values[0].archivePending).toBe(false);
    expect(mocks.values[1].archivePending).toBe(false);
    expect(mocks.values[0].archiveError).toBeNull();
    expect(mocks.values[1].archiveError).toBeNull();
    await act(async () => renderer.unmount());
});


it('opens with a read RPC instead of a chat command, without waiting for chat history', async () => {
    mocks.read.mockResolvedValue({ schemaVersion: 1, workspaceId, revision: 1, requestId: listId, ok: true, dots: [dot] });
    const renderer = await render();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.values[0].pending).toBeNull();
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    await act(async () => renderer.unmount());
});

it('keeps cached directory and mutations usable during a slow refresh and retains it on read failure', async () => {
    let reject!: (error: Error) => void;
    mocks.messages = [receipt(listId, 1, [dot])];
    mocks.read.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const renderer = await render();
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    expect(mocks.values[0].refreshing).toBe(true);
    expect(mocks.values[0].pending).toBeNull();
    await act(async () => reject(new Error('offline')));
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    expect(mocks.values[0].refreshing).toBe(false);
    expect(mocks.values[0].error).toContain('刷新');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('does not let a late read resurrect a Dot removed by a newer mutation receipt', async () => {
    let finish!: (value: unknown) => void;
    mocks.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    mocks.messages = [receipt(listId, 1, [dot])];
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(deleteRequest); });
    mocks.messages = [command(deleteRequest), receipt(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } })];
    await update(renderer);
    await act(async () => finish({ schemaVersion: 1, workspaceId, revision: 1, requestId: listId, ok: true, dots: [dot] }));
    expect(mocks.values[0].projection.snapshot.dots).toEqual([]);
    expect(mocks.values[0].notice).toContain('已删除');
    await act(async () => renderer.unmount());
});


it('deduplicates refreshes and ignores an old account response after credentials change', async () => {
    let finish!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const renderer = await render();
    await act(async () => { void mocks.values[0].refresh(); void mocks.values[0].refresh(); });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    mocks.token = 'different-account'; mocks.messages = [];
    mocks.read.mockResolvedValue({ schemaVersion: 1, workspaceId, revision: 2, requestId: listId, ok: true, dots: [] });
    await update(renderer);
    await act(async () => finish({ schemaVersion: 1, workspaceId, revision: 1, requestId: listId, ok: true, dots: [dot] }));
    expect(mocks.values[0].projection.snapshot.dots).toEqual([]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});
