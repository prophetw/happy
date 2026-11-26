import { TaskQueue, occupiesSlot, terminalTask, type LegacyCheck, type QueueTask } from './taskQueue';
import { ApiError } from './schema';
import type { TestEvidence } from './execution';

export type Observation = { resultCommit?: string; worktreeDirty?: boolean; pendingInput?: boolean; process: string; cursor: number; seq?: number; messageID?: string; turnID?: string;
    sessionOwnerVerified?: boolean; dispatchable?: boolean;
    outcome?: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'; externalRunning?: boolean;
    checkoutDigest?: string; testResult?: TestEvidence; candidateError?: string };
export type QueueExecutor = {
    authorize: (task: QueueTask) => Promise<void>;
    observe: (task: QueueTask) => Promise<Observation>;
    send: (task: QueueTask) => Promise<{ seq: number; id: string }>;
    stop: (task: QueueTask) => Promise<void>;
    stopped?: (task: QueueTask) => Promise<boolean>;
};
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const revoked = (e: unknown) => e instanceof ApiError && ['GRANT_REVOKED', 'GRANT_EXPIRED', 'GRANT_NOT_APPROVED', 'SCOPE_DENIED', 'PROJECT_BINDING_CHANGED', 'PROJECT_PATH_CHANGED', 'OPTION_DENIED', 'WORKTREE_BINDING_CHANGED'].includes(e.code);
export const candidateError = (e: unknown) => e instanceof ApiError && ['CANDIDATE_CHANGED', 'CANDIDATE_UNAVAILABLE'].includes(e.code) ? e.code : undefined;

