import { normalizeServerUrl } from '@slopus/happy-wire/serverUrl';

export type ServerConnectionResult = { valid: true } | {
    valid: false;
    error: 'connection' | 'response' | 'server';
};

/** Prefer structured health checks, retaining the banner probe for older servers. */
export async function checkServerConnection(value: string): Promise<ServerConnectionResult> {
    const baseUrl = normalizeServerUrl(value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        const health = await fetch(`${baseUrl}/health`, {
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (health.ok) {
            const body = await health.json();
            return body?.service === 'happy-server' && body?.status === 'ok'
                ? { valid: true }
                : { valid: false, error: 'server' };
        }
        // Do not let a banner hide an unhealthy server (for example health 503).
        if (health.status !== 404 && health.status !== 405) {
            return { valid: false, error: 'response' };
        }
        const response = await fetch(baseUrl, {
            headers: { Accept: 'text/plain' },
            signal: controller.signal,
        });
        if (!response.ok) return { valid: false, error: 'response' };
        return (await response.text()).includes('Welcome to Happy Server!')
            ? { valid: true }
            : { valid: false, error: 'server' };
    } catch {
        return { valid: false, error: 'connection' };
    } finally {
        clearTimeout(timeout);
    }
}
