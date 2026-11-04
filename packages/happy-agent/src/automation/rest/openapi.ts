import { resolveDirectoriesSchema, directoryResultSchema } from './directories';
import { identifier } from './schema';
import { z } from 'zod';
import { approvalSchema, createTaskSchema, mutationSchema, scopeSchema, serviceConnectionSchema, sendSchema, workerPollSchema, workerCheckSchema, workerResultSchema } from './schema';

const response = { type: 'object', required: ['version','ok'], properties: { version: { const: 1 }, ok: { type: 'boolean' }, data: { oneOf: [{ type: 'object' }, { type: 'array' }, { type: 'null' }] }, error: { type: 'object', properties: { code: { type: 'string' }, retryable: { const: false } } } } };
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } };
const page = [{ name: 'cursor', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }];
const events = [{ name: 'after_seq', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }];
const paths: Record<string, Record<string, unknown>> = {};
function operation(path: string, verb: string, operationId: string, security: string, description: string, body?: z.ZodType, parameters: unknown[] = []) {
    (paths[path] ??= {})[verb] = { operationId, description, security: security === 'Public' ? [] : security === 'ClientProof' && !(path === '/connections' && verb === 'post') ? [{ ClientProof: [] }, { ServiceBearer: [] }] : [{ [security]: [] }],
        parameters: [...(path.includes('{id}') ? [idParameter] : []), ...parameters],
        ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(body) } } } } : {}),
        responses: Object.fromEntries([200,202,400,401,403,404,409,413,426,429,503].map(status => [String(status), { description: status === 202 ? 'Mutation outcome uncertain: query the SAME requestID; no automatic redispatch.' : String(status), content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } }])) };
}
operation('/connections','post','requestConnection','ClientProof','Create pending consent only; no access until explicit approval.',scopeSchema);
operation('/connections','get','listConnections','OwnerBearer','Same-origin owner approval UI only; never an automation API credential.');
operation('/connections/{id}','get','connectionStatus','ClientProof','Only the registered client that requested the connection.');
operation('/connections/{id}/consent','get','consent','OwnerBearer','Owner-only immutable scope and key fingerprints, plus approval binding challenge.');
operation('/connections/{id}/approve','post','approve','OwnerBearer','Exact digest/challenge; single use, pending TTL; no account secret transfer. Multi-project scope requires explicit scopeVersion=2 or 3 acknowledgement; v3 paths rechecked with online worker before approval; older approval pages fail with 426.',approvalSchema);
operation('/connections/{id}','delete','revoke','OwnerBearer','Durably revoke future access; does not imply running tasks stopped.');
operation('/service-connections/options','get','serviceOptions','OwnerBearer','Optional service-token-v1: owner registered services and scope. projectScopes=1 plus fresh workers[].projectScopes=1 enables multi-selection; maxProjects is at most 32. directoryScopes=1 and fresh workers[].directoryScopes=1 plus explicit directorySelection.roots enables owner-selected directories. No credentials. Disabled by default.');
operation('/service-connections/resolve-directories','post','resolveDirectories','OwnerBearer','Same-origin owner only. Read-only outbound worker realpath/directory check inside explicit roots on both sides; returns frozen canonical projects and a non-credential selectionID valid for 120 seconds, usable once by this owner/client/worker. Does not create grant/tasks or change configuration. Roots themselves, traversal, missing/files and symlink escape denied.',resolveDirectoriesSchema.extend({clientID:identifier}));
operation('/service-connections','post','requestServiceConnection','OwnerBearer','Optional service-token-v1: pending consent, at most 30 days from creation. Legacy projectID or explicit scopeVersion=2 + 2..32 unique projectIDs (never both). Binds every selected ID/directory, one worker/machine, shared methods/expiry, new sessions by default. V3 accepts 1..32 exact projects/projectIDs only with a fresh owner/client/worker-bound one-use selectionID returned by resolve-directories. Separate bound approval required; existing grants never expand.',serviceConnectionSchema);
operation('/connections/{id}/service-token','post','issueServiceToken','OwnerBearer','Only an approved service-token grant. Delivers one bearer exactly once; stores digest only. Lost response returns ALREADY_ISSUED on retry; revoke/reapprove for replacement. Never log response or share in URL/chat.');
(paths['/connections/{id}/service-token'].post as any).responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/ServiceTokenDelivery' };
operation('/compatibility','get','compatibility','Public','Non-secret protocol/approval compatibility; projectScopes=1 advertises multi-project scope support. Worker protocol stays 1; new workers negotiate before advertising projectScopes=1 in signed polls.');
operation('/capabilities','get','capabilities','ClientProof','Requires an approved grant; core=1, worker=1, auth=ed25519-proof-v1.');
operation('/machines','get','machines','ClientProof','machines.list; grant-bound machine only.',undefined,page);
operation('/sessions','get','sessions','ClientProof','sessions.list; grant-owned new sessions or explicit sessionIDs, in the bound project.',undefined,page);
operation('/tasks','post','createTask','ClientProof','tasks.create; one explicit projectID selected from this grant, creates empty dedicated session. Send text separately with another stable requestID. Idempotency remains grant-wide: reusing one requestID for a different selected project conflicts.',createTaskSchema);
operation('/tasks/{id}','get','taskStatus','ClientProof','sessions.status; taskID is the create requestID within this grant.',undefined,events);
operation('/sessions/{id}/messages','post','send','ClientProof','sessions.send; submitted means relay persistence, not agent consumption.',sendSchema);
operation('/sessions/{id}/cancel','post','cancel','ClientProof','sessions.cancel; cancel_requested does not prove stopped.',mutationSchema);
operation('/sessions/{id}/status','get','status','ClientProof','sessions.status; process and turn evidence separate; absence of evidence means unknown.',undefined,events);
operation('/sessions/{id}/events','get','events','ClientProof','sessions.logs; forward seq cursor with hasMore/nextCursor; redacted projection; server may cap a page at 100 to bound worker result bytes.',undefined,events);
operation('/sessions/{id}/result','get','result','ClientProof','sessions.result; explicit turnID attribution, not inferred send requestID. Page through evidence; ready only on observed terminal event.',undefined,[...events,{ name: 'turnID', in: 'query', required: true, schema: { type: 'string' } }]);
operation('/requests/{id}','get','requestStatus','ClientProof','requests.get; durable receipt lookup without replay; ID namespace stable per client/grant.');
for (const [route, body] of [['poll', workerPollSchema], ['check', workerCheckSchema], ['result', workerResultSchema]] as const) operation(`/worker/${route}`,'post',`worker_${route}`,'WorkerProof','Internal fixed worker channel; pinned identity, live grant checks. Never exposed as an MCP tool.', body);
operation('/worker/directory-check','post','worker_directory_check','WorkerProof','Internal owner-only read request authorization, never an automation tool.',workerCheckSchema);
operation('/worker/directory-result','post','worker_directory_result','WorkerProof','Signed worker canonical directory result; exact allowlist schema, no task content.',directoryResultSchema);
export const openapi = {
    openapi: '3.1.0', info: { title: 'Happy scoped automation control', version: '1.4.0', description: 'Scoped signed REST with optional owner-approved service bearer tokens and explicit multi-project service scopes. HTTP MCP OAuth and relay authentication are unchanged; service bearers do not authenticate MCP, owner or worker endpoints.' },
    servers: [{ url: '/happy-control/v1' }], paths,
    components: { schemas: { Envelope: response, ServiceTokenDelivery: { type: 'object', properties: { version: { const: 1 }, ok: { const: true }, data: { type: 'object', required: ['connectionID','token','expiresAt'], properties: { connectionID: { type: 'string' }, token: { type: 'string', 'x-sensitive': true, description: 'One-time secret delivery, no example. Never persist plaintext or log.' }, expiresAt: { type: 'integer' } } } } } }, securitySchemes: {
        ClientProof: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Ed25519 signedHeaders helper: actor/client ID, grant ID, timestamp, nonce, method, exact path/query and canonical JSON hash. Private key comes from a platform secret provider, never a tool argument.' },
        WorkerProof: { type: 'apiKey', in: 'header', name: 'Authorization', description: 'Same proof format, worker actor and pinned worker public key.' },
        ServiceBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'service-token-v1', description: 'Optional hsvc1 credential supplied from a backend secret store. Bound to one approved service/client/user/grant and original expiry, at most 30 days; no account secret. Never accepted on owner, enrollment, worker or MCP OAuth endpoints.' },
        OwnerBearer: { type: 'http', scheme: 'bearer', description: 'Existing Happy owner authentication used transiently for consent only. Origin or same-origin Fetch Metadata required; cookies do not authenticate.' },
    } },
};
