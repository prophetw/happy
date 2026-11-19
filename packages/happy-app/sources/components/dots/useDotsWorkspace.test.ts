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
    rpc: vi.fn(), valuesOnDisk: new Map<string, string>(), encryptions: new Map<string, any>(), failStorage: false,
    extraSessions: {} as Record<string, any>,
    active: true, realtime: 'connected', socket: 'connected',
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
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return mocks.valuesOnDisk.get(key); }
    getAllKeys() { return [...mocks.valuesOnDisk.keys()]; }
    set(key: string, value: string) { if (mocks.failStorage) throw new Error('disk full'); mocks.valuesOnDisk.set(key, value); }
    delete(key: string) { mocks.valuesOnDisk.delete(key); }
} }));
vi.mock('@/sync/storage', () => ({
    useRealtimeStatus: () => mocks.realtime,
    useSocketStatus: () => ({ status: mocks.socket }),
    useSessionMessages: () => ({ messages: mocks.messages, isLoaded: mocks.loaded }),
    storage: { getState: () => ({ sessions: {
        'workspace-session': { id: 'workspace-session', active: true, metadata: { testloopDots: {
            schemaVersion: 1, kind: 'workspace', workspaceId,
        } } },
        'dot-session': { id: 'dot-session', active: true, metadata: { lifecycleState: 'running', testloopDots: {
            schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: 'workspace-session', dotId,
        } } },
        ...mocks.extraSessions,
    } }) },
}));
vi.mock('@/sync/sync', () => ({ sync: {
    get encryption() {
        if (!mocks.encryptions.has(mocks.token)) mocks.encryptions.set(mocks.token, {
            anonID: mocks.token, encryptRaw: async (value: unknown) => JSON.stringify(value), decryptRaw: async (value: string) => JSON.parse(value),
        });
        return mocks.encryptions.get(mocks.token);
    },
    getCredentials: () => ({ token: mocks.token, secret: 'secret' }),
    sendMessage: mocks.sendMessage, ensureSessionReady: mocks.ensureSessionReady,
} }));
vi.mock('@/sync/ops', () => ({ sessionArchiveTestloopDot: mocks.archive, sessionUpdateDotIdentity: mocks.updateIdentity }));

vi.mock('@/sync/dotsWorkspaceRead', () => ({ readDotsWorkspace: mocks.read }));

import { useDotsWorkspace } from './useDotsWorkspace';

function Harness({ index = 0 }: { index?: number }) {
    const value = useDotsWorkspace('workspace-session', workspaceId, mocks.active);
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
let accountSequence = 0;
beforeEach(() => {
    mocks.messages = [];
    mocks.loaded = false; mocks.token = `token-${++accountSequence}`;
    mocks.valuesOnDisk.clear(); mocks.encryptions.clear(); mocks.failStorage = false;
    mocks.extraSessions = {};
    mocks.active = true; mocks.realtime = 'disconnected'; mocks.socket = 'connected';
    mocks.rpc.mockReset().mockImplementation(async (_session, _method, request) => ({ ok: true, data: {
        schemaVersion: 1, workspaceId, requestId: request.command.requestId, status: 'queued', error: null,
    } }));
    mocks.read.mockReset().mockImplementation(async (_session, request) => ({
        schemaVersion: 1, workspaceId, revision: 0, requestId: request.requestId, ok: true, dots: [],
    }));
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

it('applies a management RPC receipt immediately without sending or waiting for chat messages', async () => {
    const request = { schemaVersion: 1 as const, requestId: clearId, action: 'create' as const, name: dot.name, instruction: dot.instruction };
    mocks.rpc.mockResolvedValue({ ok: true, data: { schemaVersion: 1, workspaceId, requestId: clearId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision: 1, requestId: clearId, ok: true, dots: [dot] },
    } });
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(request); });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    expect(mocks.values[0].notice).toContain('已创建');
    expect(mocks.messages).toEqual([]);
    await act(async () => renderer.unmount());
});

