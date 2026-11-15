import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
import { ObservationMemoriesSchema, ObservationResponseSchema, ObservationSelectionSchema, observationError, observationReasons, requestDotObservation } from './dotObservation';

const dotId = '22222222-2222-4222-8222-222222222222', turnId = '33333333-3333-4333-8333-333333333333';
const hash = 'sha256:' + 'a'.repeat(64);
const base = { schemaVersion: 1, dotId, snapshotId: hash, asOf: '2026-11-05T00:00:00Z' };
describe('Dot observation protocol', () => {
    it.each([1, 2, 3])('reads memory selection policy %i without losing the recorded reason', async version => {
        const reason = version === 3 ? 'unrelated' : 'entry_limit';
        mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...base, action: 'turn', section: 'selection', turnId,
            available: true, policy: { version, asOf: base.asOf, enabled: true, maxEntries: 10, maxBytes: 8192 },
            page: { items: [{ keyDigest: hash, key: '饮食偏好', revision: 1, reason }], total: 1, offset: 0, nextOffset: null } } });
        const result = await requestDotObservation('workspace', { dotId, action: 'turn', turnId, section: 'selection' }, ObservationSelectionSchema);
        expect(result.policy?.version).toBe(version);
        expect(result.page.items[0].reason).toBe(reason);
        if (version === 3) expect(observationReasons[result.page.items[0].reason]).toBe('与本轮问题无关');
    });
    it('continues rejecting unknown memory selection reasons', () => {
        expect(ObservationSelectionSchema.safeParse({ ...base, action: 'turn', section: 'selection', turnId,
            available: true, policy: null, page: { items: [{ keyDigest: hash, key: null, revision: 1, reason: 'unknown_reason' }],
                total: 1, offset: 0, nextOffset: null } }).success).toBe(false);
    });
    it('uses the encrypted read-only RPC and retains pagination identity', async () => {
        mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...base, action: 'memories', page: { items: [], total: 0, offset: 10, nextOffset: null } } });
        const result = await requestDotObservation('workspace', { dotId, action: 'memories', offset: 10, snapshotId: hash }, ObservationMemoriesSchema);
        expect(mocks.rpc).toHaveBeenLastCalledWith('workspace', 'testloop-dot-observation', { schemaVersion: 1, dotId, action: 'memories', offset: 10, snapshotId: hash });
        expect(result.page.total).toBe(0);
    });
    it('rejects malformed and foreign-Dot results', async () => {
        for (const data of [{ ...base, action: 'memories', page: null }, { ...base, dotId: turnId, action: 'memories', page: { items: [], total: 0, offset: 0, nextOffset: null } }]) {
            mocks.rpc.mockResolvedValueOnce({ ok: true, data });
            await expect(requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema)).rejects.toThrow('observation_invalid_response');
        }
    });
    it('rejects a reply for another turn or section even when its data is otherwise valid', async () => {
        const data = { ...base, action: 'turn', section: 'selection', turnId, available: false, policy: null,
            page: { items: [], total: 0, offset: 0, nextOffset: null } };
        mocks.rpc.mockResolvedValueOnce({ ok: true, data });
        await expect(requestDotObservation('workspace', { dotId, action: 'turn', turnId: dotId, section: 'selection' }, ObservationSelectionSchema)).rejects.toThrow('observation_invalid_response');
        mocks.rpc.mockResolvedValueOnce({ ok: true, data });
        await expect(requestDotObservation('workspace', { dotId, action: 'turn', turnId, section: 'memory' }, ObservationResponseSchema)).rejects.toThrow('observation_invalid_response');
    });
    it('reports changing data and disconnected/older hosts without claiming an empty directory', async () => {
        mocks.rpc.mockResolvedValueOnce({ ok: false, error: 'observation_snapshot_changed' });
        await expect(requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema)).rejects.toThrow('observation_snapshot_changed');
        mocks.rpc.mockRejectedValueOnce(new Error('RPC method unavailable'));
        await expect(requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema)).rejects.toThrow('observation_transport_unconfirmed');
        expect(observationError(new Error('observation_transport_unconfirmed'))).toContain('宿主是否支持观察台');
    });
    it('limits UI waiting to ten seconds without accepting a late RPC result', async () => {
        vi.useFakeTimers();
        try {
            let resolve!: (value: unknown) => void;
            mocks.rpc.mockReturnValueOnce(new Promise(value => { resolve = value; }));
            const request = requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema);
            const rejected = expect(request).rejects.toThrow('observation_timeout');
            await vi.advanceTimersByTimeAsync(9999);
            expect(vi.getTimerCount()).toBe(1);
            await vi.advanceTimersByTimeAsync(1);
            await rejected;
            resolve({ ok: true, data: { ...base, action: 'memories', page: { items: [], total: 0, offset: 0, nextOffset: null } } });
            await Promise.resolve();
            expect(vi.getTimerCount()).toBe(0);
            expect(observationError(new Error('observation_timeout'))).toContain('超时');
        } finally { vi.useRealTimers(); }
    });
    it.each(['resolve', 'reject'])('clears the observation deadline after RPC %s', async outcome => {
        vi.useFakeTimers();
        try {
            if (outcome === 'resolve') {
                mocks.rpc.mockResolvedValueOnce({ ok: true, data: { ...base, action: 'memories', page: { items: [], total: 0, offset: 0, nextOffset: null } } });
                await requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema);
            } else {
                mocks.rpc.mockRejectedValueOnce(new Error('offline'));
                await expect(requestDotObservation('workspace', { dotId, action: 'memories' }, ObservationMemoriesSchema)).rejects.toThrow('observation_transport_unconfirmed');
            }
            expect(vi.getTimerCount()).toBe(0);
        } finally { vi.useRealTimers(); }
    });
    it('decodes the actual host fixture when supplied by the backend integration run', () => {
        const file = process.env.TESTLOOP_DOT_OBSERVATION_FIXTURE;
        if (!file) return;
        const rows = JSON.parse(readFileSync(file, 'utf8'));
        expect(rows.length).toBeGreaterThan(8);
        for (const row of rows) expect(ObservationResponseSchema.safeParse(row).success, `${row.action}/${row.section ?? ''}`).toBe(true);
    });
});
