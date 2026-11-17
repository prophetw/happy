import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('expo-crypto', async () => {
    const { createHash } = await import('node:crypto');
    return { CryptoDigestAlgorithm: { SHA256: 'SHA-256' }, digest: async (_algorithm: string, data: Uint8Array) => {
        const hash = createHash('sha256').update(data).digest();
        return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
    } };
});
import { dotMemoryValueBytes, readDotMemoryTombstone, requestDotMemoryEdit } from './dotMemoryEdit';
import { ObservationMemorySchema } from './dotObservation';

const workspaceId = '11111111-1111-4111-8111-111111111111', dotId = '22222222-2222-4222-8222-222222222222';
const requestID = '44444444-4444-4444-8444-444444444444';
const request = { schemaVersion: 1 as const, workspaceId, dotId, dotSessionId: 'dot-session', scope: 'user' as const, requestID,
    operation: { action: 'remember' as const, key: '交付时间', kind: 'fact' as const, value: '每周三', revision: 2, expiresAt: null } };
const receipt = { schemaVersion: 1, workspaceId, dotId, dotSessionId: 'dot-session', scope: 'user', requestID,
    action: 'remember', keyDigest: 'sha256:' + 'a'.repeat(64), revision: 3, currentRevision: 3, currentStatus: 'active', duplicate: false, indexing: 'pending' };
const languageDigest = 'sha256:e52972a539159f336ca067533cd8c5e198752aa7eeccbff26a31889dabb0b8ec';
const observationMemory = (status: 'effective' | 'deleted', revision: number) => ({ schemaVersion: 1, dotId,
    asOf: '2026-11-17T00:00:00Z', snapshotId: 'sha256:' + 'a'.repeat(64), action: 'memory', section: 'versions', scope: 'user',
    memory: { keyDigest: languageDigest, key: status === 'effective' ? '语言' : null, status, revision,
        deletedAt: status === 'deleted' ? '2026-11-17T00:00:00Z' : null },
    page: { items: [], total: 0, offset: 0, nextOffset: null } });
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

it('enforces the host UTF-8 JSON byte limit before transport', async () => {
    expect(dotMemoryValueBytes('中'.repeat(1364))).toBe(4094);
    expect(dotMemoryValueBytes('中'.repeat(1365))).toBe(4097);
    expect(dotMemoryValueBytes('x'.repeat(4094))).toBe(4096);
    expect(dotMemoryValueBytes('x'.repeat(4095))).toBe(4097);
    const overlong = { ...request, operation: { ...request.operation, value: '中'.repeat(1365) } };
    await expect(requestDotMemoryEdit('workspace-session', overlong)).rejects.toThrow('memory_edit_invalid_request');
    expect(mocks.rpc).not.toHaveBeenCalled();
});

it('reads the current tombstone revision through the existing keyed observation RPC', async () => {
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: ObservationMemorySchema.parse(observationMemory('deleted', 3)) });
    await expect(readDotMemoryTombstone('workspace-session', dotId, 'user', '语言')).resolves.toBe(3);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('workspace-session', 'testloop-dot-observation', {
        schemaVersion: 1, dotId, action: 'memory', keyDigest: languageDigest, scope: 'user' });
    mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'observation_memory_not_found' });
    await expect(readDotMemoryTombstone('workspace-session', dotId, 'user', '语言')).resolves.toBeNull();
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: observationMemory('effective', 4) });
    await expect(readDotMemoryTombstone('workspace-session', dotId, 'user', '语言')).resolves.toBeNull();
});

it('trims and NFC-normalizes keys before hashing their canonical JSON string', async () => {
    const keyDigest = 'sha256:f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086';
    const reply = observationMemory('deleted', 2); reply.memory.keyDigest = keyDigest;
    mocks.rpc.mockResolvedValueOnce({ ok: true, data: reply });
    await expect(readDotMemoryTombstone('workspace-session', dotId, 'user', ' é ')).resolves.toBe(2);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('workspace-session', 'testloop-dot-observation', {
        schemaVersion: 1, dotId, action: 'memory', keyDigest, scope: 'user' });
});