it('finds cross-device deletion proofs in bounded batches without requiring command chat history', async () => {
    const deletedId = '77777777-7777-4777-8777-777777777777';
    for (let index = 1; index <= 51; index++) {
        const id = `old-session-${index}`;
        mocks.extraSessions[id] = { id, active: true, metadata: { testloopDots: {
            schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: 'workspace-session', dotId: deletedId,
        } } };
    }
    mocks.extraSessions.foreign = { id: 'foreign', metadata: { testloopDots: { schemaVersion: 1, kind: 'dot',
        workspaceId: deletedId, workspaceSessionId: 'workspace-session', dotId: deletedId } } };
    mocks.read.mockImplementation(async (_session, request) => ({ schemaVersion: 1, workspaceId, revision: 5, requestId: request.requestId, ok: true, dots: [dot],
        deletedDots: request.archiveSessionIds?.includes('old-session-51')
            ? [{ requestId: deleteId, revision: 4, id: deletedId, sessionId: 'old-session-51' }] : [],
    }));
    const renderer = await render();
    const batches = mocks.read.mock.calls.map(([_session, request]) => request.archiveSessionIds ?? []);
    expect(batches.map(batch => batch.length)).toEqual([50, 2]);
    expect(new Set(batches.flat()).size).toBe(52);
    expect(batches.flat()).not.toContain('foreign');
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('old-session-51', deletedId);
    expect(mocks.values[0].notice).toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

const applied = (requestId: string, revision = 1, dots: unknown[] = [dot], extra = {}) => ({
    ok: true, data: { schemaVersion: 1, workspaceId, requestId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision, requestId, ok: true, dots, ...extra } },
});
const writeCalls = () => mocks.rpc.mock.calls.filter(([, method]) => method === 'testloop-dots-command');
const readReceipt = async (requestId: string, response: unknown) => {
    mocks.rpc.mockResolvedValueOnce(response);
    await act(async () => { await mocks.values[0].checkReceipt(requestId); });
};

it('automatically reads the restored original receipt with Relay connected and voice disconnected', async () => {
    mocks.realtime = 'disconnected';
    mocks.valuesOnDisk.set(JSON.stringify([mocks.token, 'https://test.invalid', 'workspace-session', workspaceId]),
        JSON.stringify({ schemaVersion: 1, serverUrl: 'https://test.invalid', sessionId: 'workspace-session',
            workspaceId, command: clearRequest }));
    mocks.rpc.mockResolvedValue(applied(clearId));
    const renderer = await render();
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.rpc).toHaveBeenCalledWith('workspace-session', 'testloop-dots-read',
        { schemaVersion: 1, workspaceId, action: 'receipt', command: clearRequest });
    expect(writeCalls()).toHaveLength(0);
    expect(mocks.values[0].projection.receipts[clearId]?.ok).toBe(true);
    await act(async () => renderer.unmount());
});

it('polls an original processing request while voice is disconnected and settles when its ledger finishes', async () => {
    vi.useFakeTimers();
    mocks.realtime = 'disconnected';
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(clearRequest); });
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    try {
        mocks.rpc.mockResolvedValueOnce(applied(clearId));
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(mocks.values[0].pendingCommands).toEqual([]);
        expect(writeCalls()).toHaveLength(1);
    } finally {
        await act(async () => renderer.unmount());
        vi.useRealTimers();
    }
});

