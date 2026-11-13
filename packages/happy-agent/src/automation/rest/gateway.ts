import Fastify, { type FastifyRequest } from 'fastify';
import { createPublicKey, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { hash } from '../journal';
import { canonicalBody, serviceClientFingerprint, verifyProof } from './auth';
import { DirectorySelections, resolveDirectoriesSchema } from './directories';
import { ServiceTokens, isServiceAuthorization } from './serviceTokens';
import { Grants } from './grants';
import { MetadataStore } from './store';
import { projectResponse } from './projection';
import { openapi } from './openapi';
import { lockGateway } from './gatewayLock';
import { ApiError, cancelSchema, approvalSchema, createTaskSchema, emptyQuerySchema, identifier, mutationSchema, querySchema, sendSchema, serviceConnectionSchema, serviceTokensConfigSchema, scopeProjectIDs, taskOptionsQuerySchema, MAX_SCOPE_PROJECTS, workerPollSchema, workerCheckSchema, workerResultSchema, additionalBrowserOriginsSchema, parseBrowserOrigin, type Connection, type Registration, type WorkerRegistration, type ServiceTokensConfig } from './schema';

export type Intent = { requestID: string; method: string; grantID: string; fingerprint: string; sessionID?: string; state: string };
export type Job = { id: string; workerID: string; grantID: string; command: Record<string, unknown>; deadline: number };
type PendingJob = Job & { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; delivered: boolean };
export type GatewayOptions = {
    directory: string; origin: string; additionalBrowserOrigins?: string[]; clients: Registration[]; workers: WorkerRegistration[];
    verifyOwner: (authorization: string | undefined) => Promise<string>;
    now?: () => number; timeoutMs?: number; maxGrantMs?: number;
    // Mandatory sink. Only a fixed, non-content projection is passed.
    ipRateLimit?: number; httpMcp?: boolean;
    serviceTokens?: ServiceTokensConfig;
    audit: (event: { method: string; principalID?: string; status: number }) => void;
};
const base = '/happy-control/v1';
const failure = (code: string) => ({ version: 1, ok: false, error: { code, retryable: false } });
export function createGateway(options: GatewayOptions) {
    const origin = parseBrowserOrigin(options.origin);
    const parsedAdditionalOrigins = additionalBrowserOriginsSchema.safeParse(options.additionalBrowserOrigins);
    if (!parsedAdditionalOrigins.success) throw new ApiError('INVALID_ORIGIN');
    const additionalBrowserOrigins = new Set(parsedAdditionalOrigins.data), browserOrigins = new Set([origin, ...parsedAdditionalOrigins.data]);
    const registrations = [...options.clients, ...options.workers];
    for (const registration of registrations) {
        identifier.parse(registration.id); identifier.parse(registration.userID);
        if (!registration.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(registration.publicKey).asymmetricKeyType !== 'ed25519') throw new ApiError('INVALID_PUBLIC_REGISTRATION');
    }
    const serviceConfig = options.serviceTokens ? serviceTokensConfigSchema.parse(options.serviceTokens) : undefined;
    const clientIDs = [...options.clients, ...(serviceConfig?.clients ?? [])].map(c => c.id);
    if (new Set(clientIDs).size !== clientIDs.length || new Set(options.workers.map(w => w.id)).size !== options.workers.length) throw new ApiError('DUPLICATE_REGISTRATION');
    const now = options.now ?? Date.now, store = new MetadataStore(`${options.directory}/state`), proofs = new MetadataStore(`${options.directory}/proofs`);
    const unlock = lockGateway(options.directory);
    const grants = new Grants(store, options.workers, now, options.maxGrantMs, options.clients, serviceConfig?.clients, serviceConfig?.maxGrantMs);
    const serviceTokens = serviceConfig ? new ServiceTokens(store, grants, serviceConfig.clients, now) : undefined;
    try { serviceTokens?.validateStore(); grants.reconcileRegistrations(); } catch (error) { unlock(); throw error; }
    const app = Fastify({ logger: false, bodyLimit: 256 * 1024, requestTimeout: 10000 });
    const jobs = new Map<string, PendingJob>(), lastSeen = new Map<string, number>(), projectScopeWorkers = new Set<string>(), directoryScopeWorkers = new Set<string>();
    const directories = new DirectorySelections(proofs, now);
    const principals = new WeakMap<FastifyRequest, string>();
    const counters = new Map<string, { count: number; until: number }>();
    let prunedAt = 0, auditHealthy = true;
    function limit(key: string, max: number) {
        const old = counters.get(key), current = old && old.until > now() ? old : { count: 0, until: now() + 60000 };
        if (++current.count > max) throw new ApiError('RATE_LIMITED', 429); counters.set(key, current);
    }
    app.addHook('onRequest', async (req, reply) => {
        if (now() - prunedAt > 60000) { proofs.pruneExpired(now()); prunedAt = now(); for (const [key, value] of counters) if (value.until < now()) counters.delete(key); }
        if (req.url !== '/livez' && req.url !== '/readyz') limit(`ip:${req.ip}`, options.ipRateLimit ?? 12000);
        const requestOrigin = req.headers.origin;
        if (requestOrigin && !browserOrigins.has(requestOrigin)) throw new ApiError('ORIGIN_DENIED', 403);
        reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
        if (requestOrigin && additionalBrowserOrigins.has(requestOrigin)) {
            reply.header('Access-Control-Allow-Origin', requestOrigin).header('Vary', 'Origin');
            if (req.method === 'OPTIONS' && req.url.startsWith(`${base}/`)) return reply
                .header('Access-Control-Allow-Methods', 'GET, POST, DELETE')
                .header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                .code(204).send();
        }
        // Exact additional origins only. No wildcard CORS or cookies.
    });
    app.addHook('onResponse', async (req, reply) => { try { options.audit({ method: req.routeOptions.url ?? '<unmatched>', principalID: principals.get(req), status: reply.statusCode }); } catch { auditHealthy = false; } });
    app.setErrorHandler((error, _req, reply) => {
        const status = error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : (error as { statusCode?: number })?.statusCode === 413 ? 413 : (error as { statusCode?: number })?.statusCode === 400 ? 400 : 503;
        const code = error instanceof ApiError ? error.code : status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR';
        reply.code(status).send({ ...failure(code), ...(code === 'WORKER_UNAVAILABLE' ? { dispatch: 'not_sent' } : {}) });
    });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(failure('NOT_FOUND')));
    const ok = (data: unknown) => ({ version: 1, ok: true, data });
    const proof = (req: FastifyRequest, kind: 'client' | 'worker') => {
        const auth = verifyProof(req.headers.authorization, kind, req.method, req.raw.url!, req.body,
            kind === 'client' ? options.clients : options.workers, proofs, now());
        if (kind === 'worker' && auth.grantID) throw new ApiError('INVALID_PROOF', 401);
        principals.set(req, `${kind}:${auth.registration.id}`);
        limit(`${kind}:${auth.registration.id}`, kind === 'worker' ? 1200 : 240); return auth;
    };
    async function owner(req: FastifyRequest) {
        if ((req.headers.origin !== undefined && !browserOrigins.has(req.headers.origin))
            || (req.headers.origin === undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new ApiError('OWNER_ORIGIN_REQUIRED', 403);
        // A service credential must never be forwarded to the Happy account verifier/relay.
        if (isServiceAuthorization(req.headers.authorization)) throw new ApiError('OWNER_AUTH_REQUIRED', 401);
        const userID = await options.verifyOwner(req.headers.authorization);
        principals.set(req, `owner:${userID}`); return userID;
    }
    function authenticateService(header: unknown) {
        if (!serviceTokens) throw new ApiError('SERVICE_TOKENS_DISABLED', 401);
        const auth = serviceTokens.authenticate(header);
        limit(`service:${auth.registration.id}`, 240);
        return auth;
    }
    function clientAuth(req: FastifyRequest) {
        if (!isServiceAuthorization(req.headers.authorization)) return proof(req, 'client');
        const auth = authenticateService(req.headers.authorization);
        principals.set(req, `service:${auth.registration.id}`);
        return auth;
    }
    function activeConnection(req: FastifyRequest) {
        const p = clientAuth(req);
        const c = grants.active(p.grantID, p.registration.id);
        if (c.userID !== p.registration.userID) throw new ApiError('SCOPE_DENIED', 403);
        return c;
    }
    function active(req: FastifyRequest, method: string) {
        const c = activeConnection(req);
        grants.checkMethod(c, method); return c;
    }
    const intentKey = (c: Connection, requestID: string) => `intent:${c.id}:${requestID}`;
    function target(c: Connection, sessionID: string) {
        if (!c.sessionIDs.includes(sessionID) && !store.list<Intent>(`intent:${c.id}:`).some(i => i.method === 'tasks.create' && i.sessionID === sessionID)) throw new ApiError('SCOPE_DENIED', 403);
    }
    async function dispatch(c: Connection, command: Record<string, unknown>): Promise<any> {
        grants.active(c.id, c.clientID);
        if ((lastSeen.get(c.workerID) ?? 0) < now() - 5000) throw new ApiError('WORKER_UNAVAILABLE', 503);
        if (c.scopeVersion === 3 && !directoryScopeWorkers.has(c.workerID)) throw new ApiError('WORKER_DIRECTORY_SCOPE_UPGRADE_REQUIRED', 426);
        if (c.scopeVersion !== undefined && !projectScopeWorkers.has(c.workerID)) throw new ApiError('WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED', 426);
        const jobID = randomUUID();
        return new Promise(resolve => {
            const timeout = Math.min(options.timeoutMs ?? 15000, Math.max(1, c.expiresAt - now()));
            const job: PendingJob = { id: jobID, workerID: c.workerID, grantID: c.id, command, deadline: now() + timeout, delivered: false,
                resolve, timer: setTimeout(() => {
                    // Keep delivered jobs briefly: a dispatched OS operation may still finish.
                    if (!job.delivered) jobs.delete(jobID);
                    resolve({ version: 1, ok: false, error: { code: 'UNAVAILABLE_OR_UNKNOWN', retryable: false } });
                }, timeout) };
            jobs.set(jobID, job);
        });
    }
    async function invoke(c: Connection, command: Record<string, unknown>, mutation = false) {
        let intent: Intent | undefined;
        if (mutation) {
            const requestID = identifier.parse(command.requestID), key = intentKey(c, requestID);
            intent = { requestID, method: String(command.method), grantID: c.id, fingerprint: hash(canonicalBody(command)),
                sessionID: typeof command.sessionID === 'string' ? command.sessionID : undefined, state: 'unknown' };
            const previous = store.get<Intent>(key);
            if (previous && previous.fingerprint !== intent.fingerprint) throw new ApiError('REQUEST_ID_CONFLICT', 409);
            if (!previous) store.claim(key, intent);
            else intent = previous;
        }
        const result = await dispatch(c, { version: 1, ...command });
        // Preserve a settled revocation even when permanent record deletion follows it immediately.
        if (result?.error?.code !== 'GRANT_REVOKED') grants.active(c.id, c.clientID); // Revocation during an in-flight call must not return content.
        if (result?.ok === false) {
            const code = typeof result.error?.code === 'string' && /^[A-Z_]+$/.test(result.error.code) ? result.error.code : 'INVALID_WORKER_RESPONSE';
            if (code !== 'UNAVAILABLE_OR_UNKNOWN' || !mutation) {
                const status = code === 'FORBIDDEN' || code === 'SCOPE_DENIED' || code === 'GRANT_REVOKED' || code === 'OPTION_DENIED' ? 403
                    : code === 'NOT_FOUND' ? 404 : code === 'REQUEST_ID_CONFLICT' ? 409 : ['UNSUPPORTED_VERSION', 'WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED', 'WORKER_DIRECTORY_SCOPE_UPGRADE_REQUIRED'].includes(code) ? 426
                    : code === 'UNAVAILABLE_OR_UNKNOWN' ? 503 : 400;
                throw new ApiError(code, status);
            }
        }
        if (result?.ok === true && result.data && typeof result.data === 'object') {
            const requestID = command.requestID;
            const record = typeof requestID === 'string' ? store.get<Intent>(intentKey(c, requestID)) : null;
            if (record) {
                if (typeof result.data.sessionID === 'string') record.sessionID = identifier.parse(result.data.sessionID);
                record.state = typeof result.data.state === 'string' ? result.data.state : 'unknown';
                store.set(intentKey(c, record.requestID), record);
            }
        }
        return result;
    }
    app.post(`${base}/connections`, async req => {
        const p = proof(req, 'client');
        limit(`pair:${p.registration.id}`, 10);
        if (p.grantID) throw new ApiError('INVALID_REQUEST');
        return ok(grants.view(grants.create(p.registration, req.body)));
    });
    app.get(`${base}/connections`, async req => {
        const userID = await owner(req);
        return ok(store.list<Connection>('connection:').filter(c => c.userID === userID).map(c => grants.view(c)));
    });
    app.get<{ Params: { id: string } }>(`${base}/connections/:id`, async req => {
        const p = clientAuth(req), c = grants.get(identifier.parse(req.params.id));
        if (p.registration.id !== c.clientID || p.registration.userID !== c.userID || (isServiceAuthorization(req.headers.authorization) && p.grantID !== c.id)) throw new ApiError('NOT_FOUND', 404);
        return ok(grants.view(c));
    });
    app.get<{ Params: { id: string } }>(`${base}/connections/:id/consent`, async req => {
        const c = grants.owner(identifier.parse(req.params.id), await owner(req));
        return ok({ ...grants.view(c), challenge: c.challenge,
            ...(c.credentialMode === 'service-token-v1' && serviceTokens ? { serviceToken: serviceTokens.metadata(c.id) } : {}),
            workerName: options.workers.find(w => w.id === c.workerID)?.name,
            disclosure: '控制组件可见批准范围内的指令与结果；Happy 账号密钥留在用户机器。撤权不自动停止已运行任务。' });
    });
    app.post<{ Params: { id: string } }>(`${base}/connections/:id/approve`, async req => {
        const userID = await owner(req), body = approvalSchema.parse(req.body);
        const c = grants.owner(identifier.parse(req.params.id), userID);
        if (c.scopeVersion === 3 && c.state === 'pending' && body.scopeVersion === 3 && c.digest === body.digest && c.challenge === body.challenge) {
            const worker = directoryWorker(c.workerID, userID);
            const projects = await directories.resolve(worker, userID, { workerID: worker.id, machineID: worker.machineID, directories: c.projects!.map(p => p.directory) });
            if (canonicalBody(projects) !== canonicalBody(c.projects)) throw new ApiError('PROJECT_PATH_CHANGED', 403);
        }
        return ok(grants.approve(identifier.parse(req.params.id), userID, body.digest, body.challenge, body.credentialMode, body.scopeVersion));
    });
    function revokeJobs(grantID: string) {
        for (const [jobID, job] of jobs) if (job.grantID === grantID) { clearTimeout(job.timer); jobs.delete(jobID); job.resolve(failure('GRANT_REVOKED')); }
    }
    app.delete<{ Params: { id: string } }>(`${base}/connections/:id`, async req => {
        const id = identifier.parse(req.params.id), revoked = grants.revoke(id, await owner(req));
        revokeJobs(id);
        return ok(revoked);
    });
    app.delete<{ Params: { id: string } }>(`${base}/connections/:id/record`, async req => {
        const id = identifier.parse(req.params.id), userID = await owner(req);
        grants.revoke(id, userID);
        revokeJobs(id);
        ServiceTokens.delete(store, id);
        grants.delete(id, userID);
        return ok({ deleted: true });
    });
    app.get(`${base}/service-connections/options`, async req => {
        const userID = await owner(req);
        if (!serviceConfig) throw new ApiError('SERVICE_TOKENS_DISABLED', 404);
        return ok({ protocol: 1, maxGrantMs: serviceConfig.maxGrantMs, projectScopes: 1, maxProjects: MAX_SCOPE_PROJECTS, directoryScopes: 1,
            clients: serviceConfig.clients.filter(c => c.userID === userID).map(c => ({ id: c.id, name: c.name, fingerprint: serviceClientFingerprint(c) })),
            workers: options.workers.filter(w => w.userID === userID).map(w => ({ id: w.id, name: w.name, machineID: w.machineID, methods: w.methods, projects: w.projects,
                directorySelection: w.directorySelection, directoryScopes: directoryScopeWorkers.has(w.id) && (lastSeen.get(w.id) ?? 0) >= now() - 5000 ? 1 : undefined,
                projectScopes: projectScopeWorkers.has(w.id) && (lastSeen.get(w.id) ?? 0) >= now() - 5000 ? 1 : undefined })) });
    });
    function directoryWorker(id: string, userID: string) {
        const worker = options.workers.find(w => w.id === id && w.userID === userID);
        if (!worker?.directorySelection) throw new ApiError('SCOPE_DENIED', 403);
        if ((lastSeen.get(id) ?? 0) < now() - 5000) throw new ApiError('WORKER_UNAVAILABLE', 503);
        if (!directoryScopeWorkers.has(id)) throw new ApiError('WORKER_DIRECTORY_SCOPE_UPGRADE_REQUIRED', 426);
        return worker;
    }
    app.post(`${base}/service-connections/resolve-directories`, async req => {
        const userID = await owner(req);
        if (!serviceConfig) throw new ApiError('SERVICE_TOKENS_DISABLED', 404);
        limit(`directory-select:${userID}`, 30);
        const { clientID, ...input } = resolveDirectoriesSchema.extend({ clientID: identifier }).parse(req.body);
        if (!serviceConfig.clients.some(c => c.id === clientID && c.userID === userID)) throw new ApiError('SCOPE_DENIED', 403);
        const worker = directoryWorker(input.workerID, userID);
        const projects = await directories.resolve(worker, userID, input);
        return ok(directories.issue(userID, clientID, worker, projects));
    });
    app.post(`${base}/service-connections`, async req => {
        const userID = await owner(req);
        if (!serviceConfig) throw new ApiError('SERVICE_TOKENS_DISABLED', 404);
        limit(`service-pair:${userID}`, 10);
        const parsed = serviceConnectionSchema.parse(req.body);
        const { clientID, ...requested } = parsed;
        if ('expiresInMs' in requested && requested.expiresInMs > serviceConfig.maxGrantMs) throw new ApiError('SCOPE_DENIED', 403);
        // Resolve duration once against the server clock; never trust a browser's wall clock.
        const scope = 'expiresInMs' in requested
            ? (({ expiresInMs, ...bound }) => ({ ...bound, expiresAt: now() + expiresInMs }))(requested)
            : requested;
        const client = serviceConfig.clients.find(c => c.id === clientID && c.userID === userID);
        if (!client) throw new ApiError('SCOPE_DENIED', 403);
        if ('selectionID' in scope) {
            const worker = directoryWorker(scope.workerID, userID);
            if (scope.machineID !== worker.machineID) throw new ApiError('SCOPE_DENIED', 403);
            directories.consume(scope.selectionID, userID, clientID, worker, scope.projects);
            const { selectionID: _selection, ...bound } = scope;
            return ok(grants.view(grants.createService(client, bound)));
        }
        return ok(grants.view(grants.createService(client, scope)));
    });
    app.post<{ Params: { id: string } }>(`${base}/connections/:id/service-token`, async req => {
        const userID = await owner(req);
        if (!serviceTokens) throw new ApiError('SERVICE_TOKENS_DISABLED', 404);
        if (req.body !== undefined && (typeof req.body !== 'object' || req.body === null || Object.keys(req.body).length)) throw new ApiError('INVALID_REQUEST');
        limit(`service-issue:${userID}`, 10);
        return ok(serviceTokens.issue(identifier.parse(req.params.id), userID));
    });
    app.get('/livez', async () => ok({ live: true }));
    app.get('/readyz', async (_req, reply) => {
        try { store.list('connection:'); proofs.list('proof:'); serviceTokens?.validateStore(); if (!auditHealthy) throw new Error(); return ok({ ready: true, protocol: 1 }); }
        catch { return reply.code(503).send(failure('NOT_READY')); }
    });
    app.get(`${base}/compatibility`, async () => ok({ protocol: 1, worker: 1, core: 1, approval: 1, projectScopes: 1, directoryScopes: 1, httpMcp: options.httpMcp ? 'streamable-http' : null, auth: 'ed25519-proof-v1',
        serviceTokens: serviceConfig ? { protocol: 1, maxGrantMs: serviceConfig.maxGrantMs, oneTimeDelivery: true } : null }));
    app.get(`${base}/openapi.json`, async () => openapi);
    app.get(`${base}/capabilities`, async req => { await invoke(active(req, 'machines.list'), { method: 'machines.list', limit: 1 }); return ok({ protocol: 1, auth: 'ed25519-proof-v1', worker: 1, core: 1, offlineQueue: false }); });
    app.get(`${base}/machines`, async req => invoke(active(req, 'machines.list'), { method: 'machines.list', ...querySchema.parse(req.query) }));
    app.get(`${base}/projects`, async req => {
        const c = activeConnection(req); emptyQuerySchema.parse(req.query);
        const projects = c.projects ?? [{ id: c.projectID!, directory: c.projectDirectory! }];
        return ok({ projects: projects.map(p => ({ projectID: p.id, directory: p.directory })) });
    });
    app.get(`${base}/options`, async req => {
        const c = active(req, 'options.list'), query = taskOptionsQuerySchema.parse(req.query);
        if (query.machineID !== c.machineID) throw new ApiError('SCOPE_DENIED', 403);
        return invoke(c, { method: 'options.list', machineID: query.machineID });
    });
    app.get(`${base}/sessions`, async req => invoke(active(req, 'sessions.list'), { method: 'sessions.list', ...querySchema.parse(req.query) }));
    app.post(`${base}/tasks`, async (req, reply) => {
        const c = active(req, 'tasks.create'), body = createTaskSchema.parse(req.body);
        if (body.machineID !== c.machineID || !scopeProjectIDs(c).includes(body.projectID)) throw new ApiError('SCOPE_DENIED', 403);
        const result = await invoke(c, { method: 'tasks.create', requestID: body.requestID, machineID: c.machineID, projectID: body.projectID,
            ...(body.title ? { title: body.title } : {}), ...(body.options ? { options: body.options } : {}), ...(body.execution ? { execution: body.execution } : {}) }, true);
        return reply.code(result?.ok ? 200 : result?.error?.code === 'UNAVAILABLE_OR_UNKNOWN' ? 202 : 400).send(result);
    });
    for (const [suffix, methodName] of [['messages', 'sessions.send'], ['cancel', 'sessions.cancel']] as const) {
        app.post<{ Params: { id: string } }>(`${base}/sessions/:id/${suffix}`, async (req, reply) => {
            const c = active(req, methodName), sessionID = identifier.parse(req.params.id); target(c, sessionID);
            const body = methodName === 'sessions.send' ? sendSchema.parse(req.body) : cancelSchema.parse(req.body);
            const result = await invoke(c, { method: methodName, sessionID, ...body }, true);
            return reply.code(result?.ok ? 200 : result?.error?.code === 'UNAVAILABLE_OR_UNKNOWN' ? 202 : 400).send(result);
        });
    }
    for (const [suffix, methodName] of [['status', 'sessions.status'], ['events', 'sessions.logs'], ['result', 'sessions.result']] as const) {
        app.get<{ Params: { id: string } }>(`${base}/sessions/:id/${suffix}`, async req => {
            const c = active(req, methodName), sessionID = identifier.parse(req.params.id); target(c, sessionID);
            return invoke(c, { method: methodName, sessionID, ...querySchema.parse(req.query) });
        });
    }
    app.get<{ Params: { id: string } }>(`${base}/tasks/:id`, async req => {
        const c = active(req, 'sessions.status'), taskID = identifier.parse(req.params.id);
        const intent = store.get<Intent>(intentKey(c, taskID));
        if (!intent || intent.method !== 'tasks.create') throw new ApiError('NOT_FOUND', 404);
        return invoke(c, { method: 'sessions.status', taskID, ...querySchema.parse(req.query) });
    });
    app.get<{ Params: { id: string } }>(`${base}/requests/:id`, async req => {
        const c = active(req, 'requests.get'), requestID = identifier.parse(req.params.id);
        if (!store.get<Intent>(intentKey(c, requestID))) throw new ApiError('NOT_FOUND', 404);
        return invoke(c, { method: 'requests.get', requestID });
    });
    app.post(`${base}/worker/poll`, async req => {
        const p = proof(req, 'worker'), registration = p.registration as WorkerRegistration;
        if ((req.body as any)?.protocol !== 1 || registration.protocol !== 1) throw new ApiError('UNSUPPORTED_PROTOCOL', 426);
        const body = workerPollSchema.parse(req.body);
        lastSeen.set(registration.id, now());
        if (body.projectScopes === 1) projectScopeWorkers.add(registration.id); else projectScopeWorkers.delete(registration.id);
        if (body.directoryScopes === 1 && registration.directorySelection) directoryScopeWorkers.add(registration.id); else directoryScopeWorkers.delete(registration.id);
        if (body.busy) return ok(null);
        if (body.directoryScopes === 1) { const selection = directories.poll(registration.id); if (selection) return ok(selection); }
        for (const [id, job] of jobs) if (job.deadline + 120000 < now()) { clearTimeout(job.timer); jobs.delete(id); }
        const job = [...jobs.values()].find(j => j.workerID === registration.id && !j.delivered && j.deadline > now());
        if (!job) return ok(null);
        try { grants.active(job.grantID); } catch (error) {
            if (!(error instanceof ApiError) || !['GRANT_REVOKED', 'GRANT_EXPIRED', 'GRANT_NOT_APPROVED'].includes(error.code)) throw error;
            jobs.delete(job.id); clearTimeout(job.timer); job.resolve(failure(error.code)); return ok(null);
        }
        if (grants.get(job.grantID).scopeVersion === 3 && body.directoryScopes !== 1) {
            jobs.delete(job.id); clearTimeout(job.timer); job.resolve(failure('WORKER_DIRECTORY_SCOPE_UPGRADE_REQUIRED')); return ok(null);
        }
        if (grants.get(job.grantID).scopeVersion !== undefined && body.projectScopes !== 1) {
            jobs.delete(job.id); clearTimeout(job.timer); job.resolve(failure('WORKER_PROJECT_SCOPE_UPGRADE_REQUIRED')); return ok(null);
        }
        job.delivered = true;
        return ok({ id: job.id, workerID: job.workerID, grantID: job.grantID, command: job.command, deadline: job.deadline });
    });
    app.post(`${base}/worker/directory-check`, async req => {
        const p = proof(req, 'worker'), id = workerCheckSchema.parse(req.body).jobID;
        return ok(directories.check(p.registration as WorkerRegistration, id).job);
    });
    app.post(`${base}/worker/directory-result`, async req => {
        const p = proof(req, 'worker'); directories.result(p.registration as WorkerRegistration, req.body); return ok({ accepted: true });
    });
    // Queue authorization outlives the short-lived transport job, never the grant.
    app.post(`${base}/worker/authorize`, async req => {
        const p = proof(req, 'worker'), body = req.body as Record<string, unknown>;
        if (!body || Object.keys(body).some(k => k !== 'grantID')) throw new ApiError('INVALID_REQUEST');
        const c = grants.active(identifier.parse(body.grantID));
        if (c.workerID !== p.registration.id || c.userID !== p.registration.userID) throw new ApiError('SCOPE_DENIED', 403);
        return ok(c);
    });
    app.post(`${base}/worker/check`, async req => {
        const p = proof(req, 'worker'), id = workerCheckSchema.parse(req.body).jobID, job = jobs.get(id);
        if (!job || job.workerID !== p.registration.id || !job.delivered) throw new ApiError('JOB_UNAVAILABLE', 403);
        const c = grants.active(job.grantID);
        if (c.userID !== p.registration.userID || c.workerID !== p.registration.id) throw new ApiError('SCOPE_DENIED', 403);
        return ok(c);
    });
    app.post(`${base}/worker/result`, { bodyLimit: 32 * 1024 * 1024 }, async req => {
        const p = proof(req, 'worker'), body = workerResultSchema.parse(req.body), job = jobs.get(body.jobID);
        if (!job || job.workerID !== p.registration.id || !job.delivered) throw new ApiError('JOB_UNAVAILABLE', 403);
        grants.active(job.grantID);
        const result = projectResponse(body.result);
        clearTimeout(job.timer); jobs.delete(job.id); job.resolve(result); return ok({ accepted: true });
    });
    app.addHook('onClose', async () => { for (const job of jobs.values()) { clearTimeout(job.timer); job.resolve(failure('UNAVAILABLE_OR_UNKNOWN')); } jobs.clear(); directories.close(); directoryScopeWorkers.clear(); lastSeen.clear(); projectScopeWorkers.clear(); unlock(); });
    return { app, grants, store, authenticateService };
}
