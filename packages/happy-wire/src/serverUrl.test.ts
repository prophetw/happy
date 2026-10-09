import { describe, expect, it } from 'vitest';
import { getServerSocketEndpoint, normalizeServerUrl } from './serverUrl';

describe('server URLs', () => {
    it('preserves the default API and transport addresses', () => {
        const url = 'https://api.cluster-fluster.com';
        expect(normalizeServerUrl(url)).toBe(url);
        expect(getServerSocketEndpoint(url)).toEqual({ origin: url, path: '/v1/updates' });
    });

    it.each([
        [' https://example.com:8193/relay/// ', 'https://example.com:8193/relay', '/relay/v1/updates'],
        ['http://127.0.0.1:8193/', 'http://127.0.0.1:8193', '/v1/updates'],
        ['https://example.com/team/relay/', 'https://example.com/team/relay', '/team/relay/v1/updates'],
        ['http://[::1]:8193/relay/', 'http://[::1]:8193/relay', '/relay/v1/updates'],
    ])('normalizes %s without losing its prefix or port', (input, base, path) => {
        expect(normalizeServerUrl(input)).toBe(base);
        expect(getServerSocketEndpoint(input)).toEqual({ origin: new URL(base).origin, path });
        expect(`${normalizeServerUrl(input)}/v1/auth`).toBe(`${base}/v1/auth`);
    });

    it.each([
        '', 'example.com:8193/relay', 'ftp://example.com/relay',
        'https://user:password@example.com/relay', 'https://example.com/relay?token=secret',
        'https://example.com/relay#fragment', 'https://example.com:99999/relay',
    ])('rejects unsupported base URL %s', (input) => {
        expect(() => normalizeServerUrl(input)).toThrow();
        expect(() => getServerSocketEndpoint(input)).toThrow();
    });
});