it('restores a lost-response command and reads its original receipt without writing after reload', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('response lost'));
    let renderer = await render();
    await act(async () => { await mocks.values[0].submit(clearRequest); });
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    await act(async () => renderer.unmount());
    renderer = await render();
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    await readReceipt(clearId, applied(clearId));
    expect(mocks.rpc).toHaveBeenLastCalledWith('workspace-session', 'testloop-dots-read',
        { schemaVersion: 1, workspaceId, action: 'receipt', command: clearRequest });
    expect(writeCalls()).toHaveLength(1);
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.values[0].notice).toContain('已清空');
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('keeps two targets independent and reconciles the remaining original request on reconnect', async () => {
    const other = { ...dot, id: '77777777-7777-4777-8777-777777777777', name: 'B', sessionId: 'other-session' };
    const second = { ...clearRequest, dotId: other.id, requestId: deleteId };
    let finishA!: (reply: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
    const renderer = await render();
    await act(async () => { void mocks.values[0].submit(clearRequest); });
    await act(async () => { await mocks.values[0].submit(second); });
    expect(mocks.values[0].pendingCommands.map(({ request }: { request: { requestId: string } }) => request.requestId))
        .toEqual([clearId, deleteId]);
    await act(async () => { expect(await mocks.values[0].submit({ ...clearRequest, requestId: listId })).toBe(false); });
    await act(async () => finishA(applied(clearId, 2, [dot, other])));
    expect(mocks.values[0].pendingFor(dotId)).toBeUndefined();
    expect(mocks.values[0].pendingFor(other.id)?.request).toEqual(second);
    await readReceipt(deleteId, applied(clearId, 2, [dot, other]));
    expect(mocks.values[0].pendingFor(other.id)?.message).toContain('暂时无法核对');

    mocks.socket = 'disconnected'; await update(renderer);
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { schemaVersion: 1, workspaceId, requestId: deleteId,
        status: 'rejected', error: 'dot_clear_refused' } });
    mocks.socket = 'connected'; await update(renderer);
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.values[0].errorFor(other.id)).toContain('dot_clear_refused');
    expect(mocks.values[0].projection.receipts[clearId]?.ok).toBe(true);
    expect(mocks.values[0].projection.receipts[deleteId]?.ok).toBe(false);
    expect(writeCalls()).toHaveLength(2);
    await act(async () => renderer.unmount());
});

it('does not send a command if its recovery intent cannot be saved', async () => {
    const renderer = await render();
    mocks.failStorage = true;
    await act(async () => { expect(await mocks.values[0].submit(clearRequest)).toBe(false); });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.values[0].error).toContain('未发送新操作');
    await act(async () => renderer.unmount());
});

it('keeps a successful receipt through blur and consumes it when the same workspace returns', async () => {
    let finish!: (reply: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const renderer = await render();
    await act(async () => { void mocks.values[0].submit(clearRequest); });
    mocks.active = false; await update(renderer);
    await act(async () => finish({ ok: true, data: { schemaVersion: 1, workspaceId, requestId: clearId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision: 1, requestId: clearId, ok: true, dots: [dot] },
    } }));
    mocks.active = true; await update(renderer);
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(writeCalls()).toHaveLength(1);
    await act(async () => renderer.unmount());
});

it('recovers an old chat command from the ledger before history reloads', async () => {
    mocks.loaded = true; mocks.messages = [command(clearRequest)];
    let renderer = await render();
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    mocks.messages = [command(clearRequest), receipt(clearId, 1, [dot])];
    await update(renderer);
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    await readReceipt(clearId, applied(clearId));
    expect(mocks.values[0].pendingCommands).toEqual([]);
    await act(async () => renderer.unmount());
    mocks.loaded = false; mocks.messages = [];
    renderer = await render();
    expect(mocks.values[0].pendingCommands).toEqual([]);
    expect(mocks.values[0].projection.snapshot.dots).toEqual([dot]);
    expect(writeCalls()).toHaveLength(0);
    await act(async () => renderer.unmount());
});

it('does not replace a new account pending command with an old account response', async () => {
    let finish!: (reply: unknown) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const renderer = await render();
    await act(async () => { void mocks.values[0].submit(clearRequest); });
    mocks.token = 'second-command-account'; await update(renderer);
    await act(async () => { await mocks.values[0].submit(deleteRequest); });
    await act(async () => finish({ ok: true, data: { schemaVersion: 1, workspaceId, requestId: clearId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision: 1, requestId: clearId, ok: true, dots: [dot] },
    } }));
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(deleteRequest);
    expect(mocks.values[0].projection.receipts[clearId]).toBeUndefined();
    expect(mocks.values[0].notice).toBeNull();
    await act(async () => renderer.unmount());
});

