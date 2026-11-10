import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTTPWorkerRunner, ScopedWorker } from './worker';
import { ApiError, type WorkerRegistration } from './schema';
import type { DecryptedSession } from '../../api';
import type { MessagePage, Transport } from '../relay';

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'happy-worker-efficiency-')); roots.push(root);
    const registration: WorkerRegistration = { id: 'worker', userID: 'owner', name: 'Fixture', publicKey: 'fixture', machineID: 'machine', projects: [], methods: [], protocol: 1 };
    const sessions: DecryptedSession[] = [];
    const histories = new Map<string, MessagePage['messages']>();
    const transport: Transport = {
        machines: vi.fn(async () => [{ id: 'machine' }] as any),
        sessions: vi.fn(async () => ({ sessions, nextCursor: null })),
        messages: vi.fn(async (session, cursor, limit) => {
            const tail = (histories.get(session.id) ?? []).filter(message => message.seq > cursor);
            return { messages: tail.slice(0, limit), hasMore: tail.length > limit };
        }),
        rpc: vi.fn(async () => ({ version: 1, process: 'stopped' })),
        send: vi.fn(async () => { throw Error('unexpected_send'); }),
    };
    const worker = () => new ScopedWorker(registration, transport, join(root, 'worker'), async () => { throw Error('unexpected_authorization'); }, Date.now, undefined, undefined, join(root, 'queue'));
    const session = (id: string) => { const value = { id, seq: 1000, metadata: { machineId: 'machine', path: root, hostPid: 99999999 } } as DecryptedSession; sessions.push(value); histories.set(id, []); return value; };
    return { root, registration, transport, sessions, histories, worker, session };
}
const text = (seq: number) => ({ id: 'm' + seq, seq, localId: null, content: { role: 'user', content: { type: 'text', text: 'fixture' } } });
const input = (seq: number) => ({ ...text(seq), localId: 'automation:input-' + seq });
const turn = (seq: number, id: string, status?: 'completed' | 'failed') => ({ id: 'm' + seq, seq, localId: null,
    content: { role: 'session', content: { role: 'agent', turn: id, ev: status ? { t: 'turn-end', status } : { t: 'turn-start' } } } });

it('lists idle sessions once per page and reads the adoption queue once instead of once per session', async () => {
    const f = fixture(); for (let n = 0; n < 24; n++) f.session('session-' + n);
    const worker = f.worker(), reads = vi.spyOn(worker.queue, 'tasks');
    await worker.tick();
    expect(f.transport.sessions).toHaveBeenCalledTimes(1);
    // Upgrade snapshot, adoption snapshot, scheduler observation snapshot.
    expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(f.transport.send).not.toHaveBeenCalled();
});

it('consumes only the new tail after a multi-page history and reconstructs it after restart', async () => {
    const f = fixture(), session = f.session('history');
    f.histories.set(session.id, [...Array.from({ length: 250 }, (_, n) => text(n + 1)), input(251), turn(252, 'first'), turn(253, 'first', 'completed')]);
    const worker = f.worker(); await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([0, 100, 200]);
    vi.mocked(f.transport.messages).mockClear();
    await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([253]);
    f.histories.get(session.id)!.push(input(254), turn(255, 'second'));
    vi.mocked(f.transport.messages).mockClear(); await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([253]);
    vi.mocked(f.transport.messages).mockClear(); await f.worker().tick();
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([0, 100, 200]);
    expect(f.transport.send).not.toHaveBeenCalled();
});

it('does not commit a partial history when a later page fails', async () => {
    const f = fixture(), session = f.session('partial');
    f.histories.set(session.id, Array.from({ length: 150 }, (_, n) => text(n + 1)));
    const worker = f.worker(), read = vi.mocked(f.transport.messages).getMockImplementation()!;
    vi.mocked(f.transport.messages).mockImplementationOnce(read).mockRejectedValueOnce(Error('temporary_failure'));
    await expect(worker.tick()).rejects.toThrow('temporary_failure');
    vi.mocked(f.transport.messages).mockClear(); await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([0, 100]);
});

it('rebuilds the observation if session ownership metadata changes or the stream sequence regresses', async () => {
    const f = fixture(), session = f.session('rebound'); f.histories.set(session.id, [text(1)]);
    const worker = f.worker(); await worker.tick();
    (session.metadata as any).hostPid++;
    vi.mocked(f.transport.messages).mockClear(); await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls[0][1]).toBe(0);
    session.seq = 0;
    vi.mocked(f.transport.messages).mockClear(); await worker.tick();
    expect(vi.mocked(f.transport.messages).mock.calls[0][1]).toBe(0);
});

