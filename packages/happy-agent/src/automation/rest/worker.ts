import { join } from 'node:path';
import { userInfo } from 'node:os';
import { TaskQueue, occupiesSlot, terminalTask, type LegacyCheck, type QueueTask, type Workspace } from './taskQueue';
import { TaskScheduler, candidateError, type Observation } from './taskScheduler';
import { prepareWorkspace, verifyWorkspace, workspaceResources, workspaceResult, canonicalRepository, withWorkspaceAccess,
    verifyReviewCandidate, checkoutVersion, candidateInstruction, finishTestCheckout } from './taskWorkspaces';
import type { TestEvidence } from './execution';
import { realpathSync, statSync } from 'node:fs';
import { AutomationControl, projectMessage, type Policy } from '../control';
import { Journal, hash } from '../journal';
import { ControlError, type Transport, type TransportSession } from '../relay';
import { canonicalBody } from './auth';
import { ProofClient } from './client';
import { projectResponse } from './projection';
import { ApiError, cancelSchema, sendSchema, checkBoundProjects, taskTitleSchema, type Connection, type WorkerRegistration } from './schema';
import { filterCatalogForGrant, optionCatalogSchema, OptionsDenied, resolveTaskOptions, taskOptionsSchema, type OptionCatalog, type ResolvedTaskOptions } from './options';
import { resolveWorkerDirectories, type DirectoryJob } from './directories';
import type { Job } from './gateway';
import { SessionProcessProofs, retirementProcessProof } from './sessionProcessProofs';

/**
 * Queue lease pins grant identity only. Owner in-place edits (renewal, scope,
 * display name) must not fail closed queued work; revocation and live scope are
 * still enforced by authorizeGrant/checkBoundProjects on every execution.
 */
const leaseFingerprint = (c: Connection) => hash(canonicalBody({ id: c.id, clientID: c.clientID, userID: c.userID,
    workerID: c.workerID, machineID: c.machineID, clientFingerprint: c.clientFingerprint,
    workerFingerprint: c.workerFingerprint, credentialMode: c.credentialMode }));

type LegacyObservation = {
    binding: string; sessionSeq: number; cursor: number; lastInput: number; lastTurn: number;
    turnID?: string; outcome?: Observation['outcome'];
};