it('does not mirror an accepted rename after its account changed while the session was loading', async () => {
    let finish!: () => void;
    mocks.ensureSessionReady.mockImplementation((id: string) => id === 'dot-session' ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
    const request = { schemaVersion: 1 as const, requestId: clearId, action: 'update' as const, dotId, name: '新名字', instruction: '新职责' };
    mocks.rpc.mockResolvedValue({ ok: true, data: { schemaVersion: 1, workspaceId, requestId: clearId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision: 1, requestId: clearId, ok: true, dots: [{ ...dot, name: '新名字', instruction: '新职责' }] },
    } });
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(request); });
    mocks.token = 'second-rename-account'; await update(renderer);
    await act(async () => finish());
    expect(mocks.updateIdentity).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
});

it('does not mirror an older rename after a newer accepted rename finishes loading first', async () => {
    const finishes: (() => void)[] = [];
    mocks.ensureSessionReady.mockImplementation((id: string) => id === 'dot-session'
        ? new Promise<void>(resolve => { finishes.push(resolve); }) : Promise.resolve());
    let revision = 0;
    mocks.rpc.mockImplementation(async (_session, _method, { command: request }) => ({ ok: true, data: {
        schemaVersion: 1, workspaceId, requestId: request.requestId, status: 'applied', error: null,
        snapshot: { schemaVersion: 1, workspaceId, revision: ++revision, requestId: request.requestId, ok: true,
            dots: [{ ...dot, name: request.name, instruction: request.instruction }] },
    } }));
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit({ schemaVersion: 1, requestId: clearId, action: 'update', dotId, name: '名称 A', instruction: '职责 A' }); });
    await act(async () => { await mocks.values[0].submit({ schemaVersion: 1, requestId: deleteId, action: 'update', dotId, name: '名称 B', instruction: '职责 B' }); });
    expect(finishes).toHaveLength(2);
    await act(async () => finishes[1]());
    expect(mocks.updateIdentity).toHaveBeenCalledExactlyOnceWith(dot.sessionId, '名称 B', '职责 B');
    await act(async () => finishes[0]());
    expect(mocks.updateIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.values[0].projection.snapshot.dots[0].name).toBe('名称 B');
    await act(async () => renderer.unmount());
});

it('announces clear only while the current host projection retains the same Dot/session binding', async () => {
    const renderer = await render();
    await act(async () => { await mocks.values[0].submit(clearRequest); });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith('workspace-session', 'testloop-dots-command', {
        schemaVersion: 1, workspaceId, command: clearRequest,
    });
    mocks.messages = [command(clearRequest), receipt(clearId, 1, [dot])];
    await update(renderer);
    expect(mocks.values[0].pendingFor(dotId)?.request).toEqual(clearRequest);
    await readReceipt(clearId, applied(clearId));
    expect(mocks.values[0].pendingCommands).toEqual([]);
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
    await readReceipt(deleteId, applied(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } }));
    expect(mocks.values[0].pendingCommands).toEqual([]);
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

it('keeps archive attempts and completion state isolated when the account changes', async () => {
    const finishes: (() => void)[] = [];
    mocks.archive.mockImplementation(() => new Promise<void>(resolve => { finishes.push(resolve); }));
    mocks.messages = [command(deleteRequest), receipt(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } })];
    const renderer = await render();
    mocks.token = 'second-archive-account'; await update(renderer);
    expect(mocks.archive).toHaveBeenCalledTimes(2);
    await act(async () => finishes[0]());
    expect(mocks.values[0].archivePending).toBe(true);
    await act(async () => finishes[1]());
    expect(mocks.values[0].archivePending).toBe(false);
    await act(async () => renderer.unmount());
});


it('opens with a read RPC instead of a chat command, without waiting for chat history', async () => {
    mocks.read.mockResolvedValue({ schemaVersion: 1, workspaceId, revision: 1, requestId: listId, ok: true, dots: [dot] });
    const renderer = await render();
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.values[0].pendingCommands).toEqual([]);
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
    expect(mocks.values[0].pendingCommands).toEqual([]);
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
    await readReceipt(deleteId, applied(deleteId, 2, [], { deletedDot: { id: dotId, sessionId: dot.sessionId } }));
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
