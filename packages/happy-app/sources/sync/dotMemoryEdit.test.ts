import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
import { requestDotMemoryEdit } from './dotMemoryEdit';

const workspaceId = '11111111-1111-4111-8111-111111111111', dotId = '22222222-2222-4222-8222-222222222222';
const requestID = '44444444-4444-4444-8444-444444444444';
const request = { schemaVersion: 1 as const, workspaceId, dotId, dotSessionId: 'dot-session', scope: 'user' as const, requestID,
    operation: { action: 'remember' as const, key: '交付时间', kind: 'fact' as const, value: '每周三', revision: 2, expiresAt: null } };
const receipt = { schemaVersion: 1, workspaceId, dotId, dotSessionId: 'dot-session', scope: 'user', requestID,
    action: 'remember', keyDigest: 'sha256:' + 'a'.repeat(64), revision: 3, currentRevision: 3, currentStatus: 'active', duplicate: false, indexing: 'pending' };
beforeEach(() => mocks.rpc.mockReset());
afterEach(() => vi.useRealTimers());

it('saves the exact explicit memory change through the encrypted workspace RPC', async () => {
    mocks.rpc.mockResolvedValue({ ok: true, data: receipt });
    expect(await requestDotMemoryEdit('workspace-session', request)).toEqual(receipt);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('workspace-session', 'testloop-dot-memory-edit', request);
});

it('refuses a receipt for another account binding, request, action or revision', async () => {
    for (const mismatch of [{ workspaceId: dotId }, { dotId: workspaceId }, { dotSessionId: 'other-session' },
        { scope: 'dot' }, { requestID: dotId }, { action: 'forget' }, { revision: 4 }, { currentRevision: 2 }, { currentStatus: 'deleted' }]) {
        mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, ...mismatch } });
        await expect(requestDotMemoryEdit('workspace-session', request)).rejects.toThrow('memory_edit_invalid_response');
    }
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...receipt, duplicate: true, currentRevision: 5, currentStatus: 'deleted' } });
    expect(await requestDotMemoryEdit('workspace-session', request)).toMatchObject({ revision: 3, currentRevision: 5, currentStatus: 'deleted' });
});

it('keeps transport uncertainty distinct from an explicit host rejection', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(requestDotMemoryEdit('workspace-session', request)).rejects.toThrow('memory_edit_transport_unconfirmed');
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'memory_edit_revision_conflict' });
    await expect(requestDotMemoryEdit('workspace-session', request)).rejects.toThrow('memory_edit_revision_conflict');
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'unexpected private details' });
    await expect(requestDotMemoryEdit('workspace-session', request)).rejects.toThrow('memory_edit_invalid_response');
    vi.useFakeTimers();
    mocks.rpc.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(requestDotMemoryEdit('workspace-session', request)).rejects.toThrow('memory_edit_transport_unconfirmed');
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
});
