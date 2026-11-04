import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { AutomationControl, type Policy } from '../control';
import { Journal, hash } from '../journal';
import { ControlError, type Transport } from '../relay';
import { canonicalBody } from './auth';
import { ProofClient } from './client';
import { projectResponse } from './projection';
import { ApiError, checkBoundProjects, type Connection, type WorkerRegistration } from './schema';
import { resolveWorkerDirectories, type DirectoryJob } from './directories';
import type { Job } from './gateway';

/** Independent worker-side policy check, not a trusted copy of the caller's scope. */
export class ScopedWorker {
    constructor(private registration: WorkerRegistration, private transport: Transport, private directory: string,
        private authorize: (jobID: string) => Promise<Connection>, private now = Date.now,
        private canonicalDirectory: (path: string) => string = realpathSync) {}
    async execute(job: Job): Promise<unknown> {
        const asserted = await this.authorize(job.id);
        const check = async () => {
            const live = await this.authorize(job.id);
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
            if (!m || m.machineId !== live.machineID || !projects.some(p => p.directory === m.path)) throw new ApiError('SCOPE_DENIED', 403);
        };
        // IDs sent to relay/daemon are stable across token/key refresh and isolated per grant.
        const remoteID = (id: string) => hash(`${live.clientID}\n${live.id}\n${id}`);
        const wrapped: Transport = {
            machines: async () => { await check(); return (await this.transport.machines()).filter(m => m.id === live.machineID); },
            sessions: async (cursor, limit) => {
                await check(); const page = await this.transport.sessions(cursor, limit);
                return { ...page, sessions: page.sessions.filter(s => { const m = s.metadata as any; return m?.machineId === live.machineID && projects.some(p => p.directory === m?.path); }) };
            },
            messages: async (s, cursor, limit) => { await check(); assertSession(s); return this.transport.messages(s, cursor, limit); },
            send: async (s, id, text) => { await check(); assertSession(s); return this.transport.send(s, remoteID(id), text); },
            rpc: async (m, input) => {
                await check(); if (m.id !== live.machineID || (input.directory !== undefined && !projects.some(p => p.directory === input.directory))) throw new ApiError('SCOPE_DENIED', 403);
                return this.transport.rpc(m, { ...input, ...(typeof input.requestID === 'string' ? { requestID: remoteID(input.requestID) } : {}) });
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
            machines: [{ id: live.machineID, directories: projects.map(p => p.directory) }], sessionIDs: live.sessionIDs };
        const machine = (await wrapped.machines()).find(m => m.id === live.machineID);
        if (!machine) throw new ApiError('MACHINE_UNAVAILABLE', 503);
        const capabilities = await wrapped.rpc(machine, { version: 1, operation: 'capabilities' });
        if (capabilities.version !== 1 || !Array.isArray(capabilities.operations)
            || !['create', 'request', 'status', 'cancel'].every(op => (capabilities.operations as unknown[]).includes(op))) throw new ApiError('UNSUPPORTED_VERSION', 426);
        const core = new AutomationControl(wrapped, policy, new Journal(join(this.directory, hash(`${live.clientID}\n${live.id}`))));
        const result = await core.handle(command);
        await check(); return result;
    }
}

/** Outbound pull channel. Nothing listens on the user's machine. No implicit reconnection grant. */
export class HTTPWorkerRunner {
    readonly worker: ScopedWorker;
    private projectScopes: boolean | undefined;
    private directoryScopes = false;
    private compatibilityUntil = 0;
    constructor(private client: ProofClient, private registration: WorkerRegistration, transport: Transport, directory: string,
        private now = Date.now, canonicalDirectory?: (path: string) => string) {
        this.worker = new ScopedWorker(registration, transport, directory, async jobID => {
            const response = await client.request('POST', '/worker/check', { jobID });
            if (!response.ok) throw new ApiError(response.error?.code ?? 'WORKER_AUTHORIZATION_FAILED', 403);
            return response.data as Connection;
        }, now, canonicalDirectory);
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
        const notify = (event: { state: string; code?: string }) => { try { report(event); } catch { /* Observability must not break the worker supervisor. */ } };
        const unavailable = (error: unknown) => notify({ state: 'unavailable', code: error instanceof ApiError ? error.code : 'WORKER_CHANNEL_UNAVAILABLE' });
        try {
            while (!signal.aborted) {
                try {
                    // Keep presence and receipt queries alive during a slow spawn; bounded concurrency.
                    const job = await this.poll(active.size >= 4);
                    if (job && !signal.aborted) {
                        const work = this.handleJob(job).catch(unavailable).finally(() => active.delete(work));
                        active.add(work);
                    }
                    notify({ state: 'connected' });
                } catch (error) { unavailable(error); }
                await new Promise<void>(resolve => { const timer = setTimeout(done, intervalMs); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
            }
        } finally { await Promise.allSettled(active); }
    }
}
