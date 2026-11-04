import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SignJWT, exportJWK } from 'jose';
import { fixtureRig } from './rest-fixture';
import { mountHttpMcp } from '../src/automation/production/httpMcp';
import { oauthVerifier } from '../src/automation/production/oauth';
import { methods } from '../src/automation/control';

/** Synthetic OAuth + dedicated approval + encrypted relay fixture. No real Happy identity is loaded. */
export async function httpMcpFixture() {
    const principal = { issuer: 'https://issuer.fixture.invalid', subject: 'fixture-assistant', tenant: 'fixture-tenant', oauthClientID: 'fixture-client' };
    const resource = 'https://control.fixture.invalid/happy-control/mcp', r = await fixtureRig({ externalIdentity: principal });
    const app = Fastify({ logger: false }), sdk = new Client({ name: 'fixture-cloud-assistant', version: '1' });
    try {
        const grantID = await r.connect(), pair = generateKeyPairSync('ed25519'), jwk = await exportJWK(pair.publicKey); jwk.kid = 'fixture';
        mountHttpMcp(app, { resource, issuer: principal.issuer, oauthScope: 'happy:control',
            verify: oauthVerifier({ issuer: principal.issuer, jwksURL: principal.issuer+'/jwks', resource, scope: 'happy:control', tenantClaim: 'tenant_id', algorithms: ['EdDSA'] }, { keys: [jwk] }),
            bindings: [{ principal, registration: r.clientRegistration, client: r.client, grantID,
                scope: { workerID: r.registration.id, machineID: r.registration.machineID, projectID: 'projectA', methods: [...methods], sessionIDs: [], expiresAt: Date.now()+120000 } }] });
        const address = await app.listen({ port: 0, host: '127.0.0.1' }); await r.startWorker();
        const token = await new SignJWT({ scope: 'happy:control', tenant_id: principal.tenant, client_id: principal.oauthClientID }).setProtectedHeader({ alg: 'EdDSA', kid: 'fixture' })
            .setIssuer(principal.issuer).setSubject(principal.subject).setAudience(resource).setIssuedAt().setExpirationTime('60s').sign(pair.privateKey);
        await sdk.connect(new StreamableHTTPClientTransport(new URL(address+'/happy-control/mcp'), { requestInit: { headers: { authorization: 'Bearer '+token } } }));
        const result = await sdk.callTool({ name: 'happy_create_task', arguments: { requestID: 'fixture-task', machineID: 'machineA', projectID: 'projectA' } });
        const body = result.structuredContent as any;
        if (body?.ok !== true) throw new Error('FIXTURE_FAILED');
        return { fixture: true, httpMcp: true, signedREST: true, created: body.data.state, realAuth: false, realRegistration: false };
    } finally { await sdk.close(); await app.close(); await r.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) httpMcpFixture().then(result => process.stdout.write(JSON.stringify(result)+'\n')).catch(() => { process.stderr.write('HTTP MCP fixture failed\n'); process.exitCode=1; });
