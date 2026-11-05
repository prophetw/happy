import { createGateway } from '../rest/gateway';
import { happyOwnerVerifier } from '../rest/auth';
import { ProofClient } from '../rest/client';
import { ApiError } from '../rest/schema';
import { hostConfigSchema, type HostConfig } from './config';
import { EncryptedCredentialProvider, type SecretProvider } from './secrets';
import { mountHttpMcp } from './httpMcp';
import { oauthVerifier } from './oauth';

/** All validation/provider checks precede listen. Imported libraries never start a server. */
export async function prepareHost(input: HostConfig, audit: Parameters<typeof createGateway>[0]['audit'], injectedProvider?: SecretProvider) {
    const config = hostConfigSchema.parse(input);
    const provider = injectedProvider ?? (config.secrets ? new EncryptedCredentialProvider(config.secrets.keys, config.secrets.credentialsDirectory) : undefined);
    let gateway: ReturnType<typeof createGateway> | undefined;
    try {
        const bindings = await Promise.all((config.mcp?.bindings ?? []).map(async b => {
            const registration = config.clients.find(c => c.id === b.clientID);
            if (!registration || !provider) throw new ApiError('MCP_REGISTRATION_REQUIRED');
            const identity = await provider.identity(b.identityRef, b.clientID, registration.publicKey);
            return { ...b, registration, client: new ProofClient(config.mcp!.controlURL, identity, 'client') };
        }));
        gateway = createGateway({ directory: config.stateDirectory, origin: config.origin, additionalBrowserOrigins: config.additionalBrowserOrigins, clients: config.clients, workers: config.workers,
            httpMcp: !!config.mcp, maxGrantMs: config.maxGrantMs, serviceTokens: config.serviceTokens, ipRateLimit: config.ipRateLimit, verifyOwner: happyOwnerVerifier(config.relayURL), audit });
        if (config.mcp) mountHttpMcp(gateway.app, { resource: config.mcp.oauth.resource, issuer: config.mcp.oauth.issuer,
            oauthScope: config.mcp.oauth.scope, verify: oauthVerifier(config.mcp.oauth), bindings });
        // Readiness validates store/proofs/audit; it intentionally does not require a grant (bootstrap).
        gateway.app.addHook('onClose', async () => { await provider?.close(); });
        await gateway.app.ready();
        return gateway;
    } catch (error) {
        await gateway?.app.close(); await provider?.close();
        // Operator diagnostics are fixed error codes only; never propagate config/provider text.
        throw Object.assign(new ApiError('CONTROL_STARTUP_REJECTED', 503), { startupReason: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' });
    }
}
export async function startHost(config: HostConfig, audit: Parameters<typeof createGateway>[0]['audit']) {
    const host = await prepareHost(config, audit);
    try { await host.app.listen(config.listen); return host; }
    catch { await host.app.close(); throw new ApiError('CONTROL_LISTEN_FAILED', 503); }
}
