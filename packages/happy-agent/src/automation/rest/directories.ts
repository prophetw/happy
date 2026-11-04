import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { z } from 'zod';
import { canonicalBody } from './auth';
import { hash } from '../journal';
import { ApiError, directoryAllowed, directoryPath, directoryProjectID, identifier, selectedProjectsSchema, type WorkerRegistration } from './schema';
import type { Job } from './gateway';
import type { MetadataStore } from './store';

export const resolveDirectoriesSchema = z.object({ workerID: identifier, machineID: identifier,
    directories: z.array(directoryPath).min(1).max(32).refine(a => new Set(a).size === a.length) }).strict();
export type DirectoryJob = Job & { command: { method: 'owner.resolve-directories'; userID: string; machineID: string; directories: string[] } };
type Pending = { job: DirectoryJob; delivered: boolean; resolve: (projects: { id: string; directory: string }[]) => void; reject: (error: ApiError) => void; timer: ReturnType<typeof setTimeout> };
export const directoryResultSchema = z.object({ jobID: identifier, projects: selectedProjectsSchema.optional(), error: z.enum(['DIRECTORY_UNAVAILABLE','SCOPE_DENIED','PROJECT_PATH_CHANGED']).optional() }).strict();

/** Owner-only, read-only requests sharing the existing outbound signed worker channel. No grant or task is created. */
export class DirectorySelections {
    private pending = new Map<string, Pending>();
    constructor(private store: MetadataStore, private now = Date.now, private timeoutMs = 5000) {}
    async resolve(worker: WorkerRegistration, userID: string, input: z.infer<typeof resolveDirectoriesSchema>) {
        if (userID !== worker.userID || input.machineID !== worker.machineID || input.workerID !== worker.id || !worker.directorySelection) throw new ApiError('SCOPE_DENIED', 403);
        if (this.pending.size >= 32) throw new ApiError('RATE_LIMITED', 429);
        const id = randomUUID();
        return new Promise<{ id: string; directory: string }[]>((resolve, reject) => {
            const job: DirectoryJob = { id, workerID: worker.id, grantID: 'owner-directory-selection', deadline: this.now() + this.timeoutMs,
                command: { method: 'owner.resolve-directories', userID, machineID: worker.machineID, directories: input.directories } };
            this.pending.set(id, { job, delivered: false, resolve, reject, timer: setTimeout(() => {
                this.pending.delete(id); reject(new ApiError('DIRECTORY_WORKER_UNAVAILABLE', 503));
            }, this.timeoutMs) });
        });
    }
    poll(workerID: string) {
        const p = [...this.pending.values()].find(p => p.job.workerID === workerID && !p.delivered && p.job.deadline > this.now());
        if (!p) return null; p.delivered = true; return p.job;
    }
    check(worker: WorkerRegistration, jobID: string) {
        const p = this.pending.get(jobID);
        if (!p || !p.delivered || p.job.deadline <= this.now() || p.job.workerID !== worker.id || p.job.command.userID !== worker.userID || p.job.command.machineID !== worker.machineID) throw new ApiError('JOB_UNAVAILABLE', 403);
        return p;
    }
    result(worker: WorkerRegistration, input: unknown) {
        const body = directoryResultSchema.parse(input), p = this.check(worker, body.jobID);
        if (!!body.error === !!body.projects) throw new ApiError('INVALID_WORKER_RESPONSE', 502);
        // The caller never supplies these bindings. The signed worker result is checked against host policy too.
        if (body.projects && (body.projects.length !== p.job.command.directories.length || body.projects.some(project =>
            !worker.directorySelection || !directoryAllowed(project.directory, worker.directorySelection.roots)
            || project.id !== (worker.projects.find(known => known.directory === project.directory)?.id ?? directoryProjectID(project.directory))))) throw new ApiError('SCOPE_DENIED', 403);
        clearTimeout(p.timer); this.pending.delete(body.jobID);
        if (body.error) p.reject(new ApiError(body.error, 403)); else p.resolve(body.projects!.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    issue(userID: string, clientID: string, worker: WorkerRegistration, projects: { id: string; directory: string }[]) {
        const selectionID = randomUUID(), expiresAt = this.now() + 120000;
        const claimed = this.store.claim(`proof:directory-selection:${selectionID}`, { userID, clientID, workerID: worker.id, machineID: worker.machineID, workerFingerprint: hash(worker.publicKey), projects, expiresAt });
        if (!claimed) throw new ApiError('STORE_UNAVAILABLE', 503);
        return { selectionID, projects, expiresAt };
    }
    consume(selectionID: string, userID: string, clientID: string, worker: WorkerRegistration, projects: { id: string; directory: string }[]) {
        const record = this.store.get<any>(`proof:directory-selection:${selectionID}`);
        if (!record || record.expiresAt <= this.now() || record.userID !== userID || record.clientID !== clientID || record.workerID !== worker.id || record.machineID !== worker.machineID || record.workerFingerprint !== hash(worker.publicKey)
            || canonicalBody(record.projects) !== canonicalBody([...projects].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) throw new ApiError('DIRECTORY_SELECTION_MISMATCH', 403);
        if (!this.store.claim(`proof:directory-used:${selectionID}`, { expiresAt: record.expiresAt })) throw new ApiError('DIRECTORY_SELECTION_REPLAY', 409);
    }
    close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ApiError('DIRECTORY_WORKER_UNAVAILABLE', 503)); } this.pending.clear(); }
}

/** No mkdir, file reads, shell commands or registry mutation; paths are frozen to actual canonical directories. */
export function resolveWorkerDirectories(registration: WorkerRegistration, job: DirectoryJob, now = Date.now) {
    if (job.workerID !== registration.id || job.command.userID !== registration.userID || job.command.machineID !== registration.machineID || job.deadline <= now()) throw new ApiError('SCOPE_DENIED', 403);
    const input = resolveDirectoriesSchema.parse({ workerID: job.workerID, machineID: job.command.machineID, directories: job.command.directories });
    const roots = registration.directorySelection?.roots;
    if (!roots?.length) throw new ApiError('SCOPE_DENIED', 403);
    try {
        if (roots.some(root => realpathSync(root) !== root || !statSync(root).isDirectory())) throw new ApiError('PROJECT_PATH_CHANGED', 403);
        const projects = input.directories.map(path => {
            if (!directoryAllowed(path, roots)) throw new ApiError('SCOPE_DENIED', 403);
            const directory = realpathSync(path);
            if (!directoryAllowed(directory, roots) || !statSync(directory).isDirectory()) throw new ApiError('SCOPE_DENIED', 403);
            return { id: registration.projects.find(p => p.directory === directory)?.id ?? directoryProjectID(directory), directory };
        });
        return selectedProjectsSchema.parse(projects);
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('DIRECTORY_UNAVAILABLE', 403); }
}
