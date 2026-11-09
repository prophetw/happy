import { TaskQueue, occupiesSlot, terminalTask, type QueueTask } from './taskQueue';
import { ApiError } from './schema';

export type Observation = { resultCommit?: string; worktreeDirty?: boolean; pendingInput?: boolean; process: string; cursor: number; seq?: number; messageID?: string; turnID?: string;
    outcome?: 'running' | 'completed' | 'failed' | 'cancelled'; externalRunning?: boolean };
export type QueueExecutor = {
    authorize: (task: QueueTask) => Promise<void>;
    observe: (task: QueueTask) => Promise<Observation>;
    send: (task: QueueTask) => Promise<{ seq: number; id: string }>;
    stop: (task: QueueTask) => Promise<void>;
    stopped?: (task: QueueTask) => Promise<boolean>;
};
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const revoked = (e: unknown) => e instanceof ApiError && ['GRANT_REVOKED', 'GRANT_EXPIRED', 'GRANT_NOT_APPROVED', 'SCOPE_DENIED', 'PROJECT_BINDING_CHANGED', 'PROJECT_PATH_CHANGED', 'OPTION_DENIED', 'WORKTREE_BINDING_CHANGED'].includes(e.code);

/** Scheduler death never makes an uncertain mutation eligible for replay. */
export class TaskScheduler {
    private ticking = false;
    constructor(readonly queue: TaskQueue, private executor: QueueExecutor, private workerID?: string) {}
    async tick() {
        if (this.ticking) return;
        this.ticking = true;
        try {
            if(this.workerID)this.queue.noteScheduler(this.workerID);
            for (const task of this.queue.tasks().filter(t => occupiesSlot(t) && (!this.workerID || t.workerID === this.workerID))) {
                // A different live dispatcher may be between its durable claim and send.
                if (task.state === 'preparing' && alive(task.ownerPID)) continue;
                if (!task.dispatched && task.state !== 'canceling') {
                    this.queue.update(task.id, t => { if (!t.dispatched && t.state === 'preparing') { t.state = 'queued'; t.reason = 'dispatcher_recovered'; } }); continue;
                }
                try {
                    const observation = await this.executor.observe(task);
                    this.queue.update(task.id, current => {
                        if (terminalTask(current)) return;
                        current.resultCommit = observation.resultCommit; current.worktreeDirty = observation.worktreeDirty;
                        current.cursor = observation.cursor;
                        current.seq ??= observation.seq; current.messageID ??= observation.messageID; current.turnID ??= observation.turnID;
                        // Cancellation requires exit evidence, not an old turn-end event.
                        if (current.state === 'canceling') {
                            if (observation.process === 'stopped') { current.state = 'cancelled'; current.finishedAt = Date.now(); }
                        } else if (observation.outcome && observation.outcome !== 'running' && !observation.externalRunning) {
                            if (observation.outcome !== 'completed' && observation.process !== 'stopped') { current.state = 'blocked'; current.reason = 'turn_ended_process_unconfirmed'; }
                            else { current.state = observation.outcome; current.finishedAt = Date.now(); current.reason = undefined; }
                        } else if (observation.externalRunning && !current.legacy) {
                            current.state = 'blocked'; current.reason = 'external_turn_running';
                        } else if (observation.process === 'stopped') {
                            current.state = 'failed'; current.reason = 'process_stopped_without_result'; current.finishedAt = Date.now();
                        } else if (current.seq !== undefined || current.legacy && (observation.outcome === 'running' || observation.pendingInput)) { current.state = 'running'; current.reason = undefined; }
                        else { current.state = 'blocked'; current.reason = 'dispatch_receipt_unknown'; }
                    });
                    const current = this.queue.tasks().find(t => t.id === task.id)!;
                    if (current.state === 'canceling' && observation.process !== 'stopped') await this.executor.stop(current);
                } catch (e) {
                    // The local process owner may still attest exit after grant revocation; it
                    // does not disclose content or regain dispatch authority.
                    let stopped = false; try { stopped = await this.executor.stopped?.(task) ?? false; } catch { /* Unknown keeps the lease. */ }
                    this.queue.update(task.id, t => { if (terminalTask(t)) return; if (stopped) { t.state = t.state === 'canceling' ? 'cancelled' : 'failed'; t.finishedAt = Date.now(); t.reason = 'execution_stopped'; } else t.reason = revoked(e) ? 'authorization_revoked_execution_unconfirmed' : 'observation_unavailable'; });
                }
            }
            // Ledger capacity bounds a tick; an absent machine ceiling must not impose 2/4.
            for (let n = 0; n < 1000; n++) {
                const task = this.queue.claim(this.workerID); if (!task) break;
                try {
                    await this.executor.authorize(task);
                    const before = await this.executor.observe(task);
                    if (before.process === 'stopped') { this.queue.update(task.id,t=>{if(t.state==='preparing'){t.state='failed';t.reason='session_stopped';t.finishedAt=Date.now();}});continue; }
                    if (before.externalRunning || before.process !== 'running') {
                        this.queue.update(task.id, t => { if (t.state === 'preparing') { t.state = 'waiting-resource'; t.reason = before.externalRunning ? 'session_turn' : 'session_process_unknown'; t.notBefore=Date.now()+1000; } }); continue;
                    }
                    // Durable point of no automatic replay, before invoking the transport.
                    const dispatch = this.queue.update(task.id, t => { if (t.state === 'preparing') t.dispatched = true; });
                    if (dispatch.state !== 'preparing') continue;
                    const sent = await this.executor.send(dispatch);
                    this.queue.update(task.id, t => { t.seq = sent.seq; t.messageID = sent.id; if (t.state === 'preparing') t.state = 'running'; });
                } catch (e) {
                    this.queue.update(task.id, t => {
                        if (terminalTask(t) || t.state === 'canceling') return;
                        if (!t.dispatched && revoked(e)) { t.state = 'failed'; t.reason = 'authorization_revoked'; t.finishedAt = Date.now(); }
                        else if (!t.dispatched) { const dirty=e instanceof ApiError && e.code==='INTEGRATION_WORKTREE_DIRTY'; t.state = dirty?'waiting-resource':'queued'; t.reason = dirty?'integration_worktree_dirty':'execution_unavailable'; t.notBefore=Date.now()+3000; }
                        else { t.state = 'blocked'; t.reason = 'dispatch_receipt_unknown'; }
                    });
                }
            }
        } finally { this.ticking = false; }
    }
    async cancel(grantID: string, sessionID: string, mutationID: string, requestID?: string) {
        const tasks = this.queue.cancel(grantID, sessionID, mutationID, requestID);
        for (const task of tasks.filter(t => t.state === 'canceling')) { try { await this.executor.stop(task); } catch { /* Keep intent and locks until independent exit evidence. */ } }
        return tasks;
    }
}
