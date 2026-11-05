import { randomUUID } from 'node:crypto';
import { hash } from '../journal';
import { canonicalBody, serviceClientFingerprint } from './auth';
import { ApiError, checkBoundProjects, checkScopeProjects, scopeSchema, serviceScopeSchema, MAX_SERVICE_GRANT_MS, type Connection, type Registration, type ServiceClientRegistration, type Scope, type WorkerRegistration } from './schema';
import { validateGrantOptions } from './options';
import { MetadataStore } from './store';

export class Grants {
    constructor(readonly store: MetadataStore, readonly workers: WorkerRegistration[], private now = Date.now, private maxGrantMs = 3600000, private clients?: Registration[],
        private serviceClients: ServiceClientRegistration[] = [], private maxServiceGrantMs = MAX_SERVICE_GRANT_MS) {}
    create(client: Registration, input: unknown): Connection {
        return this.createBound(client, input, hash(client.publicKey), this.maxGrantMs);
    }
    createService(client: ServiceClientRegistration, input: unknown): Connection {
        return this.createBound(client, input, serviceClientFingerprint(client), this.maxServiceGrantMs, 'service-token-v1');
    }
    private createBound(client: Registration | ServiceClientRegistration, input: unknown, clientFingerprint: string, maxGrantMs: number, credentialMode?: 'service-token-v1'): Connection {
        const parsed = (credentialMode ? serviceScopeSchema : scopeSchema).parse(input), now = this.now();
        const scope = 'projectIDs' in parsed ? { ...parsed, projectIDs: [...parsed.projectIDs].sort(), ...('projects' in parsed ? { projects: [...parsed.projects].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } : {}) } : parsed;
        const worker = this.workers.find(w => w.id === scope.workerID && w.userID === client.userID);
        if (!worker || scope.expiresAt > now + maxGrantMs) throw new ApiError('SCOPE_DENIED', 403);
        const projects = checkScopeProjects(scope, worker, now);
        // A grant can only narrow the worker's owner-configured launch allowlist.
        if (!validateGrantOptions(scope.options, worker.launchOptions)) throw new ApiError('SCOPE_DENIED', 403);
        const binding = 'projectIDs' in scope ? { projects: projects.map(p => ({ id: p.id, directory: p.directory })) } : { projectDirectory: projects[0].directory };
        const workerFingerprint = hash(worker.publicKey);
        const externalIdentity = 'externalIdentity' in client ? client.externalIdentity : undefined;
        const connection: Connection = { ...scope, ...binding, id: randomUUID(), clientID: client.id, userID: client.userID, workerFingerprint,
            ...(externalIdentity ? { externalIdentity } : {}), ...(credentialMode ? { credentialMode } : {}),
            clientName: client.name, clientFingerprint, state: 'pending', createdAt: now, pendingUntil: Math.min(now + 300000, scope.expiresAt),
            challenge: randomUUID(), digest: hash(canonicalBody({ scope, clientID: client.id, userID: client.userID, clientFingerprint, workerFingerprint, ...binding, externalIdentity, ...(credentialMode ? { credentialMode } : {}) })) };
        if (!this.store.claim(`connection:${connection.id}`, connection)) throw new ApiError('STORE_UNAVAILABLE', 503);
        return connection;
    }
    get(id: string): Connection {
        const c = this.store.get<Connection>(`connection:${id}`);
        if (!c) throw new ApiError('NOT_FOUND', 404);
        this.expire(c);
        return c;
    }
    private expire(c: Connection) {
        if (c.state !== 'revoked' && c.state !== 'expired' && (this.now() >= c.expiresAt || (c.state === 'pending' && this.now() >= c.pendingUntil))) {
            c.state = 'expired'; this.store.set(`connection:${c.id}`, c);
        }
    }
    private invalidate(c: Connection, code: string): never {
        c.state = 'revoked'; this.store.set(`connection:${c.id}`, c); throw new ApiError(code, 403);
    }
    private checkClient(c: Connection) {
        if (c.credentialMode === 'service-token-v1') {
            const client = this.serviceClients.find(client => client.id === c.clientID && client.userID === c.userID);
            if (!client || serviceClientFingerprint(client) !== c.clientFingerprint) this.invalidate(c, 'CLIENT_IDENTITY_CHANGED');
        } else {
            const client = this.clients?.find(client => client.id === c.clientID && client.userID === c.userID);
            if (this.clients && (!client || hash(client.publicKey) !== c.clientFingerprint || canonicalBody(client.externalIdentity) !== canonicalBody(c.externalIdentity))) this.invalidate(c, 'CLIENT_IDENTITY_CHANGED');
        }
    }
    owner(id: string, userID: string) {
        const c = this.get(id); if (c.userID !== userID) throw new ApiError('NOT_FOUND', 404); return c;
    }
    approve(id: string, userID: string, digest: string, challenge: string, credentialMode?: 'service-token-v1', scopeVersion?: 2 | 3) {
        const c = this.owner(id, userID), now = this.now();
        if (c.state === 'expired') throw new ApiError('CONNECTION_EXPIRED', 403);
        if (c.state !== 'pending') throw new ApiError('APPROVAL_REPLAY', 409);
        if (now >= c.pendingUntil || now >= c.expiresAt) throw new ApiError('CONNECTION_EXPIRED', 403);
        if (c.credentialMode !== credentialMode) throw new ApiError(c.credentialMode ? 'SERVICE_TOKEN_APPROVAL_UPGRADE_REQUIRED' : 'APPROVAL_BINDING_MISMATCH', c.credentialMode ? 426 : 409);
        if (c.scopeVersion !== scopeVersion) throw new ApiError(c.scopeVersion ? 'PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED' : 'APPROVAL_BINDING_MISMATCH', c.scopeVersion ? 426 : 409);
        if (c.digest !== digest || c.challenge !== challenge) throw new ApiError('APPROVAL_BINDING_MISMATCH', 409);
        this.checkClient(c);
        const worker = this.workers.find(w => w.id === c.workerID && w.userID === userID);
        if (!worker || hash(worker.publicKey) !== c.workerFingerprint) throw new ApiError('WORKER_IDENTITY_CHANGED', 403);
        checkBoundProjects(c, worker, now);
        c.state = 'approved'; this.store.set(`connection:${id}`, c); return this.view(c);
    }
    revoke(id: string, userID: string) {
        const c = this.owner(id, userID); c.state = 'revoked'; this.store.set(`connection:${id}`, c); return this.view(c);
    }
    delete(id: string, userID: string) {
        const c = this.owner(id, userID);
        if (c.state !== 'revoked') throw new ApiError('CONNECTION_NOT_REVOKED', 409);
        this.store.delete(`connection:${id}`);
    }
    active(id: string, clientID?: string) {
        const c = this.get(id);
        if (clientID !== undefined && c.clientID !== clientID) throw new ApiError('SCOPE_DENIED', 403);
        if (c.state === 'revoked') throw new ApiError('GRANT_REVOKED', 403);
        if (c.state === 'expired') throw new ApiError('GRANT_EXPIRED', 403);
        if (c.state !== 'approved') throw new ApiError('GRANT_NOT_APPROVED', 403);
        const worker = this.workers.find(w => w.id === c.workerID && w.userID === c.userID);
        if (!worker || hash(worker.publicKey) !== c.workerFingerprint) this.invalidate(c, 'WORKER_IDENTITY_CHANGED');
        this.checkClient(c);
        try { checkBoundProjects(c, worker, this.now()); }
        catch (error) { if (error instanceof ApiError) this.invalidate(c, error.code); throw error; }
        // Owner allowlist shrinkage revokes grants that can no longer be honoured.
        if (!validateGrantOptions(c.options, worker.launchOptions)) this.invalidate(c, 'SCOPE_DENIED');
        return c;
    }
    checkMethod(c: Pick<Scope, 'methods'>, method: string) { if (!c.methods.includes(method as Scope['methods'][number])) throw new ApiError('SCOPE_DENIED', 403); }
    reconcileRegistrations() {
        for (const c of this.store.list<Connection>('connection:')) if (c.state === 'approved') {
            try { this.active(c.id); }
            catch (error) {
                if (!(error instanceof ApiError)) throw error;
                if (error.code === 'GRANT_EXPIRED') continue;
                if (!['CLIENT_IDENTITY_CHANGED', 'WORKER_IDENTITY_CHANGED', 'PROJECT_BINDING_CHANGED', 'INVALID_PROJECT_SCOPE', 'SCOPE_DENIED'].includes(error.code)) throw error;
                c.state = 'revoked'; this.store.set(`connection:${c.id}`, c);
            }
        }
    }
    view(c: Connection) {
        this.expire(c);
        const { challenge: _challenge, ...view } = c;
        return { ...view, state: c.state === 'revoked' ? 'revoked' : this.now() >= c.expiresAt || (c.state === 'pending' && this.now() >= c.pendingUntil) ? 'expired' : c.state };
    }
}