it('preserves a terminal turn across an empty incremental read and still checks process status each time', async () => {
    const f = fixture(), session = f.session('running-legacy'), worker = f.worker();
    vi.mocked(f.transport.rpc).mockResolvedValue({ version: 1, process: 'unknown' });
    f.histories.set(session.id, [input(1), turn(2, 'first')]);
    const task = worker.queue.adoptLegacy({ requestID: 'legacy-first', workerID: 'worker', grantID: 'legacy-import', sessionID: session.id,
        authorization: '', text: '', resources: [{ key: 'machine', mode: 'exclusive' }], legacy: true, seq: 1, turnID: 'first', processID: 99999999 });
    await worker.tick(); expect(worker.queue.tasks().find(value => value.id === task.id)?.state).toBe('running');
    f.histories.get(session.id)!.push(...Array.from({ length: 150 }, (_, n) => text(n + 3)), turn(153, 'first', 'completed'));
    vi.mocked(f.transport.messages).mockClear();
    await worker.tick();
    expect(worker.queue.tasks().find(value => value.id === task.id)?.state).toBe('completed');
    expect(vi.mocked(f.transport.messages).mock.calls.map(call => call[1])).toEqual([2, 102, 153]);
    expect(f.transport.rpc).toHaveBeenCalledTimes(4);
    expect(f.transport.send).not.toHaveBeenCalled();
});

it('does not attribute a new pending input to the cached completed turn or dispatch it again', async () => {
    const f = fixture(), session = f.session('followup'), worker = f.worker();
    vi.mocked(f.transport.rpc).mockResolvedValue({ version: 1, process: 'unknown' });
    f.histories.set(session.id, [input(1), turn(2, 'first'), turn(3, 'first', 'completed')]);
    await worker.tick(); expect(worker.queue.tasks()).toHaveLength(0);
    f.histories.get(session.id)!.push(input(4));
    await worker.tick();
    const [task] = worker.queue.tasks();
    expect(task.seq).toBe(4); expect(task.turnID).toBeUndefined(); expect(task.state).toBe('running');
    expect(task.resources).toEqual([{ key: 'machine', mode: 'exclusive' }]);
    f.histories.get(session.id)!.push(turn(5, 'second'), turn(6, 'second', 'completed'));
    await worker.tick();
    expect(worker.queue.tasks().find(value => value.id === task.id)?.state).toBe('completed');
    expect(f.transport.send).not.toHaveBeenCalled();
});

function runnerFixture() {
    const f = fixture();
    const request = vi.fn(async (_method: string, path: string) => ({ ok: true, data: path === '/compatibility' ? { projectScopes: 1 } : null }));
    const runner = new HTTPWorkerRunner({ request } as any, f.registration, f.transport, join(f.root, 'worker'), Date.now, undefined, join(f.root, 'queue'));
    const tick = vi.spyOn(runner.worker, 'tick').mockResolvedValue();
    const controller = new AbortController(), events: { state: string; code?: string }[] = [];
    const running = runner.run(controller.signal, 250, event => { events.push(event); });
    return { ...f, runner, request, tick, events, stop: async () => { controller.abort(); await running; } };
}

it('keeps polling frequently but reports a steady connection only at startup and every 30 seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = runnerFixture();
    try {
        await vi.advanceTimersByTimeAsync(29_750);
        expect(f.events).toEqual([{ state: 'connected' }]);
        expect(f.request.mock.calls.filter(call => call[1] === '/worker/poll').length).toBeGreaterThan(100);
        await vi.advanceTimersByTimeAsync(250);
        expect(f.events).toEqual([{ state: 'connected' }, { state: 'connected' }]);
    } finally { await f.stop(); }
});

it('retains scheduler failure across healthy polls and reports recovery only after a successful tick', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = runnerFixture(); f.tick.mockRejectedValue(new ApiError('QUEUE_UNAVAILABLE', 503));
    try {
        await vi.advanceTimersByTimeAsync(2250);
        expect(f.events.at(-1)).toEqual({ state: 'unavailable', code: 'QUEUE_UNAVAILABLE' });
        const count = f.events.length;
        await vi.advanceTimersByTimeAsync(500);
        expect(f.events).toHaveLength(count);
        f.tick.mockResolvedValue(); await vi.advanceTimersByTimeAsync(500);
        expect(f.events.at(-1)).toEqual({ state: 'connected' });
    } finally { await f.stop(); }
});

it('reports changed channel failures and recovery immediately and survives a throwing logger', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = runnerFixture();
    try {
        await vi.advanceTimersByTimeAsync(0);
        f.request.mockRejectedValue(new ApiError('FIRST_FAILURE', 503)); await vi.advanceTimersByTimeAsync(250);
        expect(f.events.at(-1)).toEqual({ state: 'unavailable', code: 'FIRST_FAILURE' });
        f.request.mockRejectedValue(new ApiError('SECOND_FAILURE', 503)); await vi.advanceTimersByTimeAsync(250);
        expect(f.events.at(-1)).toEqual({ state: 'unavailable', code: 'SECOND_FAILURE' });
        f.request.mockResolvedValue({ ok: true, data: null }); await vi.advanceTimersByTimeAsync(250);
        expect(f.events.at(-1)).toEqual({ state: 'connected' });
    } finally { await f.stop(); }
    const controller = new AbortController();
    const running = f.runner.run(controller.signal, 250, () => { throw Error('logger_failed'); });
    await vi.advanceTimersByTimeAsync(500); controller.abort(); await running;
});
