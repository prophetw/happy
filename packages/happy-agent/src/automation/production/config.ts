import { z } from 'zod';
import { directorySelectionSchema, externalIdentitySchema, identifier, method, scopeSchema, serviceTokensConfigSchema } from '../rest/schema';
import { launchOptionsPolicySchema } from '../rest/options';
import { privateRead } from '../rest/privateFs';

const https = z.string().url().refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; }, 'HTTPS endpoint required');
const absolute = z.string().startsWith('/').max(4096);
const publicKey = z.string().startsWith('-----BEGIN PUBLIC KEY-----').max(4096);
export const registrationSchema = z.object({ id: identifier, userID: identifier, name: z.string().min(1).max(128), publicKey, externalIdentity: externalIdentitySchema.optional() }).strict();
export const workerRegistrationSchema = registrationSchema.extend({ machineID: identifier, directorySelection: directorySelectionSchema.optional(), projects: z.array(z.object({ id: identifier, directory: absolute, sessionIDs: z.array(identifier).max(100) }).strict()).min(1), methods: z.array(method).min(1), protocol: z.literal(1),
    // Owner-approved launch allowlist for delegated tasks. Absent = fixed
    // defaults only; any requested override is denied.
    launchOptions: launchOptionsPolicySchema.optional() }).strict();
const provider = z.object({ type: z.literal('encrypted-pkcs8-credentials'), credentialsDirectory: absolute,
    keys: z.record(identifier, z.object({ encryptedPKCS8: absolute, passphraseCredential: identifier }).strict()) }).strict();
const oauth = z.object({ issuer: https, jwksURL: https, resource: https.refine(s => new URL(s).pathname === '/happy-control/mcp'), scope: z.literal('happy:control'),
    tenantClaim: identifier.default('tenant_id'), algorithms: z.array(z.enum(['RS256', 'ES256', 'EdDSA'])).min(1).max(3) }).strict();
export const hostConfigSchema = z.object({ version: z.literal(1), role: z.literal('host'),
    listen: z.object({ host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535) }).strict(),
    origin: https.refine(s => new URL(s).origin === s), relayURL: https, stateDirectory: absolute,
    clients: z.array(registrationSchema), workers: z.array(workerRegistrationSchema),
    // Default remains one hour. A longer finite policy still requires exact owner approval.
    maxGrantMs: z.number().int().min(1000).max(7 * 24 * 3600000).default(3600000),
    serviceTokens: serviceTokensConfigSchema.optional(),
    ipRateLimit: z.number().int().min(1000).max(100000).default(12000),
    secrets: provider.optional(),
    mcp: z.object({ oauth, controlURL: https.refine(s => new URL(s).pathname === '/happy-control/v1'),
        bindings: z.array(z.object({ principal: externalIdentitySchema, clientID: identifier, identityRef: identifier, grantID: identifier.optional(), scope: scopeSchema }).strict()).min(1) }).strict().optional(),
}).strict().superRefine((c, ctx) => {
    if (c.mcp && (!c.secrets || new URL(c.mcp.oauth.resource).origin !== c.origin || new URL(c.mcp.controlURL).origin !== c.origin)) ctx.addIssue({ code: 'custom', message: 'MCP requires explicit provider and same-origin control/resource' });
});
export const workerConfigSchema = z.object({ version: z.literal(1), role: z.literal('worker'), endpoint: https.refine(s => new URL(s).pathname === '/happy-control/v1'),
    relayURL: https, happyHomeDirectory: absolute, identityRef: identifier, registration: workerRegistrationSchema, secrets: provider }).strict();
/** An internal REST adapter, not an account login or general HTTP/shell launcher. */
export const callerConfigSchema = z.object({ version: z.literal(1), role: z.literal('caller'),
    endpoint: https.refine(s => new URL(s).pathname === '/happy-control/v1'),
    registration: registrationSchema, identityRef: identifier, grantID: identifier.optional(),
    connectionScope: scopeSchema.optional(), secrets: provider }).strict().superRefine((c, ctx) => {
        if (!c.grantID && !c.connectionScope) ctx.addIssue({ code: 'custom', message: 'Explicit grant or connection scope required' });
    });
export type HostConfig = z.infer<typeof hostConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type CallerConfig = z.infer<typeof callerConfigSchema>;
export function readProductionConfig(path: string) {
    const raw = JSON.parse(privateRead(path, 256 * 1024).toString('utf8'));
    if (raw.role === 'caller') return callerConfigSchema.parse(raw);
    return raw.role === 'worker' ? workerConfigSchema.parse(raw) : hostConfigSchema.parse(raw);
}
