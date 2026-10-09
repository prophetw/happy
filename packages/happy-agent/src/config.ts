import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeServerUrl } from '@slopus/happy-wire/serverUrl';

export type Config = {
    serverUrl: string;
    homeDir: string;
    credentialPath: string;
};

export function loadConfig(): Config {
    const serverUrl = normalizeServerUrl(process.env.HAPPY_SERVER_URL ?? 'https://api.cluster-fluster.com');
    const homeDir = process.env.HAPPY_HOME_DIR ?? join(homedir(), '.happy');
    const credentialPath = join(homeDir, 'agent.key');
    return { serverUrl, homeDir, credentialPath };
}
