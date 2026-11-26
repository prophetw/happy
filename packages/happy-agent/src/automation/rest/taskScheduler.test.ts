import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskQueue } from './taskQueue';
import { TaskScheduler, type Observation } from './taskScheduler';
import { ApiError } from './schema';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'happy-partial-scheduler-'));
    roots.push(root);
    const queue = new TaskQueue(root, {}, { machineID: 'machine' });
    queue.enqueue({ requestID: 'send', grantID: 'grant', workerID: 'worker', sessionID: 'session', authorization: '', text: 'fixture', resources: [{ key: 'machine', mode: 'shared' }] });
    let observation: Observation = { process: 'running', cursor: 0, outcome: 'running' };
    let sends = 0, stops = 0;
    const scheduler = new TaskScheduler(queue, {
        authorize: async () => {},
        observe: async () => observation,
        send: async () => { sends++; return { seq: 1, id: 'message' }; },
        stop: async () => { stops++; },
    }, 'worker');
    return {
        queue, scheduler,
        observe: (value: Observation) => { observation = value; },
        counts: () => ({ sends, stops }),
    };
}

it('closes a partial turn without stopping or replaying the persistent CodeBuddy process', async () => {
    const f = fixture();
    await f.scheduler.tick();
    expect(f.queue.tasks()[0]).toMatchObject({ state: 'running', dispatched: true });
    f.observe({ process: 'running', cursor: 2, outcome: 'partial', externalRunning: false });
    await f.scheduler.tick();
    expect(f.queue.tasks()[0]).toMatchObject({ state: 'failed', reason: 'partial_success', dispatched: true });
    expect(f.queue.tasks()[0].finishedAt).toEqual(expect.any(Number));
    expect(f.counts()).toEqual({ sends: 1, stops: 0 });
    expect(f.scheduler.reconcile()).toHaveLength(0);
});

it('preserves process-exit confirmation for an explicit failed turn', async () => {
    const f = fixture();
    await f.scheduler.tick();
    f.observe({ process: 'running', cursor: 2, outcome: 'failed', externalRunning: false });
    await f.scheduler.tick();
    expect(f.queue.tasks()[0]).toMatchObject({ state: 'blocked', reason: 'turn_ended_process_unconfirmed' });
    expect(f.counts()).toEqual({ sends: 1, stops: 0 });
});

it('does not abandon a send when a later claim and the send receipt update both fail', async () => {
    const f = fixture();
    const unavailable = new ApiError('QUEUE_CORRUPT', 503);
    const claim = f.queue.claim.bind(f.queue);
    vi.spyOn(f.queue, 'claim').mockImplementationOnce(claim).mockImplementationOnce(() => { throw unavailable; });
    vi.spyOn(f.queue, 'update').mockImplementation(() => { throw unavailable; });

    expect(() => f.scheduler.dispatch()).toThrow(unavailable);
    // The failed dispatch never returns the launched promise to its caller.
    // Allow the event loop to observe an unhandled rejection before draining it.
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.scheduler.drain();

    expect(f.queue.tasks()[0]).toMatchObject({ state: 'preparing', dispatched: true });
    expect(f.counts()).toEqual({ sends: 1, stops: 0 });
});