/** Independent worker-side policy check, not a trusted copy of the caller's scope. */
export class ScopedWorker {
    readonly queue: TaskQueue;
    readonly scheduler: TaskScheduler;
    readonly processProofs: SessionProcessProofs;
    // Only reduced message evidence is cached. Process status and ownership are always fresh.
    // A new worker reconstructs history; no ledger migration or replay rights are introduced.
    private readonly legacyObservations = new Map<string, LegacyObservation>();
    private readonly legacyChecks = new Map<string, LegacyCheck>();
    private readonly legacyReads = new Map<string, Promise<void>>();
    private readonly refinements = new Map<string, Promise<void>>();
    private readonly testCleanups = new Map<string, Promise<void>>();
    private legacyListing?: Promise<Promise<void>[]>;
    private haveLegacyInventory = false;
    constructor(private registration: WorkerRegistration, private transport: Transport, private directory: string,
        private authorize: (jobID: string) => Promise<Connection>, private now = Date.now,
        private canonicalDirectory: (path: string) => string = realpathSync,
        private authorizeGrant?: (grantID: string) => Promise<Connection>, queueDirectory?: string, processProofs?: SessionProcessProofs) {
        // This path is independent of Dot, grant, checkout and HAPPY_HOME. All workers
        // for one OS user/machine use one durable machine ledger and kernel lock.
        if (registration.maxConcurrency !== undefined && registration.machineConcurrency !== undefined && registration.maxConcurrency !== registration.machineConcurrency) throw new ApiError('INVALID_CONCURRENCY');
        const projectOverrides: Record<string,number> = {};
        for (const [path,limit] of Object.entries(registration.projectConcurrencyOverrides ?? {})) {
            const repository=canonicalRepository(path);
            if (projectOverrides[repository] !== undefined && projectOverrides[repository] !== limit) throw new ApiError('INVALID_CONCURRENCY');
            projectOverrides[repository]=limit;
        }
        this.queue = new TaskQueue(queueDirectory ?? join(userInfo().homedir, '.local/state/happy-control/machines', hash(registration.machineID)), {
            projectConcurrency: registration.projectConcurrency ?? 2,
            machineConcurrency: registration.machineConcurrency === undefined ? registration.maxConcurrency ?? null : registration.machineConcurrency,
            projectOverrides,
        }, { machineID: registration.machineID });
        this.processProofs = processProofs ?? new SessionProcessProofs(join(this.queue.directory, 'session-process-proofs'), registration.machineID);
        const run = (t: QueueTask, command: Record<string, unknown>, launchCheck = false) => this.run({ id: t.id, workerID: registration.id, grantID: t.grantID,
            command, deadline: this.now() + 60000 }, () => this.currentGrant(t), true, launchCheck);
        this.scheduler = new TaskScheduler(this.queue, {
            stopped: async t => {
                // The owner can attest exit after session keys expire. Requiring a
                // decryptable session first would leave the original lease stuck forever.
                const machine = (await this.transport.machines()).find(m => m.id === registration.machineID);
                if (!machine) return false;
                return (await this.transport.rpc(machine, { version: 1, operation: 'status', sessionID: t.sessionID })).process === 'stopped';
            },
            authorize: async t => { const result = await run(t, { version: 1, method: 'sessions.status', sessionID: t.sessionID, cursor: 0, limit: 1 }, true); if(!result.ok)throw new ApiError(result.error?.code??'EXECUTION_UNAVAILABLE',503); },
            observe: async t => {
                if (!t.legacy) return this.observeTask(t, run);
                const session = this.transport.localSessions?.().find(s => s.id === t.sessionID);
                const observed = await this.observeLegacy(t.sessionID, { session, checkProcess: (state, verified) => {
                    if (state === 'unknown' && !verified) this.queue.restoreLegacyExclusion(t);
                } });
                const pid = (observed.sourceSession.metadata as any)?.hostPid;
                if (observed.sessionOwnerVerified && (observed.outcome === 'running' || observed.pendingInput) && pid === t.processID && Number.isInteger(pid) && pid > 0
                    && (observed.turnID !== undefined && observed.turnID === t.turnID
                        || observed.pendingInput && observed.seq !== undefined && observed.seq === t.seq && t.turnID === undefined)) {
                    if (t.resources.some(r => r.key === 'machine' && r.mode === 'exclusive') || !t.resources.some(r => r.key.startsWith('checkout:')))
                        this.queue.refineLegacyResources(t, this.legacyResources(observed.sourceSession));
                }
                return observed;
            },
            send: async t => {
                const result: any = await run(t, { version: 1, method: 'sessions.send', sessionID: t.sessionID, requestID: t.requestID, text: t.text });
                if (!result.ok || result.data?.state !== 'submitted' || typeof result.data.seq !== 'number') throw new ApiError(result.error?.code ?? 'DISPATCH_UNKNOWN', 503);
                return { seq: result.data.seq, id: result.data.messageID };
            },
            stop: async t => { const result: any = await run(t, { version: 1, method: 'sessions.cancel', sessionID: t.sessionID, requestID: hash('queue-cancel:' + t.id) });
                if (!result.ok) throw new ApiError('STOP_UNCONFIRMED', 503); },
        }, registration.id);
    }
    private async localSession(sessionID: string) {
        let cursor: string | undefined;
        do {
            const page = await this.transport.sessions(cursor);
            const session = page.sessions.find(s => s.id === sessionID && (s.metadata as any)?.machineId === this.registration.machineID);
            if (session) return session;
            if (page.nextCursor === cursor) throw new ApiError('INVALID_CURSOR');
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        throw new ApiError('NOT_FOUND', 404);
    }
    private schedulingProof(session: TransportSession, process: string) {
        // A resumed session retains its Relay turn binding while the local child gets a new PID.
        const target = session.daemonProcessID === undefined ? session : {
            id: session.id, metadata: { ...(session.metadata as object), hostPid: session.daemonProcessID },
        };
        if (process === 'running') this.processProofs.recordRunning(target, process);
        const sessionOwnerVerified = process === 'running' || this.processProofs.verify(target);
        return { sessionOwnerVerified, dispatchable: process === 'unknown' && sessionOwnerVerified };
    }
    private async observeLegacy(sessionID: string, options: {
        session?: TransportSession;
        discovery?: boolean;
        checkProcess?: (state: string, verified: boolean) => void;
    }): Promise<Observation & { sourceSession: { id: string; metadata: unknown } }> {
        const session = options.session ?? await this.localSession(sessionID), machine = (await this.transport.machines()).find(m => m.id === this.registration.machineID);
        if (!machine) throw new ApiError('MACHINE_UNAVAILABLE', 503);
        const process = await this.transport.rpc(machine, { version: 1, operation: 'status', sessionID });
        const state = String(process.process ?? 'unknown');
        if (options.discovery && state === 'stopped') return { process: state, cursor: 0, sourceSession: session };
        const proof = this.schedulingProof(session, state);
        options.checkProcess?.(state, proof.sessionOwnerVerified);
        const metadata = session.metadata as { machineId?: unknown; hostPid?: unknown; path?: unknown } | null;
        const binding = hash(canonicalBody({ machineID: metadata?.machineId, pid: metadata?.hostPid, path: metadata?.path,
            encryption: session.encryption ? { variant: session.encryption.variant, key: Buffer.from(session.encryption.key).toString('base64') } : undefined }));
        const previous = this.legacyObservations.get(sessionID);
        const cached = previous?.binding === binding && !(session.seq < previous.sessionSeq) ? previous : undefined;
        let { cursor = 0, turnID, outcome, lastInput = 0, lastTurn = 0 } = cached ?? {};
        for (let n = 0; n < 10000; n++) {
            const page = await this.transport.messages(session, cursor, 100);
            for (const raw of page.messages) {
                const m = projectMessage(raw);
                if (raw.localId?.startsWith('automation:')) lastInput = raw.seq;
                if (m.kind === 'turn' && 'turnID' in m && 'state' in m) { lastTurn = raw.seq; turnID = m.turnID; outcome = m.state as Observation['outcome']; }
            }
            const next = page.messages.at(-1)?.seq ?? cursor;
            if (!page.hasMore) {
                // Publish only complete scans. A failed page must not discard unseen evidence.
                this.legacyObservations.delete(sessionID);
                this.legacyObservations.set(sessionID, { binding, sessionSeq: session.seq, cursor: next, turnID, outcome, lastInput, lastTurn });
                if (this.legacyObservations.size > 1000) this.legacyObservations.delete(this.legacyObservations.keys().next().value!);
                const pendingInput = lastInput > lastTurn;
                return { process: state, cursor: next, turnID: pendingInput ? undefined : turnID, outcome: pendingInput ? undefined : outcome, pendingInput, seq: lastInput || undefined, externalRunning: pendingInput, sourceSession: session, ...proof };
            }
            if (next <= cursor) throw new ApiError('INVALID_CURSOR'); cursor = next;
        }
        throw new ApiError('OBSERVATION_PAGE_LIMIT');
    }
    private legacyResources(session: { id: string; metadata: unknown }, registered?: Workspace | null) {
        try {
            const directory = (session.metadata as any)?.path;
            if (typeof directory !== 'string' || !statSync(directory).isDirectory()) throw new Error();
            const workspace = registered === undefined ? this.queue.transaction(s => s.workspaces.find(w => w.sessionID === session.id), true) : registered;
            if (workspace) {
                if (workspace.cwd !== directory) throw new Error();
                verifyWorkspace(workspace);
                return workspaceResources(workspace, session.id);
            }
            return workspaceResources({ repository: canonicalRepository(directory), cwd: directory, execution: { mode: 'legacy', resources: [] } }, session.id);
        } catch {
            // Unknown or changed paths retain the conservative machine lease.
            return workspaceResources();
        }
    }
    private async refineResources(task: QueueTask, workspace?: Workspace) {
        try {
            if (workspace) {
                verifyWorkspace(workspace);
                this.queue.refineWorkspaceResources(task, workspaceResources(workspace, task.sessionID));
            } else if (!task.workspaceID) {
                const grant = await this.currentGrant(task), session = await this.localSession(task.sessionID);
                const project = checkBoundProjects(grant, this.registration, this.now()).find(p => p.directory === (session.metadata as any)?.path);
                if (!project || task.processID && task.processID !== (session.metadata as any)?.hostPid) return;
                const binding = { repository: canonicalRepository(project.directory), cwd: project.directory, execution: { mode: 'legacy' as const, resources: [] } };
                this.queue.refineWorkspaceResources(task, workspaceResources(binding, task.sessionID), binding);
            }
        } catch { /* A changed binding retains its original lease. */ }
    }
    private async adoptLegacy(session: TransportSession, check: LegacyCheck) {
        const observed = await this.observeLegacy(session.id, { session, discovery: true });
        if (observed.outcome !== 'running' && !observed.pendingInput) return;
        const pid = (observed.sourceSession.metadata as any)?.hostPid;
        const knownOwner = observed.sessionOwnerVerified && (observed.process === 'running' || observed.dispatchable) && Number.isInteger(pid) && pid > 0;
        this.queue.adoptLegacy({ requestID: hash(`legacy:${session.id}:${observed.turnID ?? 'input-' + observed.seq}`),
            workerID: this.registration.id, grantID: 'legacy-import', sessionID: session.id, authorization: '', text: '',
            resources: knownOwner ? check.resources : workspaceResources(), legacy: true, seq: observed.seq, turnID: observed.turnID,
            processID: Number.isInteger(pid) && pid > 0 ? pid : undefined });
    }
    private scanLegacy(tasks: QueueTask[], workspaces: Workspace[], onRelease: () => void) {
        if (this.legacyListing) return this.legacyListing;
        const active = new Set(tasks.filter(occupiesSlot).map(t => t.sessionID));
        const bySession = new Map(workspaces.flatMap(w => w.sessionID ? [[w.sessionID, w] as const] : []));
        const seen = new Set<string>(), reads: Promise<void>[] = [];
        const visit = (sessions: TransportSession[]) => {
            for (const session of sessions) {
                if ((session.metadata as any)?.machineId !== this.registration.machineID || seen.has(session.id)) continue;
                seen.add(session.id);
                const current = this.legacyReads.get(session.id);
                if (current) { reads.push(current); continue; }
                const workspace = bySession.get(session.id);
                if (active.has(session.id) || workspace?.testCleanup === 'removed' || this.transport.localSessionStopped?.(session.id)) {
                    this.legacyChecks.delete(session.id);
                    continue;
                }
                const check = { sessionID: session.id, resources: this.legacyResources(session, workspace ?? null) };
                this.legacyChecks.set(session.id, check);
                const work = this.adoptLegacy(session, check).then(() => {
                    this.legacyChecks.delete(session.id);
                    onRelease();
                }).finally(() => { this.legacyReads.delete(session.id); });
                this.legacyReads.set(session.id, work);
                // A failed read keeps this checkout fenced and is retried on a later poll.
                void work.catch(() => {});
                reads.push(work);
            }
        };
        const local = this.transport.localSessions?.();
        const list = async () => {
            let cursor: string | undefined;
            do {
                const page = await this.transport.sessions(cursor);
                visit(page.sessions);
                if (page.nextCursor === cursor) throw new ApiError('INVALID_CURSOR');
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            this.haveLegacyInventory = true;
            for (const id of this.legacyChecks.keys()) if (!seen.has(id) && !this.legacyReads.has(id)) this.legacyChecks.delete(id);
            return reads;
        };
        // The daemon already has the keys and directories of every session this
        // worker can adopt. A paginated account listing is unnecessary there.
        if (local) {
            visit(local);
            for (const id of this.legacyChecks.keys()) if (!seen.has(id) && !this.legacyReads.has(id)) this.legacyChecks.delete(id);
            this.haveLegacyInventory = true;
            return Promise.resolve(reads);
        }
        return this.legacyListing = list().finally(() => { this.legacyListing = undefined; });
    }
    private checking = () => [...this.legacyChecks.values()];

    async tick(background?: { signal: AbortSignal; onError: (error: unknown) => void }) {
        const { tasks, workspaces } = this.queue.transaction(s => ({ tasks: s.tasks, workspaces: s.workspaces }), true);
        const byID = new Map(workspaces.map(w => [w.id, w])), refinements: Promise<void>[] = [];
        for (const task of tasks) {
            if (task.workerID !== this.registration.id || task.legacy || terminalTask(task)
                || !task.resources.some(r => r.key.startsWith('repo:')) || task.resources.some(r => r.key.startsWith('checkout:'))) continue;
            const workspace = task.workspaceID ? byID.get(task.workspaceID) : undefined;
            if (workspace?.execution.candidate?.kind === 'commit') continue;
            let work = this.refinements.get(task.id);
            if (!work) {
                work = this.refineResources(task, workspace).finally(() => { this.refinements.delete(task.id); });
                this.refinements.set(task.id, work);
            }
            refinements.push(work);
        }
        const observed = this.scheduler.reconcile(tasks);
        const dispatch = () => this.scheduler.dispatch(this.checking);
        let wake = false;
        const report = (work: Promise<void>[]) => { for (const flight of work) void flight.catch(background?.onError ?? (() => {})); };
        const reading = [...observed, ...refinements, ...this.cleanTestCheckouts(tasks, workspaces)];
        report(reading);
        const listing = this.scanLegacy(tasks, workspaces, () => {
            if (!background || wake || !tasks.some(t => ['queued', 'waiting-resource'].includes(t.state))) return;
            wake = true;
            queueMicrotask(() => {
                wake = false;
                if (background.signal.aborted) return;
                try { report(dispatch()); } catch (error) { background.onError(error); }
            });
        });
        if (background) {
            if (!this.haveLegacyInventory) await listing;
            else void listing.catch(background.onError);
            if (!background.signal.aborted) report(dispatch());
            return;
        }
        const reads = await listing;
        const results = await Promise.allSettled([...reads, ...reading, ...dispatch()]);
        if (reads.length || refinements.length || observed.length) await Promise.all(dispatch());
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
    async drain() {
        await this.legacyListing?.catch(() => {});
        await Promise.allSettled([...this.legacyReads.values(), ...this.refinements.values(), ...this.testCleanups.values(), this.scheduler.drain()]);
    }
    private cleanTestCheckouts(tasks: QueueTask[], workspaces: Workspace[]) {
        const ready = workspaces.filter(w => w.execution.candidate?.kind === 'test' && !w.testCleanup && w.sessionID);
        return ready.flatMap(workspace => {
            const task = tasks.find(t => t.workerID === this.registration.id && t.workspaceID === workspace.id && terminalTask(t));
            if (!task || this.testCleanups.has(workspace.id)) return [];
            const work = this.stopTestSession(task, workspace).finally(() => { this.testCleanups.delete(workspace.id); });
            this.testCleanups.set(workspace.id, work);
            return [work];
        });
    }
    private async stopTestSession(task: QueueTask, workspace: Workspace) {
        const machine = (await this.transport.machines()).find(m => m.id === this.registration.machineID);
        if (!machine) return;
        const stopped = async () => (await this.transport.rpc(machine, { version: 1, operation: 'status', sessionID: task.sessionID })).process === 'stopped';
        if (!await stopped()) {
            const result = await this.run({ id: task.id, workerID: task.workerID, grantID: task.grantID, deadline: this.now() + 60000,
                command: { version: 1, method: 'sessions.cancel', sessionID: task.sessionID, requestID: hash('temporary-test:' + task.id) },
            }, () => this.currentGrant(task), true);
            if (!result.ok || !await stopped()) return;
        }
        const proof = retirementProcessProof(join(this.queue.directory, 'session-process-proofs'), this.registration.machineID, task.sessionID, workspace);
        if (!proof?.processGroup) return;
        try { process.kill(-proof.processGroup, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
        await finishTestCheckout(this.queue, workspace);
    }
    private async currentGrant(t: QueueTask) {
        if (!this.authorizeGrant) throw new ApiError('QUEUE_AUTHORITY_UNAVAILABLE', 503);
        const live = await this.authorizeGrant(t.grantID);
        // Accept the pre-edit full-body lease for tasks enqueued before identity leases.
        if (t.authorization !== leaseFingerprint(live) && t.authorization !== hash(canonicalBody(live))) throw new ApiError('GRANT_REVOKED', 403);
        if (!t.workspaceID && t.resources.some(r=>r.key.startsWith('repo:'))) {
            const session=await this.localSession(t.sessionID);
            const project=checkBoundProjects(live,this.registration,this.now()).find(p=>p.directory===(session.metadata as any)?.path);
            if (!project || !t.resources.some(r=>r.key===`repo:${hash(canonicalRepository(project.directory))}`)) throw new ApiError('WORKTREE_BINDING_CHANGED',403);
        }
        return live;
    }
    private async observeTask(t: QueueTask, run: (t: QueueTask, command: Record<string, unknown>) => Promise<any>): Promise<Observation> {
        let cursor = 0, sentSeq = t.seq, messageID = t.messageID, turnID = t.turnID;
        let outcome: Observation['outcome'], latest: Observation['outcome'], latestTurn: string | undefined, process = 'unknown';
        // Reduce the complete current stream. A turn-end beyond page one is authoritative;
        // a historical running event is not a live lease.
        for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
            const reply = await run(t, { version: 1, method: 'sessions.status', sessionID: t.sessionID, cursor, limit: 100 });
            if (!reply.ok) throw new ApiError(reply.error?.code ?? 'OBSERVATION_UNAVAILABLE', 503);
            const data = reply.data;
            process = data.process;
            if (sentSeq === undefined && t.dispatched) {
                // Core requests.get reconciles the stable localId over every page.
                const receipt = await run(t, { version: 1, method: 'requests.get', requestID: t.requestID });
                if (receipt.ok && receipt.data.seq !== undefined) { sentSeq = receipt.data.seq; messageID = receipt.data.messageID; }
            }
            for (const message of data.messages ?? []) {
                if (message.kind !== 'turn') continue;
                latest = message.state; latestTurn = message.turnID;
                if (sentSeq !== undefined && message.seq > sentSeq) {
                    turnID ??= message.turnID;
                    if (message.turnID === turnID) outcome = message.state;
                }
            }
            if (!data.hasMore) {
                const local = await this.localSession(t.sessionID), processID = (local.metadata as any)?.hostPid;
                if (t.processID !== processID) this.queue.update(t.id, current => { current.processID = processID; });
                const workspace = this.queue.workspaces(t.grantID).find(w => w.id === t.workspaceID);
                const result: Observation = { process, cursor: data.nextCursor, seq: sentSeq, messageID, turnID, outcome,
                    externalRunning: latest === 'running' && (!t.dispatched || latestTurn !== turnID), ...this.schedulingProof(local, process) };
                if (!workspace) return result;
                if (!t.dispatched && workspace.execution.candidate) await verifyReviewCandidate(workspace);
                if (!outcome || outcome === 'running' || result.externalRunning) return result;
                try {
                    await verifyReviewCandidate(workspace);
                    Object.assign(result, workspaceResult(workspace));
                    if (outcome === 'completed' && workspace.execution.handoff) result.checkoutDigest = await checkoutVersion(workspace.cwd);
                    const candidate = workspace.execution.candidate;
                    if (candidate?.kind === 'test' && turnID && sentSeq !== undefined)
                        result.testResult = await this.observeTest(local, sentSeq, turnID, workspace.cwd, candidate.command);
                } catch (error) {
                    const reason = candidateError(error);
                    if (!reason) throw error;
                    result.candidateError = reason;
                    delete result.testResult; delete result.resultCommit;
                }
                return result;
            }
            if (data.nextCursor <= cursor) throw new ApiError('INVALID_CURSOR');
            cursor = data.nextCursor;
        }
        throw new ApiError('OBSERVATION_PAGE_LIMIT', 503);
    }
    private async observeTest(session: TransportSession, cursor: number, turnID: string, cwd: string, command: string): Promise<TestEvidence | undefined> {
        const started = new Set<string>();
        let result: TestEvidence | undefined;
        for (let n = 0; n < 10000; n++) {
            const page = await this.transport.messages(session, cursor, 100);
            for (const raw of page.messages) {
                const message = raw.content as { role?: string; content?: { role?: string; subagent?: string; turn?: string; ev?: Record<string, any> } } | null;
                const body = message?.content, event = body?.ev;
                if (message?.role !== 'session' || body?.role !== 'agent' || body.subagent || body.turn !== turnID || !event) continue;
                if (event.t === 'turn-end') return result;
                if (typeof event.call !== 'string') continue;
                if (event.t === 'tool-call-start' && event.name === 'CodexBash' && event.args?.cwd === cwd) {
                    const invocation = event.args.command;
                    if (invocation === command || Array.isArray(invocation) && invocation.length === 3
                        && ['/bin/bash', '/bin/sh', 'bash', 'sh'].includes(invocation[0]) && invocation[1] === '-lc' && invocation[2] === command)
                        started.add(event.call);
                }
                if (event.t === 'tool-call-end' && started.delete(event.call) && Number.isInteger(event.exitCode)) result = { command, exitCode: event.exitCode };
            }
            const next = page.messages.at(-1)?.seq ?? cursor;
            if (!page.hasMore || next <= cursor) return undefined;
            cursor = next;
        }
        return undefined;
    }
    async execute(job: Job): Promise<unknown> { return this.run(job, () => this.authorize(job.id)); }
    private async run(job: Job, authorize: () => Promise<Connection>, internal = false, launchCheck = false): Promise<any> {
        const asserted = await authorize();
        // Reuse a snapshot within one read, then revalidate before returning it.
        // Writes revalidate immediately before queue admission, Git preparation, send, create and cancel.
        const check = async (fresh = false) => {
            const live = fresh ? await authorize() : asserted;
            if (live.id !== job.grantID || live.id !== asserted.id || canonicalBody(live) !== canonicalBody(asserted)
                || live.state !== 'approved' || live.userID !== this.registration.userID || live.workerID !== this.registration.id
                || live.workerFingerprint !== hash(this.registration.publicKey)) throw new ApiError('GRANT_REVOKED', 403);
            const projects = checkBoundProjects(live, this.registration, this.now());
            if (!live.methods.includes(job.command.method as Connection['methods'][number])) throw new ApiError('SCOPE_DENIED', 403);
            if (live.scopeVersion === 3 && this.registration.directorySelection?.roots.some(root => this.canonicalDirectory(root) !== root)) throw new ApiError('PROJECT_PATH_CHANGED', 403);
            if (projects.some(p => this.canonicalDirectory(p.directory) !== p.directory || (live.scopeVersion === 3 && !statSync(p.directory).isDirectory()))) throw new ApiError('PROJECT_PATH_CHANGED', 403);
            return { live, projects };
        };
        const { live, projects } = await check();
        if (job.workerID !== this.registration.id || job.deadline < this.now()) throw new ApiError('JOB_UNAVAILABLE', 403);
        // An authorized durable queue receipt must remain readable even while the
        // native Agent is offline or its protocol is being repaired.
        if (!internal && job.command.version === 1 && job.command.method === 'requests.get'
            && typeof job.command.requestID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(job.command.requestID)
            && Object.keys(job.command).every(key => ['version', 'method', 'requestID'].includes(key))) {
            const task = this.queue.tasks().find(t => t.grantID === live.id && t.requestID === job.command.requestID);
            if (task) { await check(true); return { version: 1, ok: true, data: this.queue.receipt(task, this.checking()) }; }
        }
        const command = { ...job.command };
        let workspaces = this.queue.workspaces(live.id);
        const permittedDirectory = (directory: unknown) => projects.some(p => p.directory === directory) || workspaces.some(w => w.cwd === directory && projects.some(p => p.id === w.projectID && p.directory === w.root));
        // Bound projected JSON below the worker-result byte budget; cursor advances only over this page.
        if (['sessions.logs', 'sessions.status', 'sessions.result'].includes(String(command.method))) command.limit = Math.min(Number(command.limit ?? 100), 100);
        if (command.method === 'tasks.create') {
            if (job.createAttempt) {
                const { version: _version, ...original } = command;
                if (job.createAttempt.id !== job.id || job.createAttempt.digest !== hash(canonicalBody(original))
                    || job.createAttempt.titleDigest !== (typeof command.title === 'string' ? hash(command.title) : undefined))
                    throw new ApiError('REQUEST_ID_CONFLICT', 409);
            }
            const project = projects.find(p => p.id === command.projectID);
            if (!project || command.machineID !== live.machineID || command.directory !== undefined) throw new ApiError('SCOPE_DENIED', 403);
            delete command.projectID; command.directory = project.directory;
        }
        if (command.after_seq !== undefined) { command.cursor = command.after_seq; delete command.after_seq; }
        if (['sessions.logs', 'sessions.status', 'sessions.result'].includes(String(command.method)) && typeof command.cursor === 'string') {
            if (!/^\d+$/.test(command.cursor)) throw new ApiError('INVALID_CURSOR'); command.cursor = Number(command.cursor);
        }
        const assertSession = (s: { metadata: unknown }) => {
            const m = s.metadata as Record<string, unknown> | null;
            if (!m || m.machineId !== live.machineID || !permittedDirectory(m.path)) throw new ApiError('SCOPE_DENIED', 403);
        };
        // IDs sent to relay/daemon are stable across token/key refresh and isolated per grant.
        const remoteID = (id: string) => hash(`${live.clientID}\n${live.id}\n${id}`);
        const wrapped: Transport = {
            machines: async () => { await check(); return (await this.transport.machines()).filter(m => m.id === live.machineID); },
            sessions: async (cursor, limit) => {
                await check(); const page = await this.transport.sessions(cursor, limit);
                return { ...page, sessions: page.sessions.filter(s => { const m = s.metadata as any; return m?.machineId === live.machineID && permittedDirectory(m?.path); }) };
            },
            messages: async (s, cursor, limit) => { await check(); assertSession(s); return this.transport.messages(s, cursor, limit); },
            send: async (s, id, text) => {
                await check(true); assertSession(s);
                const w = workspaces.find(w => w.sessionID === s.id);
                const send = () => this.transport.send(s, remoteID(id), text + (w ? candidateInstruction(w) : ''));
                return w ? withWorkspaceAccess(this.queue,w.id,send) : send();
            },
            rpc: async (m, input) => {
                await check(['create','withdraw-create','cancel'].includes(String(input.operation))); if (m.id !== live.machineID || (input.directory !== undefined && !permittedDirectory(input.directory))) throw new ApiError('SCOPE_DENIED', 403);
                const workspace = ['create','withdraw-create'].includes(String(input.operation)) ? workspaces.find(w => w.id === hash(`${live.id}\n${input.requestID}`) && w.cwd === input.directory) : undefined;
                const call = () => this.transport.rpc(m, { ...input, ...(workspace ? { taskEnvironment: { TMPDIR: workspace.temporaryDirectory, TMP: workspace.temporaryDirectory, TEMP: workspace.temporaryDirectory, HAPPY_TASK_ID: workspace.id, HAPPY_TASK_PORT: String(workspace.port),
                    ...(taskTitle ? { HAPPY_TASK_TITLE: taskTitle, HAPPY_TASK_ROOT: workspace.root } : {}) } } : {}), ...(typeof input.requestID === 'string' ? { requestID: remoteID(input.requestID) } : {}) });
                const used = workspace ?? (typeof input.sessionID==='string'?workspaces.find(w => w.sessionID === input.sessionID):undefined);
                return used && input.operation !== 'withdraw-create' ? withWorkspaceAccess(this.queue,used.id,call) : call();
            },
        };
        // Map reconciliation localIds back into the core's stable logical requestID space.
        const reconcile = wrapped.messages;
        if (command.method === 'requests.get' && typeof command.requestID === 'string') {
            const logicalID = command.requestID;
            wrapped.messages = async (...args) => {
                const page = await reconcile(...args);
                return { ...page, messages: page.messages.map(m => m.localId === `automation:${remoteID(logicalID)}` ? { ...m, localId: `automation:${logicalID}` } : m) };
            };
        }
        const policy: Policy = { version: 1, serverUrl: 'https://worker.invalid', methods: live.methods,
            machines: [{ id: live.machineID, directories: [...projects.map(p => p.directory), ...workspaces.filter(w => projects.some(p => p.id === w.projectID && p.directory === w.root)).map(w => w.cwd)] }], sessionIDs: live.sessionIDs };
        const machine = (await wrapped.machines()).find(m => m.id === live.machineID);
        if (!machine) throw new ApiError('MACHINE_UNAVAILABLE', 503);
        const capabilities = await wrapped.rpc(machine, { version: 1, operation: 'capabilities' });
        if (capabilities.version !== 1 || !Array.isArray(capabilities.operations)
            || !['create', 'request', 'status', 'cancel'].every(op => (capabilities.operations as unknown[]).includes(op))) throw new ApiError('UNSUPPORTED_VERSION', 426);
        // Launch-option catalog is served by the daemon that actually spawns;
        // a daemon without it cannot honour overrides or discovery.
        const catalog = async (): Promise<OptionCatalog> => {
            if (!(capabilities.operations as unknown[]).includes('options')) throw new ApiError('UNSUPPORTED_VERSION', 426);
            const reply = await wrapped.rpc(machine, { version: 1, operation: 'options' });
            const parsed = optionCatalogSchema.safeParse(reply);
            if (!parsed.success) throw new ApiError('UNSUPPORTED_VERSION', 426);
            return parsed.data;
        };
        if (command.method === 'options.list') {
            if (command.machineID !== live.machineID) throw new ApiError('SCOPE_DENIED', 403);
            const reply = await catalog();
            // Only the options this grant may select leave the machine.
            await check(true); return { version: 1, ok: true, data: filterCatalogForGrant(reply, this.registration.launchOptions, live.options) };
        }
        if (command.method === 'tasks.create') {
            const requested = taskOptionsSchema.parse(command.options ?? {});
            const anyOverride = Object.values(requested).some(v => v !== undefined);
            if (anyOverride || this.registration.launchOptions || live.options) {
                const reply = await catalog();
                try { resolveTaskOptions(requested, this.registration.launchOptions, live.options, reply.defaultAgent, reply.agents); }
                catch (error) { if (error instanceof OptionsDenied) throw new ApiError('OPTION_DENIED', 403); throw error; }
            }
        }
        let workspace, taskTitle: string | undefined;
        if (command.method === 'tasks.create') {
            if (typeof command.requestID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.requestID)) throw new ApiError('INVALID_REQUEST');
            const execution = command.execution as { mode?: string } | undefined;
            if (execution?.mode === 'read-only' && (command.options as any)?.permissionMode !== 'read-only') throw new ApiError('OPTION_DENIED', 403);
            const project = projects.find(p => p.directory === command.directory)!;
            taskTitle = taskTitleSchema.optional().parse(command.title);
            workspace = await prepareWorkspace(this.queue, { requestID: String(command.requestID), grantID: live.id, projectID: project.id,
                root: project.directory, ...(taskTitle ? { title: taskTitle } : {}), execution: command.execution, options: command.options }, async()=>{await check(true);});
            await check(); verifyWorkspace(workspace);
            command.directory = workspace.cwd; delete command.execution; delete command.title;
            workspaces = this.queue.workspaces(live.id);
            if (!policy.machines[0].directories.includes(workspace.cwd)) policy.machines[0].directories.push(workspace.cwd);
        }
        for (const w of workspaces.filter(w => typeof command.sessionID === 'string' && w.sessionID === command.sessionID)) {
            if (!w.execution.candidate) verifyWorkspace(w);
            else if (command.method === 'sessions.send') {
                if (w.testCleanup) throw new ApiError('TEST_CHECKOUT_SETTLED', 409);
                if (internal && w.execution.candidate.kind !== 'checkout') verifyWorkspace(w);
            }
            if (internal && (command.method === 'sessions.send' || launchCheck) && w.resolvedOptions) {
                const available = await catalog();
                try {
                    const requested = taskOptionsSchema.parse(w.options ?? {});
                    const resolved = resolveTaskOptions(requested, this.registration.launchOptions, live.options, available.defaultAgent, available.agents);
                    const launched = w.resolvedOptions as Partial<ResolvedTaskOptions>;
                    // Omitted Codex model and effort were settled when this session was created.
                    if (resolved.agent === 'codex') {
                        if (requested.model === undefined && typeof launched.model === 'string') resolved.model = launched.model;
                        if (requested.effort === undefined && typeof launched.effort === 'string') resolved.effort = launched.effort;
                    }
                    if (canonicalBody(resolved) !== canonicalBody(launched)) throw new OptionsDenied();
                } catch { throw new ApiError('OPTION_DENIED', 403); }
            }
        }
        const journal = new Journal(join(this.directory, hash(`${live.clientID}\n${live.id}`)));
        const attempt = capabilities.operations.includes('withdraw-create') ? job.createAttempt : undefined;
        const core = new AutomationControl(wrapped, policy, journal, command.method === 'tasks.create' ? attempt : undefined);
        const reply = (data: unknown) => ({ version: 1, ok: true, data });
        const readCore = async (input: unknown) => { const result=await core.handle(input); await check(true); return result; };
        if (!internal && command.method === 'requests.get') {
            const preparing=workspaces.find(w=>w.id===hash(`${live.id}\n${command.requestID}`));
            const entry = journal.get(String(command.requestID));
            // Only the endpoint can exclude a delayed create, even when its normal receipt is absent.
            let interrupted = false;
            if (preparing && !entry) {
                interrupted = !!preparing.preparationError;
                try { if (preparing.preparationPID) process.kill(preparing.preparationPID, 0); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') interrupted = true; }
            }
            if (attempt && live.methods.includes('tasks.create') && preparing && projects.some(p => p.id === preparing.projectID && p.directory === preparing.root)
                && (interrupted || entry?.method === 'tasks.create' && ['unknown','unavailable'].includes(entry.state) && entry.createAttempt && canonicalBody(entry.createAttempt) === canonicalBody(attempt))) {
                const id = String(command.requestID);
                const fence = await wrapped.rpc(machine, {version: 1, operation: 'withdraw-create', requestID: id, createAttempt: attempt,
                    directory: preparing.cwd, options: preparing.options, ...(attempt.titleDigest ? {withdrawRoot:preparing.root} : {})});
                if (fence.state === 'withdrawn' && fence.requestID === remoteID(id) && canonicalBody(fence.createAttempt) === canonicalBody(attempt)) {
                    await check(true);
                    return { ...reply({requestID: id, state: 'pending', safeToRetrySameRequestID: true, queueReason: 'execution_not_reached'}), closedCreate: attempt };
                }
            }
            if (preparing && !entry) {
                await check(true);
                return reply({requestID:command.requestID,taskID:command.requestID,state:'pending',
                    queueReason:preparing.preparationError ?? (interrupted?'preparation_interrupted':'preparing_worktree'),safeToRetrySameRequestID:false});
            }
            const task = this.queue.tasks().find(t => t.grantID === live.id && t.requestID === command.requestID);
            if (task) { await check(true); return reply(this.queue.receipt(task, this.checking())); }
            const cancellation = this.queue.cancellation(live.id, String(command.requestID));
            if (cancellation) { await check(true); if (!cancellation.targeted && journal.get(String(command.requestID))) return readCore(command); const { targeted: _targeted, ...data } = cancellation; return reply(data); }
        }
        if (!internal && command.method === 'sessions.send') {
            if (Object.keys(command).some(k => !['version','method','sessionID','requestID','text'].includes(k))) throw new ApiError('INVALID_REQUEST');
            sendSchema.parse({requestID: command.requestID, text: command.text});
            if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 100000
                || typeof command.requestID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.requestID)) throw new ApiError('INVALID_REQUEST');
            // Exercise the same owned-session gate before accepting a durable write.
            const allowed: any = await core.handle({ version: 1, method: 'sessions.status', sessionID: command.sessionID, cursor: 0, limit: 1 });
            if (!allowed.ok) return allowed;
            await check(true);
            const previous = journal.get(command.requestID);
            if (previous && !this.queue.tasks().some(t => t.grantID === live.id && t.requestID === command.requestID)) {
                const fingerprint = hash(JSON.stringify({ method: 'sessions.send', sessionID: command.sessionID, text: command.text }));
                if (previous.method !== 'sessions.send' || previous.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_CONFLICT', 409);
                return readCore({ version: 1, method: 'requests.get', requestID: command.requestID });
            }
            const w = workspaces.find(w => w.sessionID === command.sessionID);
            const accepted = this.queue.tasks().find(t=>t.grantID===live.id && t.requestID===command.requestID);
            // A new turn on an authorized pre-queue session is ordinary project work.
            // Importing its already-live old turn still retains global exclusion in tick().
            const session = !w && !accepted ? await this.localSession(String(command.sessionID)) : undefined;
            const project = session ? projects.find(p=>p.directory===(session.metadata as any)?.path) : undefined;
            const binding = w ?? (project ? {repository:canonicalRepository(project.directory),cwd:project.directory,execution:{mode:'legacy' as const,resources:[]}} : undefined);
            const task = this.queue.enqueue({ requestID: command.requestID, grantID: live.id, workerID: this.registration.id, sessionID: String(command.sessionID),
                workspaceID: w?.id, authorization: leaseFingerprint(live), text: command.text, resources: accepted?.resources ?? workspaceResources(binding, String(command.sessionID)) });
            await check(true); return reply(this.queue.receipt(task, this.checking()));
        }
        if (!internal && command.method === 'sessions.cancel') {
            if (Object.keys(command).some(k => !['version','method','sessionID','requestID','sendRequestID'].includes(k))) throw new ApiError('INVALID_REQUEST');
            cancelSchema.parse({requestID: command.requestID, sendRequestID: command.sendRequestID});
            const previousCancel=journal.get(String(command.requestID));
            if (previousCancel && !this.queue.cancellation(live.id,String(command.requestID))) {
                const fingerprint=hash(JSON.stringify({method:'sessions.cancel',sessionID:command.sessionID}));
                if(previousCancel.method!=='sessions.cancel'||previousCancel.fingerprint!==fingerprint||command.sendRequestID!==undefined) throw new ApiError('REQUEST_ID_CONFLICT',409);
                return readCore({version:1,method:'requests.get',requestID:command.requestID});
            }
            const sendRequestID = command.sendRequestID;
            delete command.sendRequestID;
            await check(true);
            const tasks = await this.scheduler.cancel(live.id, String(command.sessionID), String(command.requestID), typeof sendRequestID === 'string' ? sendRequestID : undefined);
            if (tasks.length && sendRequestID) return reply({ requestID: command.requestID, sessionID: command.sessionID, state: tasks.some(t => t.state === 'canceling') ? 'cancel_requested' : 'cancelled',
                executionState: tasks.some(t => t.state === 'canceling') ? 'canceling' : 'cancelled' });
            if (sendRequestID) throw new ApiError('NOT_FOUND', 404);
        }
        const result = await core.handle(command);
        await check(true);
        workspace ??= command.method === 'requests.get' ? workspaces.find(w=>w.id===hash(`${live.id}\n${command.requestID}`)) : undefined;
        if (workspace && (result as any)?.data?.sessionID) {
            workspace=this.queue.transaction(s => { const w = s.workspaces.find(w => w.id === workspace!.id)!;
                if(!w.retirement){w.sessionID = (result as any).data.sessionID; if ((result as any).data.options) w.resolvedOptions = (result as any).data.options;}
                return w;
            });
            if (!workspace.retirement && (result as any).data.process === 'running') {
                // A corroboration cache failure cannot replace a confirmed create receipt.
                try { this.processProofs.recordRunning(await this.localSession((result as any).data.sessionID), 'running'); } catch { /* Missing proof keeps later recovery conservative. */ }
            }
            return { ...(result as any), data: { ...(result as any).data, execution: { mode: workspace.execution.mode, directory: workspace.cwd, branch: workspace.branch, baseCommit: workspace.baseCommit, projectID: workspace.projectID, port: workspace.port,
                workspaceState:workspace.retirement?.phase??'active',retainedRef:workspace.retirement?.retainedRef,retainedCommit:workspace.retirement?.retainedCommit,
                checkoutDigest: workspace.execution.candidate?.kind === 'checkout' ? workspace.execution.candidate.digest : undefined,
                candidateCommit: workspace.execution.candidate && workspace.execution.candidate.kind !== 'checkout' ? workspace.execution.candidate.commit : undefined,
                candidateTree: workspace.candidateTree, testCleanup: workspace.testCleanup } } };
        }
        return result;
    }
}

/** Outbound pull channel. Nothing listens on the user's machine. No implicit reconnection grant. */
export class HTTPWorkerRunner {
    readonly worker: ScopedWorker;
    private projectScopes: boolean | undefined;
    private directoryScopes = false;
    private compatibilityUntil = 0;
    constructor(private client: ProofClient, private registration: WorkerRegistration, transport: Transport, directory: string,
        private now = Date.now, canonicalDirectory?: (path: string) => string, queueDirectory?: string) {
        this.worker = new ScopedWorker(registration, transport, directory, async jobID => {
            const response = await client.request('POST', '/worker/check', { jobID });
            if (!response.ok) throw new ApiError(response.error?.code ?? 'WORKER_AUTHORIZATION_FAILED', 403);
            return response.data as Connection;
        }, now, canonicalDirectory, async grantID => {
            const response = await client.request('POST', '/worker/authorize', { grantID });
            if (!response.ok) throw new ApiError(response.error?.code ?? 'WORKER_AUTHORIZATION_FAILED', 403);
            return response.data as Connection;
        }, queueDirectory);
    }
    private async poll(busy = false): Promise<Job | null> {
        if (this.projectScopes === undefined || this.compatibilityUntil <= this.now()) {
            const compatibility = await this.client.request('GET', '/compatibility');
            if (!compatibility.ok) throw new ApiError('WORKER_CHANNEL_UNAVAILABLE', 503);
            this.projectScopes = compatibility.data?.projectScopes === 1;
            this.directoryScopes = compatibility.data?.directoryScopes === 1 && !!this.registration.directorySelection;
            this.compatibilityUntil = this.now() + 30000;
        }
        const response = await this.client.request('POST', '/worker/poll', { protocol: 1, busy, ...(this.projectScopes ? { projectScopes: 1 } : {}), ...(this.directoryScopes ? { directoryScopes: 1 } : {}) });
        // A control-plane downgrade must renegotiate instead of weakening a live grant.
        if (!response.ok && response.error?.code === 'INVALID_REQUEST') this.projectScopes = undefined;
        if (!response.ok) throw new ApiError(response.error?.code ?? 'WORKER_CHANNEL_UNAVAILABLE', 503);
        return response.data as Job | null;
    }
    private async handleJob(job: Job) {
        if (job.command.method === 'owner.resolve-directories') {
            const checked = await this.client.request('POST', '/worker/directory-check', { jobID: job.id });
            if (!checked.ok || canonicalBody(checked.data) !== canonicalBody(job)) throw new ApiError('JOB_UNAVAILABLE', 403);
            let reply: Record<string, unknown>;
            try { reply = { projects: resolveWorkerDirectories(this.registration, job as DirectoryJob, this.now) }; }
            catch (error) { reply = { error: error instanceof ApiError && ['SCOPE_DENIED','PROJECT_PATH_CHANGED'].includes(error.code) ? error.code : 'DIRECTORY_UNAVAILABLE' }; }
            const ack = await this.client.request('POST', '/worker/directory-result', { jobID: job.id, ...reply });
            if (!ack.ok) throw new ApiError('WORKER_CHANNEL_UNAVAILABLE', 503);
            return;
        }
        let result: unknown;
        try { result = await this.worker.execute(job); }
        catch (error) { result = { version: 1, ok: false, error: { code: error instanceof ApiError || error instanceof ControlError ? error.code : 'UNAVAILABLE_OR_UNKNOWN', retryable: false } }; }
        const projected = projectResponse(result);
        if (job.createAttempt && canonicalBody((result as {closedCreate?: unknown}).closedCreate) === canonicalBody(job.createAttempt))
            projected.closedCreate = job.createAttempt;
        const ack = await this.client.request('POST', '/worker/result', { jobID: job.id, result: projected });
        if (!ack.ok) throw new ApiError(ack.error?.code ?? 'WORKER_CHANNEL_UNAVAILABLE', 503);
    }
    async pollOnce() {
        const job = await this.poll(); if (!job) return false;
        await this.handleJob(job); return true;
    }

    async run(signal: AbortSignal, intervalMs: number, report: (event: { state: string; code?: string }) => void) {
        const active = new Set<Promise<void>>();
        let schedulerWork: Promise<void> | undefined;
        let lastScheduled = -Infinity;
        let lastEvent: string | undefined, lastReportedAt = -Infinity;
        let channelObserved = false, channelFailure: string | undefined, schedulerFailure: string | undefined;
        const errorCode = (error: unknown) => error instanceof ApiError ? error.code : 'WORKER_CHANNEL_UNAVAILABLE';
        const notify = () => {
            if (!channelObserved || signal.aborted) return;
            const code = channelFailure ?? schedulerFailure;
            const event = code ? { state: 'unavailable', code } : { state: 'connected' };
            const key = JSON.stringify(event), now = this.now();
            // Keep a heartbeat within the existing 55s readiness window without logging every poll.
            if (key === lastEvent && now >= lastReportedAt && now - lastReportedAt < 30000) return;
            try { report(event); lastEvent = key; lastReportedAt = now; } catch { /* Observability must not break the worker supervisor. */ }
        };
        const unavailable = (error: unknown) => { channelObserved = true; channelFailure = errorCode(error); notify(); };
        try {
            while (!signal.aborted) {
                try {
                    // Keep presence and receipt queries alive during a slow spawn; bounded concurrency.
                    const job = await this.poll(active.size >= 4);
                    channelObserved = true; channelFailure = undefined;
                    // Observation/preparation must not starve gateway presence or receipt RPCs.
                    if (!schedulerWork && this.now() - lastScheduled >= 1000) {
                        lastScheduled = this.now();
                        schedulerWork = this.worker.tick({ signal, onError: error => { schedulerFailure = errorCode(error); notify(); } }).then(() => { schedulerFailure = undefined; notify(); }, error => { schedulerFailure = errorCode(error); notify(); }).finally(() => { schedulerWork = undefined; });
                    }
                    if (job && !signal.aborted) {
                        const work = this.handleJob(job).catch(unavailable).finally(() => active.delete(work));
                        active.add(work);
                    }
                    notify();
                } catch (error) { unavailable(error); }
                await new Promise<void>(resolve => { const timer = setTimeout(done, intervalMs); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
            }
        } finally {
            await Promise.allSettled([...active, ...(schedulerWork ? [schedulerWork] : [])]);
            await this.worker.drain();
        }
    }
}
