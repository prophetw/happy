import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { canonicalBody } from '../rest/auth';
import { createControlMcp } from '../rest/mcp';
import type { ProofClient } from '../rest/client';
import { ApiError, scopeSchema, type ExternalIdentity, type Registration, type Scope } from '../rest/schema';
import type { TokenVerifier } from './oauth';

export type McpBinding = { principal: ExternalIdentity; registration: Registration; client: ProofClient; grantID?: string; scope: Scope };
export type HttpMcpOptions = { resource: string; issuer: string; oauthScope: string; verify: TokenVerifier; bindings: McpBinding[]; allowLoopback?: boolean; now?: () => number };
/** Stateless HTTP MCP; every request gets an immutable authenticated principal/binding/server. */
export function mountHttpMcp(app: FastifyInstance, options: HttpMcpOptions) {
    const resource = new URL(options.resource), path = resource.pathname;
    if (resource.username || resource.password || resource.search || resource.hash || !/^\/happy-control\/mcp$/.test(path)
        || (resource.protocol !== 'https:' && !(options.allowLoopback && resource.hostname === '127.0.0.1'))) throw new ApiError('INVALID_MCP_RESOURCE');
    const now = options.now ?? Date.now, metadataPath = '/.well-known/oauth-protected-resource' + path;
    if (new Set(options.bindings.map(b => canonicalBody(b.principal))).size !== options.bindings.length) throw new ApiError('DUPLICATE_MCP_BINDING');
    for (const b of options.bindings) if (canonicalBody(b.principal) !== canonicalBody(b.registration.externalIdentity)) throw new ApiError('MCP_IDENTITY_BINDING_REQUIRED');
    app.get(metadataPath, async () => ({ resource: options.resource, authorization_servers: [options.issuer], scopes_supported: [options.oauthScope], bearer_methods_supported: ['header'] }));
    app.route({ method: ['GET', 'POST', 'DELETE'], url: path, handler: async (req, reply) => {
        let binding: McpBinding;
        try {
            if (req.headers.origin && req.headers.origin !== resource.origin) throw new ApiError('ORIGIN_DENIED', 403);
            const auth = req.headers.authorization;
            if (!auth?.startsWith('Bearer ')) throw new ApiError('OAUTH_REQUIRED', 401);
            const principal = await options.verify(auth.slice(7));
            const found = options.bindings.find(b => canonicalBody(b.principal) === canonicalBody(principal));
            if (!found) throw new ApiError('MCP_BINDING_DENIED', 403);
            binding = found;
        } catch (e) {
            const status = e instanceof ApiError ? e.status : 401;
            reply.header('WWW-Authenticate', `Bearer resource_metadata="${resource.origin}${metadataPath}", scope="${options.oauthScope}"`);
            return reply.code(status).send({ error: status === 403 ? 'insufficient_scope' : 'invalid_token' });
        }
        const authorize = async (name: string, input: unknown) => {
            if (name === 'happy_request_connection') {
                const scope = scopeSchema.parse(input), max = binding.scope;
                if (scope.workerID !== max.workerID || scope.machineID !== max.machineID || scope.projectID !== max.projectID || scope.expiresAt > max.expiresAt
                    || scope.methods.some(m => !max.methods.includes(m)) || scope.sessionIDs.some(s => !max.sessionIDs.includes(s))) throw new ApiError('SCOPE_DENIED', 403);
                return;
            }
            if (!binding.grantID) throw new ApiError('GRANT_NOT_APPROVED', 403);
            const response = await binding.client.request('GET', `/connections/${binding.grantID}`);
            const c = response?.data, max = binding.scope;
            if (!response.ok || c.state !== 'approved' || c.expiresAt <= now() || c.expiresAt > max.expiresAt || c.userID !== binding.registration.userID
                || c.clientID !== binding.registration.id || canonicalBody(c.externalIdentity) !== canonicalBody(binding.principal)
                || c.workerID !== max.workerID || c.machineID !== max.machineID || c.projectID !== max.projectID
                || c.methods.some((m: Scope['methods'][number]) => !max.methods.includes(m)) || c.sessionIDs.some((s: string) => !max.sessionIDs.includes(s))) throw new ApiError('GRANT_UNAVAILABLE', 403);
        };
        const server = createControlMcp(binding.client, () => binding.grantID ?? '', { authorize });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        try {
            await server.connect(transport);
            // Raw request URL remains intact; proxy MUST NOT strip the path or query.
            reply.hijack();
            reply.raw.on('close', () => { void server.close().catch(() => {}); });
            await transport.handleRequest(req.raw, reply.raw, req.body);
        } catch {
            if (!reply.raw.headersSent) { reply.raw.writeHead(503, { 'content-type': 'application/json' }); reply.raw.end('{"error":"mcp_unavailable"}'); }
            await server.close();
        }
    } });
}
