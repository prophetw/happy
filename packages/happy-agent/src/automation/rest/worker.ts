import { join } from 'node:path';
import { userInfo } from 'node:os';
import { TaskQueue, occupiesSlot, type QueueTask } from './taskQueue';
import { TaskScheduler, type Observation } from './taskScheduler';
import { prepareWorkspace, verifyWorkspace, workspaceResources, workspaceResult, assertIntegrationReady, canonicalRepository } from './taskWorkspaces';
import { realpathSync, statSync } from 'node:fs';
import { AutomationControl, projectMessage, type Policy } from '../control';
import { Journal, hash } from '../journal';
import { ControlError, type Transport } from '../relay';
import { canonicalBody } from './auth';
import { ProofClient } from './client';
import { projectResponse } from './projection';
import { ApiError, cancelSchema, sendSchema, checkBoundProjects, type Connection, type WorkerRegistration } from './schema';
import { filterCatalogForGrant, optionCatalogSchema, OptionsDenied, resolveTaskOptions, taskOptionsSchema, type OptionCatalog } from './options';
import { resolveWorkerDirectories, type DirectoryJob } from './directories';
import type { Job } from './gateway';
import { SessionProcessProofs } from './sessionProcessProofs';

/** Independent worker-side policy check, not a trusted copy of the caller's scope. */
export class ScopedWorker {
    readonly queue: TaskQueue;
    readonly scheduler: TaskScheduler;
    readonly processProofs: SessionProcessProofs;
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
        });
        this.processProofs = processProofs ?? new SessionProcessProofs(join(this.queue.directory, 'session-process-proofs'), registration.machineID);
        const run = (t: QueueTask, command: Record<string, unknown>, launchCheck = false) => this.run({ id: t.id, workerID: registration.id, grantID: t.grantID,
            command, deadline: this.now() + 60000 }, () => this.currentGrant(t), true, launchCheck);
        this.scheduler = new TaskScheduler(this.queue, {
            stopped: async t => {
                const session = await this.localSession(t.sessionID), machine = (await this.transport.machines()).find(m => m.id === registration.machineID);
                if (!machine || (session.metadata as any)?.machineId !== registration.machineID) return false;
                return (await this.transport.rpc(machine, { version: 1, operation: 'status', sessionID: t.sessionID })).process === 'stopped';
            },
            authorize: async t => { const result = await run(t, { version: 1, method: 'sessions.status', sessionID: t.sessionID, cursor: 0, limit: 1 }, true); if(!result.ok)throw new ApiError(result.error?.code??'EXECUTION_UNAVAILABLE',503); },
            observe: async t => {
                if (!t.legacy) return this.observeTask(t, run);
                try {
                    const observed = await this.observeLegacy(t.sessionID);
                    if (observed.process === 'unknown' && !observed.sessionOwnerVerified) this.queue.restoreLegacyExclusion(t);
                    return observed;
                } catch (error) {
                    this.queue.restoreLegacyExclusion(t);
                    throw error;
                }
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
    private schedulingProof(session: { id: string; metadata: unknown }, process: string) {
        if (process === 'running') this.processProofs.recordRunning(session, process);
        const sessionOwnerVerified = process === 'running' || this.processProofs.verify(session);
        return { sessionOwnerVerified, dispatchable: process === 'unknown' && sessionOwnerVerified };
    }
    private async observeLegacy(sessionID: string): Promise<Observation & { sourceSession: { id: string; metadata: unknown } }> {
        const session = await this.localSession(sessionID), machine = (await this.transport.machines()).find(m => m.id === this.registration.machineID);
        if (!machine) throw new ApiError('MACHINE_UNAVAILABLE', 503);
        const process = await this.transport.rpc(machine, { version: 1, operation: 'status', sessionID });
        let cursor = 0, turnID: string | undefined, outcome: Observation['outcome'], lastInput = 0, lastTurn = 0;
        for (let n = 0; n < 10000; n++) {
            const page = await this.transport.messages(session, cursor, 100);
            for (const raw of page.messages) {
                const m = projectMessage(raw);
                if (raw.localId?.startsWith('automation:')) lastInput = raw.seq;
                if (m.kind === 'turn' && 'turnID' in m && 'state' in m) { lastTurn = raw.seq; turnID = m.turnID; outcome = m.state as Observation['outcome']; }
            }
            const next = page.messages.at(-1)?.seq ?? cursor;
            if (!page.hasMore) { const pendingInput = lastInput > lastTurn, state = String(process.process ?? 'unknown'); return { process: state, cursor: next, turnID: pendingInput ? undefined : turnID, outcome: pendingInput ? undefined : outcome, pendingInput, seq: lastInput || undefined, externalRunning: pendingInput, sourceSession: session, ...this.schedulingProof(session, state) }; }
            if (next <= cursor) throw new ApiError('INVALID_CURSOR'); cursor = next;
        }
        throw new ApiError('OBSERVATION_PAGE_LIMIT');
    }
    private legacyResources(session: { id: string; metadata: unknown }) {
        try {
            const directory = (session.metadata as any)?.path;
            if (typeof directory !== 'string' || !statSync(directory).isDirectory()) throw new Error();
            const workspace = this.queue.transaction(s => s.workspaces.find(w => w.sessionID === session.id));
            if (workspace) {
                if (workspace.cwd !== directory) throw new Error();
                verifyWorkspace(workspace);
                return workspaceResources(workspace, session.id);
            }
            return workspaceResources({ repository: canonicalRepository(directory), execution: { mode: 'legacy', resources: [] } }, session.id);
        } catch {
            // Unknown or changed paths retain the conservative machine lease.
            return workspaceResources();
        }
    }
    async tick() {
        // Read-only adoption of genuinely live pre-queue turns. Never resends historical
        // blocked/not_sent work and never treats idle long-lived session PIDs as leases.
        let cursor: string | undefined;
        do {
            const page = await this.transport.sessions(cursor);
            for (const session of page.sessions) {
                if ((session.metadata as any)?.machineId !== this.registration.machineID) continue;
                const active = this.queue.tasks().find(t => t.sessionID === session.id && occupiesSlot(t));
                if (active && (!active.legacy || !active.resources.some(r => r.key === 'machine' && r.mode === 'exclusive'))) continue;
                const observed = await this.observeLegacy(session.id);
                if (active) {
                    const pid = (observed.sourceSession.metadata as any)?.hostPid;
                    if (observed.sessionOwnerVerified && (observed.process === 'running' || observed.dispatchable) && (observed.outcome === 'running' || observed.pendingInput) && Number.isInteger(pid) && pid > 0 && pid === active.processID
                        && (observed.turnID !== undefined && observed.turnID === active.turnID
                            || observed.pendingInput && observed.seq !== undefined && observed.seq === active.seq && active.turnID === undefined)) {
                        this.queue.refineLegacyResources(active, this.legacyResources(observed.sourceSession));
                    }
                    continue;
                }
                if (observed.outcome !== 'running' && !observed.pendingInput || observed.process === 'stopped') continue;
                const pid = (observed.sourceSession.metadata as any)?.hostPid;
                const knownOwner = observed.sessionOwnerVerified && (observed.process === 'running' || observed.dispatchable) && Number.isInteger(pid) && pid > 0;
                this.queue.adoptLegacy({ requestID: hash(`legacy:${session.id}:${observed.turnID ?? 'input-' + observed.seq}`), workerID: this.registration.id, grantID: 'legacy-import', sessionID: session.id,
                    authorization: '', text: '', resources: knownOwner ? this.legacyResources(observed.sourceSession) : workspaceResources(), legacy: true, seq: observed.seq, turnID: observed.turnID, processID: Number.isInteger(pid) && pid > 0 ? pid : undefined });
            }
            if (page.nextCursor === cursor) throw new ApiError('INVALID_CURSOR'); cursor = page.nextCursor ?? undefined;
        } while (cursor);
        await this.scheduler.tick();
    }
    private async currentGrant(t: QueueTask) {
        if (!this.authorizeGrant) throw new ApiError('QUEUE_AUTHORITY_UNAVAILABLE', 503);
        const live = await this.authorizeGrant(t.grantID);
        if (hash(canonicalBody(live)) !== t.authorization) throw new ApiError('GRANT_REVOKED', 403);
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
            const local = await this.localSession(t.sessionID);
            this.queue.update(t.id, current => { current.processID = (local.metadata as any)?.hostPid; });
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
            if (!data.hasMore) { const workspace = this.queue.workspaces(t.grantID).find(w => w.id === t.workspaceID); return { ...(workspace && outcome && outcome !== 'running' ? workspaceResult(workspace) : {}), process, cursor: data.nextCursor, seq: sentSeq, messageID, turnID, outcome, externalRunning: latest === 'running' && (!t.dispatched || latestTurn !== turnID), ...this.schedulingProof(local, process) }; }
            if (data.nextCursor <= cursor) throw new ApiError('INVALID_CURSOR');
            cursor = data.nextCursor;
        }
        throw new ApiError('OBSERVATION_PAGE_LIMIT', 503);
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
        const command = { ...job.command };
        let workspaces = this.queue.workspaces(live.id);
        const permittedDirectory = (directory: unknown) => projects.some(p => p.directory === directory) || workspaces.some(w => w.cwd === directory && projects.some(p => p.id === w.projectID && p.directory === w.root));
        // Bound projected JSON below the worker-result byte budget; cursor advances only over this page.
        if (['sessions.logs', 'sessions.status', 'sessions.result'].includes(String(command.method))) command.limit = Math.min(Number(command.limit ?? 100), 100);
        if (command.method === 'tasks.create') {
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
            send: async (s, id, text) => { await check(true); assertSession(s); return this.transport.send(s, remoteID(id), text); },
            rpc: async (m, input) => {
                await check(['create','cancel'].includes(String(input.operation))); if (m.id !== live.machineID || (input.directory !== undefined && !permittedDirectory(input.directory))) throw new ApiError('SCOPE_DENIED', 403);
                const workspace = input.operation === 'create' ? workspaces.find(w => w.id === hash(`${live.id}\n${input.requestID}`) && w.cwd === input.directory) : undefined;
                return this.transport.rpc(m, { ...input, ...(workspace ? { taskEnvironment: { TMPDIR: workspace.temporaryDirectory, TMP: workspace.temporaryDirectory, TEMP: workspace.temporaryDirectory, HAPPY_TASK_ID: workspace.id, HAPPY_TASK_PORT: String(workspace.port) } } : {}), ...(typeof input.requestID === 'string' ? { requestID: remoteID(input.requestID) } : {}) });
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
        let workspace;
        if (command.method === 'tasks.create') {
            if (typeof command.requestID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.requestID)) throw new ApiError('INVALID_REQUEST');
            const execution = command.execution as { mode?: string } | undefined;
            if (execution?.mode === 'read-only' && (command.options as any)?.permissionMode !== 'read-only') throw new ApiError('OPTION_DENIED', 403);
            const project = projects.find(p => p.directory === command.directory)!;
            workspace = await prepareWorkspace(this.queue, { requestID: String(command.requestID), grantID: live.id, projectID: project.id,
                root: project.directory, execution: command.execution, options: command.options }, async()=>{await check(true);});
            await check(); verifyWorkspace(workspace);
            command.directory = workspace.cwd; delete command.execution;
            workspaces = this.queue.workspaces(live.id);
            if (!policy.machines[0].directories.includes(workspace.cwd)) policy.machines[0].directories.push(workspace.cwd);
        }
        for (const w of workspaces.filter(w => typeof command.sessionID === 'string' && w.sessionID === command.sessionID)) {
            verifyWorkspace(w);
            if (internal && (command.method === 'sessions.send' || launchCheck)) assertIntegrationReady(w);
            if (internal && (command.method === 'sessions.send' || launchCheck) && w.resolvedOptions) {
                const available = await catalog();
                let resolved;
                try { resolved = resolveTaskOptions(taskOptionsSchema.parse(w.options ?? {}), this.registration.launchOptions, live.options, available.defaultAgent, available.agents); }
                catch { throw new ApiError('OPTION_DENIED', 403); }
                if (canonicalBody(resolved) !== canonicalBody(w.resolvedOptions)) throw new ApiError('OPTION_DENIED', 403);
            }
        }
        const journal = new Journal(join(this.directory, hash(`${live.clientID}\n${live.id}`)));
        const core = new AutomationControl(wrapped, policy, journal);
        const reply = (data: unknown) => ({ version: 1, ok: true, data });
        const readCore = async (input: unknown) => { const result=await core.handle(input); await check(true); return result; };
        if (!internal && command.method === 'requests.get') {
            const preparing=workspaces.find(w=>w.id===hash(`${live.id}\n${command.requestID}`));
            if(preparing&&!journal.get(String(command.requestID))) {
                let ownerAlive=true;try { if(preparing.preparationPID) process.kill(preparing.preparationPID,0); } catch(e) {if((e as NodeJS.ErrnoException).code==='ESRCH')ownerAlive=false;}
                await check(true);return reply({requestID:command.requestID,taskID:command.requestID,state:'pending',queueReason:preparing.preparationError??(!ownerAlive?'preparation_interrupted':'preparing_worktree'),safeToRetrySameRequestID:!!preparing.preparationError||!ownerAlive});
            }
            const task = this.queue.tasks().find(t => t.grantID === live.id && t.requestID === command.requestID);
            if (task) { await check(true); return reply(this.queue.receipt(task)); }
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
            const binding = w ?? (project ? {repository:canonicalRepository(project.directory),execution:{mode:'legacy' as const,resources:[]}} : undefined);
            const task = this.queue.enqueue({ requestID: command.requestID, grantID: live.id, workerID: this.registration.id, sessionID: String(command.sessionID),
                workspaceID: w?.id, authorization: hash(canonicalBody(live)), text: command.text, resources: accepted?.resources ?? workspaceResources(binding, String(command.sessionID)) });
            await check(true); return reply(this.queue.receipt(task));
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
            this.queue.transaction(s => { const w = s.workspaces.find(w => w.id === workspace!.id)!; w.sessionID = (result as any).data.sessionID; if ((result as any).data.options) w.resolvedOptions = (result as any).data.options; });
            if ((result as any).data.process === 'running') {
                // A corroboration cache failure cannot replace a confirmed create receipt.
                try { this.processProofs.recordRunning(await this.localSession((result as any).data.sessionID), 'running'); } catch { /* Missing proof keeps later recovery conservative. */ }
            }
            return { ...(result as any), data: { ...(result as any).data, execution: { mode: workspace.execution.mode, directory: workspace.cwd, branch: workspace.branch, baseCommit: workspace.baseCommit, projectID: workspace.projectID, port: workspace.port } } };
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
        const ack = await this.client.request('POST', '/worker/result', { jobID: job.id, result: projectResponse(result) });
        if (!ack.ok) throw new ApiError(ack.error?.code ?? 'WORKER_CHANNEL_UNAVAILABLE', 503);
    }
    async pollOnce() {
        const job = await this.poll(); if (!job) return false;
        await this.handleJob(job); return true;
    }

    async run(signal: AbortSignal, intervalMs: number, report: (event: { state: string; code?: string }) => void) {
        const active = new Set<Promise<void>>();
        let schedulerWork: Promise<void> | undefined;
        let lastScheduled = 0;
        const notify = (event: { state: string; code?: string }) => { try { report(event); } catch { /* Observability must not break the worker supervisor. */ } };
        const unavailable = (error: unknown) => notify({ state: 'unavailable', code: error instanceof ApiError ? error.code : 'WORKER_CHANNEL_UNAVAILABLE' });
        try {
            while (!signal.aborted) {
                try {
                    // Keep presence and receipt queries alive during a slow spawn; bounded concurrency.
                    const job = await this.poll(active.size >= 4);
                    // Observation/preparation must not starve gateway presence or receipt RPCs.
                    if (!schedulerWork && Date.now() - lastScheduled >= 1000) { lastScheduled = Date.now(); schedulerWork = this.worker.tick().catch(unavailable).finally(() => { schedulerWork = undefined; }); }
                    if (job && !signal.aborted) {
                        const work = this.handleJob(job).catch(unavailable).finally(() => active.delete(work));
                        active.add(work);
                    }
                    notify({ state: 'connected' });
                } catch (error) { unavailable(error); }
                await new Promise<void>(resolve => { const timer = setTimeout(done, intervalMs); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
            }
        } finally { await Promise.allSettled([...active, ...(schedulerWork ? [schedulerWork] : [])]); }
    }
}
