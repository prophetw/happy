import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
import { ObservationMemoriesSchema, ObservationResponseSchema, ObservationSelectionSchema, observationError, requestDotObservation } from './dotObservation';

const dotId = '22222222-2222-4222-8222-222222222222', turnId = '33333333-3333-4333-8333-333333333333';
const hash = 'sha256:' + 'a'.repeat(64);
const base = { schemaVersion: 1, dotId, snapshotId: hash, asOf: '2026-11-05T00:00:00Z' };
describe('Dot observation protocol', () => {
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
    it('decodes the actual host fixture when supplied by the backend integration run', () => {
        const file = process.env.TESTLOOP_DOT_OBSERVATION_FIXTURE;
        if (!file) return;
        const rows = JSON.parse(readFileSync(file, 'utf8'));
        expect(rows.length).toBeGreaterThan(8);
        for (const row of rows) expect(ObservationResponseSchema.safeParse(row).success, `${row.action}/${row.section ?? ''}`).toBe(true);
    });
});
