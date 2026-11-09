import { constants, closeSync, fstatSync, openSync, writeFileSync, fsyncSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { MetadataStore } from './store';
import { privateDirectory, privateRead } from './privateFs';
import { ApiError } from './schema';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { z } from 'zod';
import { executionSchema } from './execution';
import { concurrencyPolicySchema, normalizeConcurrency, type ConcurrencyPolicy } from './concurrency';

export { executionSchema } from './execution';
import type { Execution } from './execution';
export type Resource = { key: string; mode: 'shared' | 'exclusive' };
export type Workspace = { id: string; grantID: string; projectID: string; root: string; cwd: string;
    repository: string; stage?: 'preparing' | 'ready'; preparationPID?: number; preparationError?: string; branch?: string; baseCommit?: string; execution: Execution; fingerprint: string;
    sessionID?: string; options?: Record<string, unknown>; resolvedOptions?: unknown; temporaryDirectory: string; port: number };
export type QueueTask = { id: string; requestID: string; grantID: string; workerID: string; sessionID: string; workspaceID?: string;
    fingerprint: string; authorization: string; text: string; resources: Resource[]; order: number;
    state: 'queued' | 'waiting-resource' | 'preparing' | 'running' | 'canceling' | 'completed' | 'failed' | 'cancelled' | 'blocked';
    reason?: string; dispatched: boolean; seq?: number; messageID?: string; turnID?: string; cursor: number;
    notBefore?: number; resultCommit?: string; worktreeDirty?: boolean; ownerPID?: number; processID?: number; legacy?: boolean; createdAt: number; finishedAt?: number };
type Cancellation = { requestID: string; grantID: string; sessionID: string; sendRequestID?: string; fingerprint: string; taskIDs: string[] };
type State = { schedulers: Record<string,{lastSeen:number}>; cancellations: Cancellation[]; version: 2; policy: ConcurrencyPolicy; nextOrder: number; workspaces: Workspace[]; tasks: QueueTask[] };
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema = z.object({ key: z.string().min(1).max(256), mode: z.enum(['shared','exclusive']) }).strict();
const taskSchema = z.object({ id: digest, requestID: identifier, grantID: identifier, workerID: identifier, sessionID: identifier,
    workspaceID: digest.optional(), fingerprint: digest, authorization: z.string().max(64), text: z.string().max(100000), resources: z.array(resourceSchema).max(36), order: z.number().int().nonnegative(),
    state: z.enum(['queued','waiting-resource','preparing','running','canceling','completed','failed','cancelled','blocked']), reason: z.string().max(256).optional(), dispatched: z.boolean(),
    seq: z.number().int().nonnegative().optional(), messageID: z.string().optional(), turnID: z.string().optional(), cursor: z.number().int().nonnegative(),
    notBefore: z.number().nonnegative().optional(), resultCommit: z.string().regex(/^[a-f0-9]{40,64}$/).optional(), worktreeDirty: z.boolean().optional(), ownerPID: z.number().int().positive().optional(), processID: z.number().int().positive().optional(), legacy: z.boolean().optional(), createdAt: z.number().nonnegative(), finishedAt: z.number().nonnegative().optional() }).strict();
const workspaceSchema = z.object({ id: digest, grantID: identifier, projectID: identifier, root: z.string().startsWith('/'), cwd: z.string().startsWith('/'), repository: z.string().startsWith('/'),
    stage: z.enum(['preparing','ready']).optional(), preparationPID: z.number().int().positive().optional(), preparationError: z.string().optional(), branch: z.string().optional(), baseCommit: z.string().optional(), execution: executionSchema, fingerprint: digest, sessionID: identifier.optional(),
    options: z.record(z.string(),z.json()).optional(), resolvedOptions: z.json().optional(), temporaryDirectory: z.string().startsWith('/'), port: z.number().int().min(20000).max(60000) }).strict();
const cancellationSchema = z.object({ requestID: identifier, grantID: identifier, sessionID: identifier, sendRequestID: identifier.optional(), fingerprint: digest, taskIDs: z.array(digest).max(1000) }).strict();
const legacyStateSchema = z.object({ version: z.literal(1), maxConcurrency: z.number().int().min(1).max(4), nextOrder: z.number().int().nonnegative(),
    schedulers: z.record(z.string(),z.object({lastSeen:z.number().nonnegative()}).strict()), workspaces: z.array(workspaceSchema).max(40001), tasks: z.array(taskSchema).max(1000), cancellations: z.array(cancellationSchema).max(5000) }).strict();
const stateSchema = legacyStateSchema.omit({version:true,maxConcurrency:true}).extend({version:z.literal(2),policy:concurrencyPolicySchema}).strict();
const taskFingerprint = (t: Pick<QueueTask,'requestID'|'grantID'|'workerID'|'sessionID'|'authorization'|'text'|'resources'|'workspaceID'|'legacy'>) => hash(canonicalBody({
    requestID: t.requestID, grantID: t.grantID, workerID: t.workerID, sessionID: t.sessionID, authorization: t.authorization, text: t.text, resources: t.resources, workspaceID: t.workspaceID, legacy: t.legacy }));
export const terminalTask = (t: QueueTask) => ['completed', 'failed', 'cancelled'].includes(t.state);
export const occupiesSlot = (t: QueueTask) => !terminalTask(t) && !['queued', 'waiting-resource'].includes(t.state);
const conflicts = (a: Resource[], b: Resource[]) => a.some(x => b.some(y => x.key === y.key && (x.mode === 'exclusive' || y.mode === 'exclusive')));

/** Short synchronous transactions under the same kernel flock in every process.
 * Never expires a lock/lease on a timer. Flock releases on death; dispatched tasks do not.
 */
export class TaskQueue {
    private store: MetadataStore;
    readonly policy: ConcurrencyPolicy;
    /** Compatibility for explicit old callers; absent machine limit has no artificial ceiling. */
    get maxConcurrency() { return this.policy.machineConcurrency ?? Infinity; }
    constructor(readonly directory: string, policy: Partial<ConcurrencyPolicy> | number = {}) {
        this.policy = normalizeConcurrency(policy);
        this.store = new MetadataStore(directory, 64 * 1024 * 1024);
        this.transaction(() => undefined);
    }
    transaction<T>(fn: (s: State) => T): T {
        privateDirectory(this.directory);
        const fd = openSync(join(this.directory, '.queue-lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new ApiError('QUEUE_UNAVAILABLE', 503);
            // No async work in this critical section. Contention waits in the kernel, with a bound.
            if (spawnSync('flock', ['--exclusive', '--timeout', '5', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 6000 }).status !== 0) throw new ApiError('QUEUE_UNAVAILABLE', 503);
            const stored = this.store.get<{ sealed: string }>('queue');
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
            if (!stateSchema.safeParse(state).success) throw new ApiError('QUEUE_CORRUPT',503);
            if (canonicalBody(state.policy) !== canonicalBody(this.policy)) throw new ApiError('QUEUE_CONFIGURATION_CHANGED',503);
            if (new Set(state.tasks.map(t => t.id)).size !== state.tasks.length || new Set(state.workspaces.map(w => w.id)).size !== state.workspaces.length
                || new Set(state.tasks.map(t => t.order)).size !== state.tasks.length || state.tasks.some(t => t.id !== hash(`${t.grantID}\n${t.requestID}`) || t.fingerprint !== taskFingerprint(t) || t.order >= state.nextOrder)) throw new ApiError('QUEUE_CORRUPT', 503);
            const before = JSON.stringify(state);
            state.cancellations ??= [];
            const result = fn(state);
            if (!saved || migrated || JSON.stringify(state) !== before) {
                // Migration and cancellation also write through this boundary. Never persist
                // a ledger which the next process would reject, even when an enqueue is bypassed.
                if (state.tasks.length > 1000 || state.workspaces.length > 40001 || state.cancellations.length > 5000) throw new ApiError('QUEUE_CAPACITY_EXCEEDED',503);
                if (!stateSchema.safeParse(state).success) throw new ApiError('QUEUE_STATE_INVALID',503);
                if (Buffer.byteLength(JSON.stringify(state)) > 40 * 1024 * 1024) throw new ApiError('QUEUE_CAPACITY_EXCEEDED',503);
                const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
                const payload = Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]);
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
    tasks() { return this.transaction(s => s.tasks); }
    workspaces(grantID: string) { return this.transaction(s => s.workspaces.filter(w => w.grantID === grantID)); }
    update(id: string, fn: (t: QueueTask) => void) { return this.transaction(s => { const t = s.tasks.find(t => t.id === id); if (!t) throw new ApiError('NOT_FOUND', 404); fn(t); return t; }); }
    enqueue(input: Omit<QueueTask, 'id' | 'fingerprint' | 'order' | 'state' | 'dispatched' | 'cursor' | 'createdAt'>) {
        const fingerprint = taskFingerprint(input), id = hash(`${input.grantID}\n${input.requestID}`);
        return this.transaction(s => {
            if (s.workspaces.some(w => w.id === id) || s.cancellations.some(c => c.grantID === input.grantID && c.requestID === input.requestID)) throw new ApiError('REQUEST_ID_CONFLICT', 409);
            const previous = s.tasks.find(t => t.id === id);
            if (previous) { if (previous.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_CONFLICT', 409); return previous; }
            const task: QueueTask = { ...input, id, fingerprint, order: s.nextOrder++, state: 'queued', reason: 'scheduler-ready', dispatched: false, cursor: 0, createdAt: Date.now() };
            if (s.tasks.length >= 1000 || Buffer.byteLength(JSON.stringify(s)) + Buffer.byteLength(JSON.stringify(task)) > 40 * 1024 * 1024) throw new ApiError('QUEUE_CAPACITY_EXCEEDED', 503);
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
            const tasks = prior ? s.tasks.filter(t => prior.taskIDs.includes(t.id)) : s.tasks.filter(t => t.grantID === grantID && t.sessionID === sessionID && (!requestID || t.requestID === requestID));
            if (!tasks.length) return [];
            if (!prior) s.cancellations.push({ requestID: mutationID, grantID, sessionID, sendRequestID: requestID, fingerprint, taskIDs: tasks.map(t => t.id) });
            for (const t of tasks) if (!terminalTask(t)) {
                if (!t.dispatched) { t.state = 'cancelled'; t.finishedAt = Date.now(); }
                else t.state = 'canceling';
            }
            return tasks;
        });
    }
    claim(workerID?: string): QueueTask | null {
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
    receipt(t: QueueTask) {
        const workspace = this.transaction(s => s.workspaces.find(w => w.id === t.workspaceID));
        return { requestID: t.requestID, taskID: t.id, queueID: t.id, sessionID: t.sessionID,
            state: t.state === 'cancelled' ? 'cancelled' : t.seq !== undefined ? 'submitted' : t.state,
            executionState: t.state, executionDispatched: t.dispatched, queueReason: t.reason,
            ...(t.dispatched && ['failed','cancelled'].includes(t.state)?{process:'stopped'}:{}),
            seq: t.seq, messageID: t.messageID, turnID: t.turnID,
            ...(workspace ? { execution: { mode: workspace.execution.mode, directory: workspace.cwd, branch: workspace.branch,
                baseCommit: workspace.baseCommit, resultCommit: t.resultCommit, dirty: t.worktreeDirty, projectID: workspace.projectID, port: workspace.port }, resources: workspace.execution.resources } : {}),
            canCancel: !terminalTask(t), recovery: t.state === 'blocked' ? 'Inspect original receipt/process; automatic replay is disabled.' : undefined };
    }
}
