import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
import { readDotsWorkspace } from './dotsWorkspaceRead';
const workspaceId = '11111111-1111-4111-8111-111111111111', requestId = '22222222-2222-4222-8222-222222222222';
const request = { schemaVersion: 1 as const, workspaceId, requestId, action: 'list' as const };
const snapshot = { schemaVersion: 1, workspaceId, requestId, revision: 1, ok: true, dots: [] };
beforeEach(() => { mocks.rpc.mockReset(); });
afterEach(() => vi.useRealTimers());
it('validates the encrypted read response and original request/workspace identity', async () => {
    mocks.rpc.mockResolvedValue(snapshot);
    await expect(readDotsWorkspace('workspace-session', request)).resolves.toEqual(snapshot);
    expect(mocks.rpc).toHaveBeenCalledWith('workspace-session', 'testloop-dots-read', request);
    for (const patch of [{ workspaceId: requestId }, { requestId: workspaceId }, { ok: false }, { dots: 'bad' }]) {
        mocks.rpc.mockResolvedValue({ ...snapshot, ...patch });
        await expect(readDotsWorkspace('workspace-session', request)).rejects.toThrow('dots_read_unconfirmed');
    }
});
it('rejects inspect responses missing the requested detail', async () => {
    mocks.rpc.mockResolvedValue({ ...snapshot, dots: [{ id: requestId, name: '助理', instruction: '整理通知', sessionId: 'dot', status: 'active' }] });
    await expect(readDotsWorkspace('workspace-session', { ...request, action: 'inspect', dotId: requestId })).rejects.toThrow('dots_read_unconfirmed');
});

it('accepts the current directory without detail when the inspected Dot has been deleted', async () => {
    const deletion = { requestId, revision: 1, id: requestId, sessionId: 'retired-dot-session' };
    mocks.rpc.mockResolvedValue({ ...snapshot, deletedDots: [deletion] });
    await expect(readDotsWorkspace('workspace-session', { ...request, action: 'inspect', dotId: requestId,
        archiveSessionIds: ['retired-dot-session'] })).resolves.toMatchObject({ dots: [], deletedDots: [deletion] });
});
it('bounds an offline read without turning it into a chat request', async () => {
    vi.useFakeTimers(); mocks.rpc.mockImplementation(() => new Promise(() => {}));
    const promise = expect(readDotsWorkspace('workspace-session', request)).rejects.toThrow('dots_read_timeout');
    await vi.advanceTimersByTimeAsync(10000); await promise;
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
});

it('accepts durable deletion proofs only for the local session IDs requested for archive reconciliation', async () => {
    const deletion = { requestId: '33333333-3333-4333-8333-333333333333', revision: 1,
        id: '44444444-4444-4444-8444-444444444444', sessionId: 'retired-dot-session' };
    const scoped = { ...request, archiveSessionIds: ['retired-dot-session'] };
    mocks.rpc.mockResolvedValue({ ...snapshot, deletedDots: [deletion] });
    await expect(readDotsWorkspace('workspace-session', scoped)).resolves.toMatchObject({ deletedDots: [deletion] });
    mocks.rpc.mockResolvedValue({ ...snapshot, deletedDots: [{ ...deletion, sessionId: 'unrequested-session' }] });
    await expect(readDotsWorkspace('workspace-session', scoped)).rejects.toThrow('dots_read_unconfirmed');
    mocks.rpc.mockResolvedValue({ ...snapshot, deletedDots: [{ ...deletion, revision: 2 }] });
    await expect(readDotsWorkspace('workspace-session', scoped)).rejects.toThrow('dots_read_unconfirmed');
});
