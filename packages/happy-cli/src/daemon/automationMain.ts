import { realpathSync } from 'node:fs';
import { EncryptedCredentialProvider, readProductionConfig, type SecretProvider, type WorkerConfig } from 'happy-agent/automation/production';
import type { ProofIdentity } from 'happy-agent/automation';
import { inspectAutomationMetadata } from './automationMetadata';

/** Normal authenticated read-only preflight; never returns credentials or starts the daemon. */
export async function automationMetadataMain(argv: string[]) {
    if (argv.length !== 2 || argv[0] !== '--expected-relay') throw new Error('AUTOMATION_EXPECTED_RELAY_REQUIRED');
    const { configuration } = await import('../configuration');
    const { readCredentials, readSettings } = await import('../persistence');
    const result = await inspectAutomationMetadata(argv[1], { relayURL: configuration.serverUrl,
        credentials: readCredentials, settings: readSettings,
        request: async (url, authorization) => {
            const response = await fetch(url, { method: 'GET', headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('AUTHENTICATED_METADATA_UNAVAILABLE');
            return response.json();
        } });
    return { version: 1, ok: true, data: result };
}

/** Injectable boot seam; tests do not import configuration/persistence or read Happy credentials. */
export async function launchAutomationWorker(config: WorkerConfig, provider: SecretProvider, boot: (identity: ProofIdentity) => Promise<void>) {
    try {
        if (config.registration.projects.some(p => realpathSync(p.directory) !== p.directory)) throw new Error('AUTOMATION_PROJECT_REALPATH_REQUIRED');
        const identity = await provider.identity(config.identityRef, config.registration.id, config.registration.publicKey);
        await boot(identity);
    } finally { await provider.close(); }
}
export async function automationWorkerMain(argv: string[]) {
    if (argv.length !== 2 || argv[0] !== '--config') throw new Error('CONFIG_ARGUMENT_REQUIRED');
    const config = readProductionConfig(argv[1]);
    if (config.role !== 'worker') throw new Error('WORKER_CONFIG_REQUIRED');
    const provider = new EncryptedCredentialProvider(config.secrets.keys, config.secrets.credentialsDirectory);
    await launchAutomationWorker(config, provider, async identity => {
        // Set explicit non-secret paths before loading the normal daemon. No login/new machine registration.
        process.env.HAPPY_HOME_DIR = config.happyHomeDirectory;
        process.env.HAPPY_SERVER_URL = config.relayURL;
        const { configuration } = await import('../configuration');
        if (configuration.serverUrl !== config.relayURL.replace(/\/$/, '') || configuration.happyHomeDir !== config.happyHomeDirectory) throw new Error('AUTOMATION_RELAY_BINDING_MISMATCH');
        const { startDaemon } = await import('./run');
        await startDaemon({ existingOnly: true, closeAutomationCredentials: () => provider.close(), automation: { endpoint: config.endpoint, identity, registration: config.registration,
            report: event => { process.stdout.write(JSON.stringify({ event: 'automation-worker', ...event }) + '\n'); } } });
    });
}
