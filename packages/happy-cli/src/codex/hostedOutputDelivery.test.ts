import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope } from '@slopus/happy-wire';
import { HostedOutputDelivery } from './hostedOutputDelivery';
const row = (n: number, item = 'item', epoch = 0, snapshot = false) => ({ localId: `hosted:${epoch}:${item}:${n}`, sent: false,
    envelope: createEnvelope('agent', { t: 'text', text: n % 2 ? '文' : '🙂', textOffset: n, ...(snapshot ? { textSnapshot: true } : {}) },
        { id: `${item}:${n}`, turn: 'turn', codexItemId: item }) });
afterEach(() => vi.useRealTimers());
it('never sends before durable notification; sends the first segment immediately, later segments within 20ms', async () => {
    vi.useFakeTimers(); const rows = [row(0)], send = vi.fn(async (batch: any[]) => batch.map(row => row.localId));
    const persist = vi.fn(), delivery = new HostedOutputDelivery(rows, send, persist);
    expect(send).not.toHaveBeenCalled(); delivery.durable(); await delivery.flush();
    expect(send).toHaveBeenCalledTimes(1);
    rows.push(row(1), row(2)); delivery.durable();
    await vi.advanceTimersByTimeAsync(19); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toHaveLength(2); expect(persist).toHaveBeenCalledTimes(2);
    await delivery.close();
});
it('bounds batches to 50 and 64KiB, isolates item/epoch/snapshot/tool/terminal boundaries and preserves exact envelopes', async () => {
    const rows = Array.from({ length: 120 }, (_, n) => row(n));
    rows.push(row(120, 'other'), row(121, 'other', 1), row(122, 'other', 1, true));
    rows.push({ ...row(123), envelope: createEnvelope('agent', { t: 'service', text: 'boundary' }) });
    const original = rows.map(r => JSON.stringify(r.envelope));
    const send = vi.fn(async (batch: any[]) => batch.map(row => row.localId));
    const delivery = new HostedOutputDelivery(rows, send, () => {});
    delivery.durable(); await delivery.flush();
    expect(send.mock.calls.map(c => c[0].length)).toEqual([50, 50, 20, 1, 1, 1, 1]);
    expect(send.mock.calls.flatMap(c => c[0]).map(r => JSON.stringify(r.envelope))).toEqual(original);
    expect(rows.every(r => r.sent)).toBe(true); await delivery.close();
});
it('persists only verified partial ACKs, retries unknown IDs unchanged and serializes reentrant flushes', async () => {
    const rows = [row(0), row(1), row(2)]; let finish!: (ids: string[]) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
        .mockImplementation(async (batch: any[]) => batch.map(row => row.localId));
    const persist = vi.fn(), delivery = new HostedOutputDelivery(rows, send, persist);
    delivery.durable(); const a = delivery.flush(), b = delivery.flush(); expect(a).toBe(b);
    finish([rows[0].localId, rows[2].localId]); await expect(a).rejects.toThrow('hosted_output_unconfirmed');
    expect(rows.map(r => r.sent)).toEqual([true, false, true]); expect(persist).toHaveBeenCalledTimes(1);
    await delivery.flush(); expect(send.mock.calls[1][0].map((r: any) => r.localId)).toEqual([rows[1].localId]);
    expect(persist).toHaveBeenCalledTimes(2); await delivery.close();
});
it('keeps rows recoverable on unknown POST, respects the durable frontier and sends arrivals during an active flush', async () => {
    const rows = [row(0)]; let finish!: (ids: string[]) => void;
    const send = vi.fn().mockRejectedValueOnce(Error('POST result unknown'))
        .mockImplementationOnce(() => new Promise<string[]>(resolve => { finish = resolve; }))
        .mockImplementation(async (batch: any[]) => batch.map(r => r.localId));
    const delivery = new HostedOutputDelivery(rows, send, () => {});
    delivery.durable(); await expect(delivery.flush()).rejects.toThrow('POST result unknown'); expect(rows[0].sent).toBe(false);
    const retry = delivery.flush(); rows.push(row(1)); // Not durable yet.
    finish([rows[0].localId]); await retry; expect(send).toHaveBeenCalledTimes(2);
    delivery.durable(); await delivery.flush(); expect(send).toHaveBeenCalledTimes(3);
    await delivery.close();
});
it('flushes final tails immediately and an ACK persistence failure is not forgotten', async () => {
    vi.useFakeTimers(); const rows = [row(0)], send = vi.fn(async (batch: any[]) => batch.map(r => r.localId));
    const persist = vi.fn(), delivery = new HostedOutputDelivery(rows, send, persist);
    delivery.durable(); await delivery.flush(); rows.push(row(1)); delivery.durable();
    rows.push(row(2, 'item', 0, true)); delivery.durable(); await delivery.flush();
    expect(rows.every(r => r.sent)).toBe(true); expect(send).toHaveBeenCalledTimes(3); await delivery.close();
    const fresh = [row(0)], failed = new HostedOutputDelivery(fresh, send, () => { throw Error('disk failed'); });
    failed.durable(); await expect(failed.flush()).rejects.toThrow('disk failed');
    // The runtime fail-stops; the disk still contains sent=false and restart uses the same localId.
    expect(failed.stats.verified).toBe(1); await failed.close();
});
it('waits for a joined ACK transaction before advancing the delivery queue', async () => {
    const rows = [row(0), row(1, 'next')]; let commit!: () => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { commit = resolve; })).mockResolvedValue(undefined);
    const send = vi.fn(async (batch: any[]) => batch.map(r => r.localId));
    const delivery = new HostedOutputDelivery(rows, send, persist);
    delivery.durable(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1); expect(rows[1].sent).toBe(false);
    commit(); await delivery.flush(); expect(send).toHaveBeenCalledTimes(2);
    await delivery.close();
});
it('sends an oversized indivisible snapshot alone without rewriting its ID or combining it with the next row', async () => {
    const snapshot = row(0, 'large', 0, true);
    if (snapshot.envelope.ev.t !== 'text') throw Error('fixture must be text');
    snapshot.envelope.ev.text = '文'.repeat(30000);
    const rows = [snapshot, row(1, 'next')];
    const send = vi.fn(async (batch: any[]) => batch.map(r => r.localId)), delivery = new HostedOutputDelivery(rows, send, () => {});
    delivery.durable(); await delivery.flush();
    expect(send.mock.calls.map(call => call[0].length)).toEqual([1, 1]);
    expect(send.mock.calls[0][0][0]).toEqual({ envelope: snapshot.envelope, localId: snapshot.localId });
    await delivery.close();
});
