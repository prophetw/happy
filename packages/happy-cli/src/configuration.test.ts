import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;
beforeEach(() => {
    vi.resetModules();
    homeDir = mkdtempSync(join(tmpdir(), 'happy-server-url-'));
    vi.stubEnv('HAPPY_HOME_DIR', homeDir);
    vi.stubEnv('HAPPY_SERVER_URL', '');
    vi.stubEnv('HAPPY_WEBAPP_URL', '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(homeDir, { recursive: true, force: true }); });

describe('CLI server configuration', () => {
    it('retains the existing defaults', async () => {
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://api.cluster-fluster.com');
        expect(configuration.webappUrl).toBe('https://app.happy.engineering');
    });

    it('normalizes a persisted custom API base without changing the webapp URL', async () => {
        writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({
            serverUrl: 'https://saved.example:8193/relay/', webappUrl: 'https://web.example',
        }));
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://saved.example:8193/relay');
        expect(configuration.webappUrl).toBe('https://web.example');
    });

    it('retains environment overrides above persisted settings', async () => {
        writeFileSync(join(homeDir, 'settings.json'), JSON.stringify({ serverUrl: 'https://saved.example/relay' }));
        vi.stubEnv('HAPPY_SERVER_URL', ' https://env.example:8193/team/relay/// ');
        const { configuration } = await import('./configuration');
        expect(configuration.serverUrl).toBe('https://env.example:8193/team/relay');
    });
});
