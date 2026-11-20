import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, writeFileSync, fsyncSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { MetadataStore } from './store';
import { privateDirectory, privateRead } from './privateFs';
import { ApiError } from './schema';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { z } from 'zod';
import { checkoutDigest, executionSchema, objectID, testEvidenceSchema, type TestEvidence } from './execution';
import { concurrencyPolicySchema, normalizeConcurrency, type ConcurrencyPolicy } from './concurrency';
import { decodeCandidates, encodeCandidates, holdsReviewCheckout } from './taskQueueCompatibility';

export { executionSchema } from './execution';
export { holdsReviewCheckout } from './taskQueueCompatibility';
import type { Execution } from './execution';
export type Resource = { key: string; mode: 'shared' | 'exclusive' };
export type LegacyCheck = { sessionID: string; resources: Resource[] };
export type Workspace = { id: string; grantID: string; projectID: string; root: string; cwd: string;
    managedBy?: { machineID: string; uid: number };
    retirement?: { operationID: string; phase: 'retiring' | 'retired'; retainedRef: string; retainedCommit: string };
    repository: string; stage?: 'preparing' | 'ready'; preparationPID?: number; preparationError?: string; branch?: string; baseCommit?: string; execution: Execution; fingerprint: string;
    sessionID?: string; options?: Record<string, unknown>; resolvedOptions?: unknown; temporaryDirectory: string; port: number;
    candidateTree?: string; testCleanup?: 'removed' | 'retained' };
export type QueueTask = { id: string; requestID: string; grantID: string; workerID: string; sessionID: string; workspaceID?: string;
    fingerprint: string; authorization: string; text: string; resources: Resource[]; order: number;
    state: 'queued' | 'waiting-resource' | 'preparing' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled' | 'blocked';
    reason?: string; dispatched: boolean; seq?: number; messageID?: string; turnID?: string; cursor: number;
    notBefore?: number; resultCommit?: string; worktreeDirty?: boolean; ownerPID?: number; processID?: number; legacy?: boolean; createdAt: number; finishedAt?: number;
    checkoutDigest?: string; reviewReleased?: boolean; testResult?: TestEvidence };
type Cancellation = { requestID: string; grantID: string; sessionID: string; sendRequestID?: string; fingerprint: string; taskIDs: string[] };
type State = { schedulers: Record<string,{lastSeen:number}>; cancellations: Cancellation[]; version: 2; policy: ConcurrencyPolicy; nextOrder: number; workspaces: Workspace[]; tasks: QueueTask[] };
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema = z.object({ key: z.string().min(1).max(256), mode: z.enum(['shared','exclusive']) }).strict();
const taskSchema = z.object({ id: digest, requestID: identifier, grantID: identifier, workerID: identifier, sessionID: identifier,
    workspaceID: digest.optional(), fingerprint: digest, authorization: z.string().max(64), text: z.string().max(100000), resources: z.array(resourceSchema).max(36), order: z.number().int().nonnegative(),
    state: z.enum(['queued','waiting-resource','preparing','running','canceling','completed','failed','cancelled','blocked']), reason: z.string().max(256).optional(), dispatched: z.boolean(),
    seq: z.number().int().nonnegative().optional(), messageID: z.string().optional(), turnID: z.string().optional(), cursor: z.number().int().nonnegative(),
    notBefore: z.number().nonnegative().optional(), resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), worktreeDirty: z.boolean().optional(), ownerPID: z.number().int().positive().optional(), processID: z.number().int().positive().optional(), legacy: z.boolean().optional(), createdAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional(),
    checkoutDigest: checkoutDigest.optional(), reviewReleased: z.boolean().optional(), testResult: testEvidenceSchema.optional() }).strict();
