import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const values = vi.hoisted(() => new Map<string, string | boolean>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return values.get(key) as string | undefined; }
    getBoolean(key: string) { return values.get(key) as boolean | undefined; }
    set(key: string, value: string | boolean) { values.set(key, value); }
    delete(key: string) { values.delete(key); }
} }));

import { getServerUrl, isUsingCustomServer, rewriteLoopbackHost, setServerUrl, validateServerUrl } from './serverConfig';

beforeEach(() => {
    values.clear();
    vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
    vi.stubGlobal('__HAPPY_CONFIG__', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('custom server configuration', () => {
    it('keeps the default and restores it when the override is cleared', () => {
        expect(getServerUrl()).toBe('https://api.cluster-fluster.com');
        expect(isUsingCustomServer()).toBe(false);
        setServerUrl(' https://example.com:8193/relay/// ');
        expect(getServerUrl()).toBe('https://example.com:8193/relay');
        setServerUrl(null);
        expect(getServerUrl()).toBe('https://api.cluster-fluster.com');
    });

    it('preserves persisted, injected and environment configuration precedence', () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', 'http://localhost:3005/relay/');
        expect(getServerUrl()).toBe('http://localhost:3005/relay');
        vi.stubGlobal('__HAPPY_CONFIG__', { serverUrl: 'https://injected.example/relay/' });
        expect(getServerUrl()).toBe('https://injected.example/relay');
        setServerUrl('https://saved.example/team/relay/');
        expect(getServerUrl()).toBe('https://saved.example/team/relay');
    });

    it('accepts a prefix but rejects URL components that cannot be API base URLs', () => {
        expect(validateServerUrl('https://example.com:8193/relay/').valid).toBe(true);
        expect(validateServerUrl('https://example.com/relay?token=x').valid).toBe(false);
        expect(validateServerUrl('https://example.com/relay#x').valid).toBe(false);
        expect(validateServerUrl('https://user:pass@example.com').valid).toBe(false);
    });

    it.each(['localhost', '127.0.0.1', '[::1]'])('keeps a proxy prefix when rewriting local file URLs from %s', (host) => {
        setServerUrl('https://example.com:8193/relay');
        expect(rewriteLoopbackHost(`http://${host}:3005/v1/sessions/id/attachments/blob?signature=x`))
            .toBe('https://example.com:8193/relay/v1/sessions/id/attachments/blob?signature=x');
    });

    it('does not add a prefix twice or rewrite external signed storage URLs', () => {
        setServerUrl('https://example.com:8193/relay');
        expect(rewriteLoopbackHost('http://localhost:3005/relay/files/avatar'))
            .toBe('https://example.com:8193/relay/files/avatar');
        const external = 'https://storage.example/blob?signature=x';
        expect(rewriteLoopbackHost(external)).toBe(external);
    });
});
