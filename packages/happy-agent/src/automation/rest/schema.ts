import { z } from 'zod';
import { posix } from 'node:path';
import { hash } from '../journal';
import { methods } from '../control';
import { executionSchema } from './execution';
import { taskOptionsSchema, connectionOptionsSchema, launchOptionsPolicySchema } from './options';

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const method = z.enum(methods);
export const scopeSchema = z.object({
    workerID: identifier, machineID: identifier, projectID: identifier,
    methods: z.array(method).min(1).max(16).refine(a => new Set(a).size === a.length),
    sessionIDs: z.array(identifier).max(100).default([]),
    expiresAt: z.number().int().positive(),
    /** Requested launch-option subset; the grant can only narrow the worker allowlist. */
    options: connectionOptionsSchema.optional(),
}).strict();
export type Scope = z.infer<typeof scopeSchema>;
export const MAX_SCOPE_PROJECTS = 32;
export const multiProjectScopeSchema = scopeSchema.omit({ projectID: true }).extend({
    scopeVersion: z.literal(2),
    projectIDs: z.array(identifier).min(2).max(MAX_SCOPE_PROJECTS).refine(ids => new Set(ids).size === ids.length),
}).strict();
export const directoryPath = z.string().min(2).max(4096).refine(p => p.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(p) && posix.normalize(p) === p && !p.endsWith('/'));
export const directorySelectionSchema = z.object({ roots: z.array(directoryPath).min(1).max(32).refine(a => new Set(a).size === a.length) }).strict();
export const selectedProjectSchema = z.object({ id: identifier, directory: directoryPath }).strict();
export const selectedProjectsSchema = z.array(selectedProjectSchema).min(1).max(MAX_SCOPE_PROJECTS).refine(a => new Set(a.map(p => p.id)).size === a.length && new Set(a.map(p => p.directory)).size === a.length);
export const directoryScopeSchema = multiProjectScopeSchema.extend({ scopeVersion: z.literal(3), projectIDs: z.array(identifier).min(1).max(MAX_SCOPE_PROJECTS).refine(a => new Set(a).size === a.length), projects: selectedProjectsSchema, sessionIDs: z.array(identifier).max(0).default([]) }).strict();
export const serviceScopeSchema = z.union([scopeSchema, multiProjectScopeSchema, directoryScopeSchema]);
export function beneathRoot(directory: string, root: string) { return directoryPath.safeParse(directory).success && directoryPath.safeParse(root).success && directory.startsWith(root + '/'); }
export function directoryAllowed(directory: string, roots: string[]) { return !roots.includes(directory) && roots.some(root => beneathRoot(directory, root)); }
export function directoryProjectID(directory: string) { return 'dir_' + hash(directory); }
export const externalIdentitySchema = z.object({ issuer: z.string().url().max(2048), subject: z.string().min(1).max(256), tenant: z.string().min(1).max(256), oauthClientID: z.string().min(1).max(256) }).strict();
export type ExternalIdentity = z.infer<typeof externalIdentitySchema>;
export type Registration = { id: string; userID: string; name: string; publicKey: string; externalIdentity?: ExternalIdentity };
export const serviceClientSchema = z.object({ id: identifier, userID: identifier, name: z.string().min(1).max(128), generation: identifier }).strict();
export type ServiceClientRegistration = z.infer<typeof serviceClientSchema>;
export const MAX_SERVICE_GRANT_MS = 30 * 24 * 3600000;
export const serviceTokensConfigSchema = z.object({ clients: z.array(serviceClientSchema).min(1),
    maxGrantMs: z.number().int().min(1000).max(MAX_SERVICE_GRANT_MS).default(MAX_SERVICE_GRANT_MS) }).strict();
