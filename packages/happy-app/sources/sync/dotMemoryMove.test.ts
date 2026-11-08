import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), pending: new Map<string, string>() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return mocks.pending.get(key); }
    set(key: string, value: string) { mocks.pending.set(key, value); }
} }));
import { clearDotMemoryMove, dotMemoryMoveNotice, loadDotMemoryMoves, requestDotMemoryMove, saveDotMemoryMove } from './dotMemoryMove';
const dotId = '22222222-2222-4222-8222-222222222222', requestID = '44444444-4444-4444-8444-444444444444';
const keyDigest = 'sha256:' + 'b'.repeat(64);
const intent = { dotId, requestID, keyDigest, sourceScope: 'dot' as const, sourceRevision: 4 };
const receipt = { ...intent, schemaVersion: 1, targetScope: 'user', targetExpectedRevision: 0, targetRevision: 0,
    status: 'ready', indexing: 'pending', cleanup: 'pending' };
beforeEach(() => { mocks.rpc.mockReset(); mocks.pending.clear(); });

it('sends only source snapshot and CAS metadata through the encrypted session RPC', async () => {
    mocks.rpc.mockResolvedValue({ ok: true, data: receipt });
    await requestDotMemoryMove('workspace', 'prepare', { ...intent, userId: 'foreign', owner: 'foreign', bank: 'foreign', value: 'must-not-send' } as any);
    expect(mocks.rpc).toHaveBeenLastCalledWith('workspace', 'testloop-dot-memory-move', { schemaVersion: 1, action: 'prepare', ...intent });
    await requestDotMemoryMove('workspace', 'status', intent);
    expect(mocks.rpc).toHaveBeenLastCalledWith('workspace', 'testloop-dot-memory-move', { schemaVersion: 1, action: 'status', dotId, requestID });
    await expect(requestDotMemoryMove('workspace', 'move', intent)).rejects.toThrow('memory_move_invalid_request');
});

it('rejects foreign source snapshots, scopes, CAS metadata and IDs on mutations/status', async () => {
    for (const foreign of [{ dotId: requestID }, { sourceScope: 'user' }, { targetScope: 'dot' }, { sourceRevision: 5 },
        { keyDigest: 'sha256:' + 'a'.repeat(64) }, { targetExpectedRevision: 2 }, { requestID: dotId }, { status: 'atomic_success' }]) {
        mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, ...foreign } });
        await expect(requestDotMemoryMove('workspace', 'move', { ...intent, targetRevision: 0 })).rejects.toThrow('memory_move_invalid_response');
    }
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, requestID: dotId } });
    await expect(requestDotMemoryMove('workspace', 'status', intent)).rejects.toThrow('memory_move_invalid_response');
});

it('accepts a host-discovered unfinished revision only for the same source key and never a newer source revision', async () => {
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, requestID: dotId } });
    expect((await requestDotMemoryMove('workspace', 'prepare', intent)).requestID).toBe(dotId);
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, requestID: dotId, sourceRevision: 3, status: 'needs_attention' } });
    expect((await requestDotMemoryMove('workspace', 'prepare', intent)).sourceRevision).toBe(3);
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, requestID: dotId, sourceRevision: 5 } });
    await expect(requestDotMemoryMove('workspace', 'prepare', intent)).rejects.toThrow('memory_move_invalid_response');
});

it('persists opaque requests by local identity scope and preserves them until explicitly resolved', () => {
    saveDotMemoryMove('account-A/relay/dot', { ...intent, targetRevision: 0 });
    expect(loadDotMemoryMoves('account-A/relay/dot')).toEqual([{ ...intent, targetRevision: 0 }]);
    expect(loadDotMemoryMoves('account-B/relay/dot')).toEqual([]);
    saveDotMemoryMove('account-A/relay/dot', { ...intent, targetRevision: 3 });
    expect(loadDotMemoryMoves('account-A/relay/dot')).toHaveLength(1);
    clearDotMemoryMove('account-B/relay/dot', requestID);
    expect(loadDotMemoryMoves('account-A/relay/dot')).toHaveLength(1);
    clearDotMemoryMove('account-A/relay/dot', requestID);
    expect(loadDotMemoryMoves('account-A/relay/dot')).toEqual([]);
    mocks.pending.set('broken', 'invalid-json');
    expect(() => loadDotMemoryMoves('broken')).toThrow('memory_move_local_recovery_invalid');
});

it('does not turn transport uncertainty or partial progress into success', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('timeout'));
    await expect(requestDotMemoryMove('workspace', 'move', { ...intent, targetRevision: 0 })).rejects.toThrow('memory_move_transport_unconfirmed');
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'memory_move_target_conflict' });
    await expect(requestDotMemoryMove('workspace', 'prepare', intent)).rejects.toThrow('memory_move_target_conflict');
    expect(dotMemoryMoveNotice({ ...receipt, status: 'target_saved' } as any)).toContain('移动未完成');
    expect(dotMemoryMoveNotice({ ...receipt, status: 'needs_attention' } as any)).toContain('尚不能确认完成');
});