/** Scheduler death never makes an uncertain mutation eligible for replay. */
export class TaskScheduler {
    private readonly work = new Map<string, Promise<void>>();
    constructor(readonly queue: TaskQueue, private executor: QueueExecutor, private workerID?: string) {}
    private start(task: QueueTask, action: () => Promise<void>) {
        const work = action().finally(() => { this.work.delete(task.id); });
        // A later synchronous queue failure can prevent dispatch/reconcile from
        // returning this promise. Keep its rejection observable by callers that
        // receive it without letting an abandoned flight escape the scheduler.
        void work.catch(() => {});
        this.work.set(task.id, work);
        return work;
    }
    reconcile(tasks = this.queue.tasks()) {
        if (this.workerID) this.queue.noteScheduler(this.workerID);
        const work: Promise<void>[] = [];
        for (const task of tasks) {
            if (!occupiesSlot(task) || this.workerID && task.workerID !== this.workerID || this.work.has(task.id)) continue;
            // A different live dispatcher may be between its durable claim and send.
            if (task.state === 'preparing' && alive(task.ownerPID)) continue;
            if (!task.dispatched && task.state !== 'canceling') {
                this.queue.update(task.id, t => { if (!t.dispatched && t.state === 'preparing') { t.state = 'queued'; t.reason = 'dispatcher_recovered'; } });
                continue;
            }
            work.push(this.start(task, () => this.observe(task)));
        }
        return work;
    }
    private async observe(task: QueueTask) {
        try {
            const observation = await this.executor.observe(task);
            const current = this.queue.update(task.id, current => {
                if (terminalTask(current)) return;
                current.resultCommit = observation.resultCommit; current.worktreeDirty = observation.worktreeDirty;
                current.cursor = observation.cursor;
                current.seq ??= observation.seq; current.messageID ??= observation.messageID; current.turnID ??= observation.turnID;
                // Cancellation requires exit evidence, not an old turn-end event.
                if (current.state === 'canceling') {
                    if (observation.process === 'stopped') { current.state = 'cancelled'; current.finishedAt = Date.now(); }
                } else if (observation.candidateError) {
                    current.state = 'failed'; current.reason = observation.candidateError; current.finishedAt = Date.now();
                } else if (observation.outcome && observation.outcome !== 'running' && !observation.externalRunning) {
                    // Partial is a terminal turn outcome, not a process-exit claim.
                    // CodeBuddy stays alive for the next prompt; close this queue item
                    // without stopping the process or replaying the completed input.
                    if (!['completed', 'partial'].includes(observation.outcome) && observation.process !== 'stopped') { current.state = 'blocked'; current.reason = 'turn_ended_process_unconfirmed'; }
                    else {
                        current.state = observation.outcome === 'partial' ? 'failed' : observation.outcome;
                        current.finishedAt = Date.now(); current.reason = observation.outcome === 'partial' ? 'partial_success' : undefined;
                        current.checkoutDigest = observation.checkoutDigest; current.testResult = observation.testResult;
                    }
                } else if (observation.externalRunning && !current.legacy) {
                    current.state = 'blocked'; current.reason = 'external_turn_running';
                } else if (observation.process === 'stopped') {
                    current.state = 'failed'; current.reason = 'process_stopped_without_result'; current.finishedAt = Date.now();
                } else if (current.seq !== undefined || current.legacy && (observation.outcome === 'running' || observation.pendingInput)) { current.state = 'running'; current.reason = undefined; }
                else { current.state = 'blocked'; current.reason = 'dispatch_receipt_unknown'; }
            });
            if (current.state === 'canceling' && observation.process !== 'stopped') await this.executor.stop(current);
        } catch (e) {
            // The local process owner may still attest exit after grant revocation; it
            // does not disclose content or regain dispatch authority.
            let stopped = false; try { stopped = await this.executor.stopped?.(task) ?? false; } catch { /* Unknown keeps the lease. */ }
            this.queue.update(task.id, t => { if (terminalTask(t)) return; if (stopped) { t.state = t.state === 'canceling' ? 'cancelled' : 'failed'; t.finishedAt = Date.now(); t.reason = 'execution_stopped'; } else t.reason = revoked(e) ? 'authorization_revoked_execution_unconfirmed' : 'observation_unavailable'; });
        }
    }
    dispatch(checking: () => readonly LegacyCheck[] = () => []) {
        const work: Promise<void>[] = [];
        // Ledger capacity bounds a tick; an absent machine ceiling must not impose 2/4.
        for (let n = 0; n < 1000; n++) {
            const task = this.queue.claim(this.workerID, checking());
            if (!task) break;
            work.push(this.start(task, () => this.send(task, checking)));
        }
        return work;
    }
    private async send(task: QueueTask, checking: () => readonly LegacyCheck[]) {
        try {
            await this.executor.authorize(task);
            const before = await this.executor.observe(task);
            if (before.process === 'stopped') { this.queue.update(task.id,t=>{if(t.state==='preparing'){t.state='failed';t.reason='session_stopped';t.finishedAt=Date.now();}});return; }
            if (before.externalRunning || !(before.process === 'running' || before.process === 'unknown' && before.dispatchable === true)) {
                this.queue.update(task.id, t => { if (t.state === 'preparing') { t.state = 'waiting-resource'; t.reason = before.externalRunning ? 'session_turn' : 'session_process_unknown'; t.notBefore=Date.now()+1000; } }); return;
            }
            // Durable point of no automatic replay, before invoking the transport.
            if (!this.queue.beginDispatch(task.id, checking())) return;
            const sent = await this.executor.send({ ...task, dispatched: true });
            this.queue.update(task.id, t => { t.seq = sent.seq; t.messageID = sent.id; if (t.state === 'preparing') t.state = 'running'; });
        } catch (e) {
            const invalidCandidate = candidateError(e);
            this.queue.update(task.id, t => {
                if (terminalTask(t) || t.state === 'canceling') return;
                if (!t.dispatched && invalidCandidate) { t.state = 'failed'; t.reason = invalidCandidate; t.finishedAt = Date.now(); }
                else if (!t.dispatched && revoked(e)) { t.state = 'failed'; t.reason = 'authorization_revoked'; t.finishedAt = Date.now(); }
                else if (!t.dispatched) { t.state = 'queued'; t.reason = e instanceof ApiError && /^[A-Z][A-Z0-9_]{0,95}$/.test(e.code) ? `execution_unavailable:${e.code}` : 'execution_unavailable'; t.notBefore=Date.now()+3000; }
                else { t.state = 'blocked'; t.reason = 'dispatch_receipt_unknown'; }
            });
        }
    }
    async tick() {
        const observed = this.reconcile();
        await Promise.all([...observed, ...this.dispatch()]);
        if (observed.length) await Promise.all(this.dispatch());
    }
    async drain() { await Promise.allSettled(this.work.values()); }
    async cancel(grantID: string, sessionID: string, mutationID: string, requestID?: string) {
        const tasks = this.queue.cancel(grantID, sessionID, mutationID, requestID);
        for (const task of tasks.filter(t => t.state === 'canceling')) { try { await this.executor.stop(task); } catch { /* Keep intent and locks until independent exit evidence. */ } }
        return tasks;
    }
}