export type ServiceTokensConfig = z.input<typeof serviceTokensConfigSchema>;
const serviceDurationMs = z.number().int().positive();
export const serviceConnectionSchema = z.union([
    scopeSchema.extend({ clientID: identifier }).strict(),
    multiProjectScopeSchema.extend({ clientID: identifier }).strict(),
    directoryScopeSchema.extend({ clientID: identifier, selectionID: identifier }).strict(),
    scopeSchema.omit({ expiresAt: true }).extend({ clientID: identifier, expiresInMs: serviceDurationMs }).strict(),
    multiProjectScopeSchema.omit({ expiresAt: true }).extend({ clientID: identifier, expiresInMs: serviceDurationMs }).strict(),
    directoryScopeSchema.omit({ expiresAt: true }).extend({ clientID: identifier, selectionID: identifier, expiresInMs: serviceDurationMs }).strict(),
]);
export type WorkerRegistration = Registration & {
    machineID: string; projects: { id: string; directory: string; sessionIDs: string[] }[];
    methods: string[]; protocol: 1; directorySelection?: z.infer<typeof directorySelectionSchema>;
    /** Owner-configured launch allowlist for delegated tasks on this machine. */
    launchOptions?: z.infer<typeof launchOptionsPolicySchema>;
    maxConcurrency?: number;
    projectConcurrency?: number;
    machineConcurrency?: number | null;
    projectConcurrencyOverrides?: Record<string, number>;
};
export type Connection = Omit<Scope, 'projectID'> & {
    projectID?: string; projectDirectory?: string;
    scopeVersion?: 2 | 3; projectIDs?: string[]; projects?: { id: string; directory: string }[];
    id: string; clientID: string; userID: string; clientName: string; clientFingerprint: string; workerFingerprint: string;
    externalIdentity?: ExternalIdentity;
    credentialMode?: 'service-token-v1';
    /** Owner-approved launch-option subset. Absent = worker allowlist only. */
    options?: z.infer<typeof connectionOptionsSchema>;
    state: 'pending' | 'approved' | 'revoked' | 'expired'; createdAt: number; pendingUntil: number;
    digest: string; challenge: string;
};
export const approvalSchema = z.object({ digest: z.string().length(64), challenge: identifier, credentialMode: z.literal('service-token-v1').optional(), scopeVersion: z.union([z.literal(2), z.literal(3)]).optional() }).strict();
export const mutationSchema = z.object({ requestID: identifier }).strict();
export const taskTitleSchema = z.string().trim().min(1).max(200);
export const createTaskSchema = mutationSchema.extend({ machineID: identifier, projectID: identifier, title: taskTitleSchema.optional(), options: taskOptionsSchema.optional(), execution: executionSchema.optional() }).strict();
export const cancelSchema = mutationSchema.extend({ sendRequestID: identifier.optional() }).strict();
export const sendSchema = mutationSchema.extend({ text: z.string().min(1).max(100000) }).strict();
export const taskOptionsQuerySchema = z.object({ machineID: identifier }).strict();
export const workerPollSchema = z.object({ protocol: z.literal(1), busy: z.boolean().optional(), projectScopes: z.literal(1).optional(), directoryScopes: z.literal(1).optional() }).strict();
export const workerCheckSchema = z.object({ jobID: identifier }).strict();
export const workerResultSchema = workerCheckSchema.extend({ result: z.unknown() }).strict();
export const emptyQuerySchema = z.object({}).strict();
export const querySchema = z.object({
    cursor: z.string().max(256).optional(), after_seq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100), turnID: identifier.optional(),
}).strict().refine(q => !(q.cursor !== undefined && q.after_seq !== undefined));
export class ApiError extends Error {
    constructor(readonly code: string, readonly status = 400) { super(code); }
}
const loopbackHttpOrigin = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;
export function parseBrowserOrigin(value: string): string {
    try {
        const origin = new URL(value).origin;
        if (origin === value && (new URL(origin).protocol === 'https:' || loopbackHttpOrigin.test(origin))) return origin;
    } catch { /* Normalize every malformed or unsafe origin to the public configuration error. */ }
    throw new ApiError('INVALID_ORIGIN');
}
export const browserOriginSchema = z.string().max(2048).refine(value => {
    try { parseBrowserOrigin(value); return true; } catch { return false; }
});
export const additionalBrowserOriginsSchema = z.array(browserOriginSchema).max(16)
    .refine(values => new Set(values).size === values.length).default([]);