const workspaceSchema = z.object({ id: digest, grantID: identifier, projectID: identifier, root: z.string().startsWith('/'), cwd: z.string().startsWith('/'), repository: z.string().startsWith('/'),
    managedBy: z.object({ machineID: identifier, uid: z.number().int().nonnegative() }).strict().optional(),
    retirement: z.object({ operationID: identifier, phase: z.enum(['retiring','retired']), retainedRef: z.string().max(256), retainedCommit: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict().optional(),
    stage: z.enum(['preparing','ready']).optional(), preparationPID: z.number().int().positive().optional(), preparationError: z.string().optional(), branch: z.string().optional(), baseCommit: z.string().optional(), execution: executionSchema, fingerprint: digest, sessionID: identifier.optional(),
    options: z.record(z.string(),z.json()).optional(), resolvedOptions: z.json().optional(), temporaryDirectory: z.string().startsWith('/'), port: z.number().int().min(20000).max(60000),
    candidateTree: objectID.optional(), testCleanup: z.enum(['removed', 'retained']).optional() }).strict();
const cancellationSchema = z.object({ requestID: identifier, grantID: identifier, sessionID: identifier, sendRequestID: identifier.optional(), fingerprint: digest, taskIDs: z.array(digest).max(1000) }).strict();
const legacyStateSchema = z.object({ version: z.literal(1), maxConcurrency: z.number().int().min(1).max(4), nextOrder: z.number().int().nonnegative(),
    schedulers: z.record(z.string(),z.object({lastSeen:z.number().nonnegative()}).strict()), workspaces: z.array(workspaceSchema).max(40001), tasks: z.array(taskSchema).max(1000), cancellations: z.array(cancellationSchema).max(5000) }).strict();
const activeTaskLimit = 1000;
const stateSchema = legacyStateSchema.omit({version:true,maxConcurrency:true}).extend({
    version: z.literal(2), policy: concurrencyPolicySchema, tasks: z.array(taskSchema),
}).strict();
const taskFingerprint = (t: Pick<QueueTask,'requestID'|'grantID'|'workerID'|'sessionID'|'authorization'|'text'|'resources'|'workspaceID'|'legacy'>) => hash(canonicalBody({
    requestID: t.requestID, grantID: t.grantID, workerID: t.workerID, sessionID: t.sessionID, authorization: t.authorization, text: t.text, resources: t.resources, workspaceID: t.workspaceID, legacy: t.legacy }));
export const terminalTask = (t: QueueTask) => ['completed', 'failed', 'cancelled'].includes(t.state);
export const occupiesSlot = (t: QueueTask) => !terminalTask(t) && !['queued', 'waiting-resource'].includes(t.state);
const conflicts = (a: Resource[], b: Resource[]) => a.some(x => b.some(y => x.key === y.key && (x.mode === 'exclusive' || y.mode === 'exclusive')));
export const pendingConflict = (task: QueueTask, check: LegacyCheck) => check.sessionID !== task.sessionID && conflicts(task.resources, check.resources);
const reviewSource = (s: State, workspace?: Workspace) => {
    const candidate = workspace?.execution.candidate;
    if (candidate?.kind !== 'checkout') return;
    return s.tasks.find(t => t.grantID === workspace!.grantID && t.requestID === candidate.requestID && t.checkoutDigest === candidate.digest);
};
const releaseReview = (s: State, reviewer: QueueTask) => {
    if (!terminalTask(reviewer)) return;
    const source = reviewSource(s, s.workspaces.find(w => w.id === reviewer.workspaceID));
    if (source) source.reviewReleased = true;
};
function reviewBlockers(s: State, task: QueueTask) {
    const source = reviewSource(s, s.workspaces.find(w => w.id === task.workspaceID));
    return s.tasks.filter(t => holdsReviewCheckout(t) && t.id !== source?.id
        && conflicts(task.resources, t.resources.filter(r => r.key.startsWith('checkout:'))));
}

/** Short synchronous transactions under the same kernel flock in every process.
 * Never expires a lock/lease on a timer. Flock releases on death; dispatched tasks do not.
 */
export class TaskQueue {
    private store: MetadataStore;
    readonly policy: ConcurrencyPolicy;
    /** Compatibility for explicit old callers; absent machine limit has no artificial ceiling. */
    get maxConcurrency() { return this.policy.machineConcurrency ?? Infinity; }
    constructor(readonly directory: string, policy: Partial<ConcurrencyPolicy> | number = {},
        readonly access: { machineID?: string; readOnly?: boolean } = {}) {
        this.policy = normalizeConcurrency(policy);
        this.store = new MetadataStore(directory, 64 * 1024 * 1024, !access.readOnly);
        if (!access.readOnly) this.transaction(() => undefined);
    }
    transaction<T>(fn: (s: State) => T, readOnly = false): T {
        if(this.access.readOnly&&!readOnly)throw new ApiError('QUEUE_READ_ONLY',503);
        readOnly ||= Boolean(this.access.readOnly);
        privateDirectory(this.directory);
        const fd = openSync(join(this.directory, '.queue-lock'), (readOnly ? constants.O_RDONLY : constants.O_CREAT | constants.O_RDWR) | constants.O_NOFOLLOW, 0o600);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new ApiError('QUEUE_UNAVAILABLE', 503);
            // No async work in this critical section. Contention waits in the kernel, with a bound.
            if (spawnSync('flock', [readOnly ? '--shared' : '--exclusive', '--timeout', '5', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 6000 }).status !== 0) throw new ApiError('QUEUE_UNAVAILABLE', 503);
            const stored = this.store.get<{ sealed: string }>('queue');
            if(!stored&&lstatSync(join(this.directory,hash('queue')+'.json'),{throwIfNoEntry:false}))throw new ApiError('QUEUE_CORRUPT',503);
            if (readOnly && !stored) throw new ApiError('QUEUE_NOT_INITIALIZED',503);
            if(!stored&&readdirSync(this.directory).some(name=>name!=='.queue-lock'))throw new ApiError('QUEUE_RECOVERY_REQUIRED',503);
            const key = this.payloadKey(!stored);
            let saved: unknown = null;
            if (stored) {
                try {
                    if (typeof stored.sealed !== 'string') throw new Error();
                    const bytes = Buffer.from(stored.sealed, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
                    decipher.setAuthTag(bytes.subarray(12,28));
                    saved = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
                } catch { throw new ApiError('QUEUE_CORRUPT', 503); }
            }
            if(stored&&(saved===null||typeof saved!=='object'))throw new ApiError('QUEUE_CORRUPT',503);
            let migrated = false;
            let state: State;
            if (saved && (saved as {version?:number}).version === 1) {
                const old = legacyStateSchema.safeParse(saved);
                if (!old.success) throw new ApiError('QUEUE_CORRUPT',503);
                if (old.data.tasks.some(t=>t.fingerprint!==taskFingerprint(t))) throw new ApiError('QUEUE_CORRUPT',503);
                // Historical implicit 2 is now the project default. Explicit legacy registration
                // maxConcurrency is translated to machineConcurrency by the Worker. Never widen
                // a non-default persisted ceiling without an explicit matching machine policy.
                if (old.data.maxConcurrency !== 2 && this.policy.machineConcurrency !== old.data.maxConcurrency)
                    throw new ApiError('QUEUE_MIGRATION_REQUIRES_MACHINE_LIMIT',503);
                const {version: _version,maxConcurrency: _max,...rest} = old.data;
                state = {...rest,version:2,policy:this.policy};
                // Already claimed/unknown operations retain every old global lock until exit.
                for (const t of state.tasks.filter(t=>!occupiesSlot(t))) {
                    if (state.workspaces.some(w=>w.id===t.workspaceID)) {
                        t.resources=t.resources.map(r=>r.key==='machine'?{...r,mode:'shared'}:r);
                        t.fingerprint=taskFingerprint(t);
                    }
                }
                migrated=true;
            } else state = (saved ?? { version: 2, policy: this.policy, nextOrder: 0, schedulers: {}, cancellations: [], workspaces: [], tasks: [] }) as State;
            if (!stateSchema.safeParse(state).success || state.tasks.filter(t => !terminalTask(t)).length > activeTaskLimit) throw new ApiError('QUEUE_CORRUPT',503);
            if (canonicalBody(state.policy) !== canonicalBody(this.policy)) throw new ApiError('QUEUE_CONFIGURATION_CHANGED',503);
            if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || new Set(state.workspaces.map(w => w.id)).size !== state.workspaces.length
                || new Set(state.tasks.map(t => t.order)).size !== state.tasks.length || state.tasks.some(t => t.id !== hash(`${t.grantID}\n${t.requestID}`) || t.fingerprint !== taskFingerprint(t) || t.order >= state.nextOrder)) throw new ApiError('QUEUE_CORRUPT', 503);
            decodeCandidates(state);
            const before = readOnly ? '' : JSON.stringify(state);
            state.cancellations ??= [];
            const result = fn(state);
            if (readOnly) { key.fill(0); return structuredClone(result); }
            if (!saved || migrated || JSON.stringify(state) !== before) {
                // Migration and cancellation also write through this boundary. Never persist
                // a ledger which the next process would reject, even when an enqueue is bypassed.
                if (!stateSchema.safeParse(state).success) throw new ApiError('QUEUE_STATE_INVALID',503);
                const persisted = encodeCandidates(state);
                if (persisted.tasks.filter(t => !terminalTask(t)).length > activeTaskLimit || state.workspaces.length > 40001 || state.cancellations.length > 5000) throw new ApiError('QUEUE_CAPACITY_EXCEEDED',503);
                const payloadJSON = JSON.stringify(persisted);
                if (Buffer.byteLength(payloadJSON) > 40 * 1024 * 1024) throw new ApiError('QUEUE_CAPACITY_EXCEEDED',503);
                const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
                const payload = Buffer.concat([cipher.update(payloadJSON,'utf8'),cipher.final()]);
                this.store.set('queue', { sealed: Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64') });
            }
            key.fill(0);
            return structuredClone(result);
        } finally { closeSync(fd); }
    }
    private payloadKey(create: boolean) {
        const path = join(this.directory, '.payload-key');
        try { const key = privateRead(path,32); if (key.length !== 32) throw new ApiError('QUEUE_CORRUPT'); return key; }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            if (!create) throw new ApiError('QUEUE_KEY_MISSING',503);
            // Called under the machine flock. Key and authenticated ciphertext must be backed up together.
            const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600), key = randomBytes(32);
            try { writeFileSync(fd,key); fsyncSync(fd); } finally { closeSync(fd); }
            const directory = openSync(this.directory,'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
            return key;
        }
    }
    configureConcurrency(value: Partial<ConcurrencyPolicy> | number) {
        const policy = normalizeConcurrency(value);
        this.transaction(s => { if (s.tasks.some(t => !terminalTask(t))) throw new ApiError('QUEUE_IN_USE'); s.policy = policy; });
        // Call only with all workers stopped, then construct with the new configuration.
    }
    noteScheduler(workerID: string) { this.transaction(s=>{s.schedulers[workerID]={lastSeen:Date.now()};}); }
    tasks() { return this.transaction(s => s.tasks,true); }
    workspaces(grantID: string) { return this.transaction(s => s.workspaces.filter(w => w.grantID === grantID),true); }
    releaseCandidate(workspace: Workspace) {
        this.transaction(s => { const source = reviewSource(s, workspace); if (source) source.reviewReleased = true; });
    }
    update(id: string, fn: (t: QueueTask) => void) {
        return this.transaction(s => {
            const t = s.tasks.find(t => t.id === id); if (!t) throw new ApiError('NOT_FOUND', 404);
            const wasTerminal = terminalTask(t);
            fn(t);
            if (!wasTerminal) releaseReview(s, t);
            return t;
        });
    }
    enqueue(input: Omit<QueueTask, 'id' | 'fingerprint' | 'order' | 'state' | 'dispatched' | 'cursor' | 'createdAt'>) {
        const fingerprint = taskFingerprint(input), id = hash(`${input.grantID}\n${input.requestID}`);
        return this.transaction(s => {
            if (s.workspaces.some(w => w.id === id) || s.cancellations.some(c => c.grantID === input.grantID && c.requestID === input.requestID)) throw new ApiError('REQUEST_ID_CONFLICT', 409);
            const previous = s.tasks.find(t => t.id === id);
            if (previous) { if (previous.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_CONFLICT', 409); return previous; }
            if (s.workspaces.find(w => w.id === input.workspaceID)?.retirement) throw new ApiError('WORKSPACE_RETIRED',409);
            if (s.workspaces.find(w => w.id === input.workspaceID)?.execution.candidate?.kind === 'test'
                && s.tasks.some(t => t.workspaceID === input.workspaceID)) throw new ApiError('TEST_CHECKOUT_SETTLED', 409);
            const task: QueueTask = { ...input, id, fingerprint, order: s.nextOrder++, state: 'queued', reason: 'scheduler-ready', dispatched: false, cursor: 0, createdAt: Date.now() };
            s.tasks.push(task); return task;
        });
    }
    adoptLegacy(input: Omit<QueueTask, 'id' | 'fingerprint' | 'order' | 'state' | 'dispatched' | 'cursor' | 'createdAt'>) {
        return this.transaction(s => {
            const id = hash(`${input.grantID}\n${input.requestID}`), previous = s.tasks.find(t => t.id === id);
            if (previous) return previous;
            const task: QueueTask = { ...input, id, fingerprint: taskFingerprint(input), order: s.nextOrder++, state: 'running', dispatched: true, cursor: 0, createdAt: Date.now(), legacy: true };
            // legacy is part of the immutable identity.
            task.fingerprint = taskFingerprint(task); s.tasks.push(task); return task;
        });
    }
    /** Refine only the old generated fallback after its owner is observed again.
     * Explicit task/maintenance resources are immutable and never enter this path.
     */
    refineLegacyResources(observed: QueueTask, resources: Resource[]) {
        return this.transaction(s => {
            const task = s.tasks.find(t => t.id === observed.id);
            if (!task || terminalTask(task) || task.fingerprint !== observed.fingerprint || task.processID !== observed.processID || task.turnID !== observed.turnID || task.seq !== observed.seq
                || !task.legacy || task.grantID !== 'legacy-import' || task.authorization || task.text
                || task.resources.length !== 1 && (task.resources.some(r => r.key.startsWith('repo:') && !resources.some(next => next.key === r.key))
                    || canonicalBody(task.resources.filter(r => r.key !== 'machine' && !r.key.startsWith('repo:') && !r.key.startsWith('checkout:')))
                        !== canonicalBody(resources.filter(r => r.key !== 'machine' && !r.key.startsWith('repo:') && !r.key.startsWith('checkout:'))))
                || !resources.some(r => r.key === 'machine' && r.mode === 'shared') || !resources.some(r => r.key.startsWith('repo:'))) return;
            task.resources = resources;
            task.fingerprint = taskFingerprint(task);
        });
    }
    /** Upgrade only an exact old generated checkout lease. Explicit named locks,
     * request identity and dispatch evidence are retained; no work is replayed.
     */
    refineWorkspaceResources(observed: QueueTask, resources: Resource[], original?: Pick<Workspace, 'repository' | 'cwd' | 'execution'>) {
        this.transaction(s => {
            const task = s.tasks.find(t => t.id === observed.id), stored = s.workspaces.find(w => w.id === task?.workspaceID), w = stored ?? original;
            if (!task || !w || terminalTask(task) || task.fingerprint !== observed.fingerprint || task.legacy
                || task.workspaceID && !stored || stored && stored.sessionID !== task.sessionID
                || !stored && (w.execution.mode !== 'legacy' || w.execution.resources.length)) return;
            const previous: Resource[] = [{ key: 'machine', mode: 'shared' }, { key: `repo:${hash(w.repository)}`, mode: ['worktree', 'read-only'].includes(w.execution.mode) ? 'shared' : 'exclusive' },
                ...w.execution.resources.map(key => ({ key: `declared:${key}`, mode: 'exclusive' as const })), { key: `session:${task.sessionID}`, mode: 'exclusive' }];
            const expected: Resource[] = [{ key: 'machine', mode: 'shared' }, { key: `repo:${hash(w.repository)}`, mode: 'shared' },
                { key: `checkout:${hash(w.cwd)}`, mode: w.execution.mode === 'read-only' ? 'shared' : 'exclusive' },
                ...w.execution.resources.map(key => ({ key: `declared:${key}`, mode: 'exclusive' as const })), { key: `session:${task.sessionID}`, mode: 'exclusive' }];
            if (canonicalBody(task.resources) !== canonicalBody(previous) || canonicalBody(resources) !== canonicalBody(expected)) return;
            task.resources = resources; task.fingerprint = taskFingerprint(task);
        });
    }
    /** Losing corroboration restores conservative exclusion without dropping declared resources. */
    restoreLegacyExclusion(observed: QueueTask) {
        this.transaction(s => {
            const task = s.tasks.find(t => t.id === observed.id);
            if (!task || terminalTask(task) || task.fingerprint !== observed.fingerprint || task.processID !== observed.processID || task.turnID !== observed.turnID || task.seq !== observed.seq
                || !task.legacy || task.grantID !== 'legacy-import' || task.authorization || task.text) return;
            const machine = task.resources.find(r => r.key === 'machine');
            if (machine?.mode !== 'shared') return;
            machine.mode = 'exclusive'; task.fingerprint = taskFingerprint(task);
        });
    }
    cancellation(grantID: string, requestID: string) {
        return this.transaction(s => {
            const c = s.cancellations.find(c => c.grantID === grantID && c.requestID === requestID);
            if (!c) return null;
            const active = s.tasks.filter(t => c.taskIDs.includes(t.id) && !terminalTask(t));
            return { requestID, sessionID: c.sessionID, targeted: !!c.sendRequestID, state: active.length || !c.sendRequestID ? 'cancel_requested' : 'cancelled', executionState: active.length || !c.sendRequestID ? 'canceling' : 'cancelled' };
        });
    }
    cancel(grantID: string, sessionID: string, mutationID: string, requestID?: string) {
        return this.transaction(s => {
            const fingerprint = hash(canonicalBody({ sessionID, requestID }));
            const prior = s.cancellations.find(c => c.grantID === grantID && c.requestID === mutationID);
            if (prior && prior.fingerprint !== fingerprint || s.tasks.some(t => t.grantID === grantID && t.requestID === mutationID) || s.workspaces.some(w => w.id === hash(`${grantID}\n${mutationID}`))) throw new ApiError('REQUEST_ID_CONFLICT', 409);
            const tasks = prior ? s.tasks.filter(t => prior.taskIDs.includes(t.id)) : s.tasks.filter(t => t.grantID === grantID && t.sessionID === sessionID && (requestID ? t.requestID === requestID : !terminalTask(t)));
            if (!tasks.length && (prior || requestID || !s.tasks.some(t => t.grantID === grantID && t.sessionID === sessionID))) return [];
            if (!prior) s.cancellations.push({ requestID: mutationID, grantID, sessionID, sendRequestID: requestID, fingerprint, taskIDs: tasks.map(t => t.id) });
            for (const t of tasks) {
                if (terminalTask(t)) {
                    if (requestID && holdsReviewCheckout(t)) t.reviewReleased = true;
                } else if (!t.dispatched) {
                    t.state = 'cancelled'; t.finishedAt = Date.now(); releaseReview(s, t);
                } else t.state = 'canceling';
            }
            return tasks;
        });
    }
    claim(workerID?: string, checking: readonly LegacyCheck[] = []): QueueTask | null {
        return this.transaction(s => {
            const active = s.tasks.filter(occupiesSlot);
            const project = (t: QueueTask) => {
                const workspace=s.workspaces.find(w=>w.id===t.workspaceID);
                return workspace ? `repo:${hash(workspace.repository)}`
                    : t.resources.find(r=>r.key.startsWith('repo:'))?.key ?? 'unknown-project';
            };
            const overrides = new Map(Object.entries(s.policy.projectOverrides).map(([path,limit])=>[`repo:${hash(path)}`,limit]));
            const projectLimit = (key: string) => overrides.get(key) ?? s.policy.projectConcurrency;
            // Include only live owners in reservations. A worker never claims another owner's
            // task; its ready task still reserves resources and quotas to prevent starvation.
            const waiting = s.tasks.filter(t => !t.legacy && (!workerID || t.workerID===workerID || (s.schedulers[t.workerID]?.lastSeen ?? 0)>Date.now()-10000) && ['queued', 'waiting-resource'].includes(t.state) && (!t.notBefore || t.notBefore<=Date.now())).sort((a,b) => a.order - b.order);
            const reserved: Resource[]=[]; const reservedProjects=new Map<string,number>(); let reservedSlots=0;
            for (const task of waiting) {
                const sessionBusy = s.tasks.some(t => !terminalTask(t) && t.id !== task.id && t.sessionID === task.sessionID && (occupiesSlot(t) || t.order < task.order));
                if (sessionBusy) {task.state='waiting-resource';task.reason='session_turn';continue;}
                // The older write must let its own reviewer through, even when this
                // waiting writer arrived first. The retained checkout still excludes it.
                if (reviewBlockers(s, task).length) { task.state = 'waiting-resource'; task.reason = 'candidate_review'; continue; }
                if (checking.some(other => pendingConflict(task, other))) {
                    task.state = 'waiting-resource'; task.reason = 'legacy_observation';
                    reserved.push(...task.resources); continue;
                }
                const key=project(task);
                if (s.policy.machineConcurrency !== null && active.length+reservedSlots >= s.policy.machineConcurrency) {
                    task.state='queued';task.reason='machine-limit';continue;
                }
                if (active.filter(t=>project(t)===key).length+(reservedProjects.get(key)??0) >= projectLimit(key)) {
                    task.state='queued';task.reason='project-limit';continue;
                }
                if (active.some(t=>conflicts(task.resources,t.resources))||conflicts(task.resources,reserved)) {
                    task.state='waiting-resource';task.reason='resource-wait';reserved.push(...task.resources);continue;
                }
                if(workerID && task.workerID!==workerID){reserved.push(...task.resources);reservedSlots++;reservedProjects.set(key,(reservedProjects.get(key)??0)+1);continue;}
                task.state = 'preparing'; task.reason = undefined; delete task.notBefore; task.ownerPID = process.pid;
                return task;
            }
            return null;
        });
    }
    beginDispatch(id: string, checking: readonly LegacyCheck[]) {
        return this.transaction(s => {
            const task = s.tasks.find(t => t.id === id)!;
            if (task.state !== 'preparing' || task.dispatched) return false;
            // Recheck after the async preflight. Discovery may have found an older
            // turn while this task was checking its own session.
            const pending = checking.some(other => pendingConflict(task, other));
            const reviewing = reviewBlockers(s, task).length > 0;
            if (pending || reviewing || s.tasks.some(other => other.id !== id && occupiesSlot(other) && conflicts(task.resources, other.resources))) {
                task.state = 'waiting-resource'; task.reason = pending ? 'legacy_observation' : reviewing ? 'candidate_review' : 'resource-wait'; return false;
            }
            task.dispatched = true;
            return true;
        });
    }
    receipt(t: QueueTask, checking: readonly LegacyCheck[] = []) {
        return this.transaction(s => {
        t = s.tasks.find(current => current.id === t.id) ?? t;
        const workspace = s.workspaces.find(w => w.id === t.workspaceID);
        const active = s.tasks.filter(other => other.id !== t.id && occupiesSlot(other));
        const blockers = active.filter(other => conflicts(t.resources, other.resources));
        const named = t.resources.filter(r => r.key.startsWith('declared:') && blockers.some(other => conflicts([r], other.resources))).map(r => r.key.slice('declared:'.length));
        const sameDirectory = blockers.some(other => t.resources.some(r => r.key.startsWith('checkout:') && conflicts([r], other.resources)));
        // Only identities already visible through this grant may leave the Worker.
        const sessions = [...new Set(blockers.filter(other => other.grantID === t.grantID).map(other => `/session/${other.sessionID}`))].slice(0, 5);
        let recovery: string | undefined;
        if (t.reason === 'resource-wait' || t.reason === 'resource_lock') {
            recovery = blockers.some(other => other.resources.some(r => r.key === 'machine' && r.mode === 'exclusive'))
                ? '正在核对旧执行进程或等待机器维护释放资源；确认后自动继续。'
                : sameDirectory || named.length
                ? `${[...(sameDirectory ? [`工作目录${workspace ? ` ${workspace.cwd}` : ''}`] : []), ...(named.length ? [`共享资源 ${named.join('、')}`] : [])].join('、')} 正在被使用；释放后自动继续。`
                : '正在等待较早任务释放或完成资源申请，系统会自动继续。';
            if (sessions.length) recovery += ` 占用会话：${sessions.join('、')}`;
        } else if (t.reason === 'candidate_review') {
            const holders = reviewBlockers(s, t).filter(other => other.grantID === t.grantID);
            recovery = `工作目录${workspace ? ` ${workspace.cwd}` : ''} 正在保留独立验收的候选，验收结束后自动继续。`;
            if (holders.length) recovery += ` 占用会话：${holders.slice(0, 5).map(other => `/session/${other.sessionID}`).join('、')}`;
        } else if (t.reason === 'legacy_observation') {
            const pending = checking.filter(other => pendingConflict(t, other));
            const directory = workspace && pending.some(other => other.resources.some(r => r.key === `checkout:${hash(workspace.cwd)}`)) ? workspace.cwd : undefined;
            const names = t.resources.filter(r => r.key.startsWith('declared:') && pending.some(other => conflicts([r], other.resources))).map(r => r.key.slice('declared:'.length));
            recovery = `正在核对${directory ? `工作目录 ${directory} 的` : ''}${names.length ? `共享资源 ${names.join('、')} 的` : ''}旧执行会话；确认后自动继续。`;
            if (pending.some(other => other.sessionID === t.sessionID)) recovery += ` 占用会话：/session/${t.sessionID}`;
        } else if (t.reason === 'project-limit') recovery = `本项目 ${workspace ? s.policy.projectOverrides[workspace.repository] ?? s.policy.projectConcurrency : s.policy.projectConcurrency} 个执行名额正在被占用或预留，前序任务推进后自动继续。`;
        else if (t.reason === 'machine-limit') recovery = '机器配置的执行名额已用满，任务结束后自动继续。';
        else if (t.reason === 'session_turn') recovery = `等待同一执行会话的前一轮结束，随后自动交办。 占用会话：/session/${t.sessionID}`;
        else if (t.reason === 'session_process_unknown' || t.state === 'blocked') recovery = '正在核对原执行会话与原请求回执；不会重复派发，确认后自动继续。';
        else if (t.reason === 'execution_unavailable' || t.reason === 'observation_unavailable') recovery = '执行端暂时不可用，系统正在重试原请求的状态查询。';
        else if (t.reason?.startsWith('execution_unavailable:')) recovery = t.reason.endsWith(':UNSUPPORTED_VERSION')
            ? '执行端协议版本不匹配，需要更新执行端；交办保持，版本匹配后自动继续。'
            : `执行条件尚未满足（${t.reason.slice('execution_unavailable:'.length)}）；系统保留原交办并会重新核对。`;
        return { requestID: t.requestID, taskID: t.id, queueID: t.id, sessionID: t.sessionID,
            state: t.state === 'cancelled' ? 'cancelled' : t.seq !== undefined ? 'submitted' : t.state,
            executionState: t.state, executionDispatched: t.dispatched, queueReason: t.reason,
            ...(t.dispatched && ['failed','cancelled'].includes(t.state) && !t.reason?.startsWith('CANDIDATE_') ? {process:'stopped'}:{}),
            seq: t.seq, messageID: t.messageID, turnID: t.turnID,
            ...(workspace ? { execution: { mode: workspace.execution.mode, directory: workspace.cwd, branch: workspace.branch,
                baseCommit: workspace.baseCommit, resultCommit: t.resultCommit, dirty: t.worktreeDirty, projectID: workspace.projectID, port: workspace.port,
                checkoutDigest: t.checkoutDigest ?? (workspace.execution.candidate?.kind === 'checkout' ? workspace.execution.candidate.digest : undefined),
                reviewPending: t.checkoutDigest ? holdsReviewCheckout(t) : undefined,
                candidateCommit: workspace.execution.candidate && workspace.execution.candidate.kind !== 'checkout' ? workspace.execution.candidate.commit : undefined,
                candidateTree: workspace.candidateTree, testResult: t.testResult, testCleanup: workspace.testCleanup,
                workspaceState: workspace.retirement?.phase ?? 'active', retainedRef: workspace.retirement?.retainedRef,
                retainedCommit: workspace.retirement?.retainedCommit }, resources: workspace.execution.resources } : {}),
            canCancel: !terminalTask(t), recovery };
        },true);
    }
}
