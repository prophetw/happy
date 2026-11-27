import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HTTPWorkerRunner } from './worker';
import { QueueLedgerError, type WorkerRegistration } from './schema';

// Same-runner regressions for state changes and the bounded readiness heartbeat.
// Every constructor gets its own queue directory; no machine ledger is opened.
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function drive(rounds: { at: number; offline?: boolean; queueError?: QueueLedgerError }[]) {
    const directory = mkdtempSync(join(tmpdir(), 'happy-presence-'));
    directories.push(directory);
    let clock = 0;
    const client = { request: async () => ({ ok: true, data: null }) } as never;
    const registration = { id: 'fixture-worker', machineID: 'fixture-machine', projects: [] } as unknown as WorkerRegistration;
    const transport = { machines: async () => [], sessions: async () => [] } as never;
    const runner = new HTTPWorkerRunner(client, registration, transport, directory, () => clock, undefined, join(directory, 'queue'));
    runner.worker.tick = async () => {
        const error = rounds[round - 1]?.queueError;
        if (error) throw error;
    };
    const controller = new AbortController();
    const events: { state: string; code?: string; at: number }[] = [];
    let round = 0;
    // The final sentinel stops the loop after all measured rounds have reported.
    (runner as unknown as { poll: () => Promise<null> }).poll = async () => {
        const next = rounds[round++];
        if (!next) { controller.abort(); return null; }
        clock = next.at;
        if (next.offline) throw new Error('fixture offline');
        return null;
    };
    await runner.run(controller.signal, 0, event => events.push({ ...event, at: clock }));
    return events;
}

it('reports a steady connection once instead of on every poll', async () => {
    expect(await drive(Array.from({ length: 12 }, (_, i) => ({ at: 1000 + i * 250 }))))
        .toEqual([{ state: 'connected', at: 1000 }]);
});

it('emits the heartbeat on the same runner at the thirty-second boundary', async () => {
    expect(await drive([{ at: 1000 }, { at: 30999 }, { at: 31000 }, { at: 31001 }, { at: 60999 }, { at: 61000 }]))
        .toEqual([{ state: 'connected', at: 1000 }, { state: 'connected', at: 31000 }, { state: 'connected', at: 61000 }]);
});

it('reports a disconnection and recovery immediately without flooding repeated failures', async () => {
    expect(await drive([{ at: 1000 }, { at: 1250, offline: true }, { at: 1500, offline: true }, { at: 1750 }]))
        .toEqual([{ state: 'connected', at: 1000 }, { state: 'unavailable', code: 'WORKER_CHANNEL_UNAVAILABLE', at: 1250 }, { state: 'connected', at: 1750 }]);
});

it('reports the queue verification stage and clears it after a successful tick', async () => {
    expect(await drive([
        { at: 1000 }, { at: 2000, queueError: new QueueLedgerError('utf8', 'QUEUE_WRITE_REJECTED') }, { at: 3000 },
    ])).toEqual([
        { state: 'connected', at: 1000 },
        { state: 'unavailable', code: 'QUEUE_WRITE_REJECTED', queuePhase: 'utf8', at: 2000 },
        { state: 'connected', at: 3000 },
    ]);
});