export function checkScope(scope: Scope, worker: WorkerRegistration, now: number) {
    return checkScopeProjects(scope, worker, now)[0];
}
/** Legacy scope stays single-project. A v2 scope must name every project explicitly. */
export function scopeProjectIDs(scope: Pick<Connection, 'projectID' | 'projectIDs' | 'scopeVersion'>): string[] {
    if (scope.scopeVersion === undefined && typeof scope.projectID === 'string' && scope.projectIDs === undefined) return [scope.projectID];
    if ((scope.scopeVersion === 2 || scope.scopeVersion === 3) && scope.projectID === undefined && Array.isArray(scope.projectIDs)
        && scope.projectIDs.length >= (scope.scopeVersion === 3 ? 1 : 2) && scope.projectIDs.length <= MAX_SCOPE_PROJECTS
        && scope.projectIDs.every(id => identifier.safeParse(id).success) && new Set(scope.projectIDs).size === scope.projectIDs.length) return scope.projectIDs;
    throw new ApiError('INVALID_PROJECT_SCOPE', 403);
}
export function checkScopeProjects(scope: Omit<Scope, 'projectID'> & Pick<Connection, 'projectID' | 'projectIDs' | 'scopeVersion' | 'projects'>, worker: WorkerRegistration, now: number) {
    if (scope.expiresAt <= now) throw new ApiError('GRANT_EXPIRED', 403);
    if (scope.workerID !== worker.id || scope.machineID !== worker.machineID
        || scope.methods.some(m => !worker.methods.includes(m))) throw new ApiError('SCOPE_DENIED', 403);
    if (scope.scopeVersion === 3) {
        const projects = selectedProjectsSchema.parse(scope.projects), ids = scopeProjectIDs(scope);
        if (!worker.directorySelection || scope.sessionIDs.length || projects.length !== ids.length
            || projects.some((p, i) => p.id !== ids[i] || !directoryAllowed(p.directory, worker.directorySelection!.roots)
                || (worker.projects.some(known => known.id === p.id) ? worker.projects.filter(known => known.id === p.id && known.directory === p.directory).length !== 1 || worker.projects.filter(known => known.id === p.id).length !== 1 : p.id !== directoryProjectID(p.directory)))) throw new ApiError('SCOPE_DENIED', 403);
        return projects.map(p => ({ ...p, sessionIDs: [] as string[] }));
    }
    const projects = scopeProjectIDs(scope).map(id => {
        const matches = worker.projects.filter(p => p.id === id);
        if (matches.length !== 1) throw new ApiError('SCOPE_DENIED', 403);
        return matches[0];
    });
    if (scope.sessionIDs.some(s => !projects.some(p => p.sessionIDs.includes(s)))) throw new ApiError('SCOPE_DENIED', 403);
    return projects;
}
/** Check the complete frozen ID->directory binding on approval and every execution. */
export function checkBoundProjects(connection: Connection, worker: WorkerRegistration, now: number) {
    const projects = checkScopeProjects(connection, worker, now);
    if (connection.scopeVersion === 2 || connection.scopeVersion === 3) {
        if (connection.projectDirectory !== undefined || connection.projects?.length !== projects.length
            || projects.some((p, i) => connection.projects![i].id !== p.id || connection.projects![i].directory !== p.directory)) throw new ApiError('PROJECT_BINDING_CHANGED', 403);
    } else if (connection.projects !== undefined || projects[0].directory !== connection.projectDirectory) throw new ApiError('PROJECT_BINDING_CHANGED', 403);
    return projects;
}
