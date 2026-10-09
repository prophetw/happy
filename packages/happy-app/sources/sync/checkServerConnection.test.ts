import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkServerConnection } from './checkServerConnection';

afterEach(() => vi.unstubAllGlobals());

describe('server connection checks', () => {
    it('checks the health endpoint beneath the configured prefix, even when the root serves a webapp', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ service: 'happy-server', status: 'ok' })));
        vi.stubGlobal('fetch', fetchMock);
        expect(await checkServerConnection('https://example.com:8193/relay/')).toEqual({ valid: true });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock).toHaveBeenCalledWith('https://example.com:8193/relay/health', expect.any(Object));
    });

    it.each([404, 405])('retains the legacy banner check when health is unavailable (%s)', async (status) => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response('', { status }))
            .mockResolvedValueOnce(new Response('Welcome to Happy Server!'));
        vi.stubGlobal('fetch', fetchMock);
        expect(await checkServerConnection('https://legacy.example.com')).toEqual({ valid: true });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            'https://legacy.example.com/health', 'https://legacy.example.com',
        ]);
    });

    it('does not hide health failures behind a working root page', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
        vi.stubGlobal('fetch', fetchMock);
        expect(await checkServerConnection('https://example.com/relay')).toEqual({ valid: false, error: 'response' });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects a different service with a successful HTTP response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ service: 'other', status: 'ok' }))));
        expect(await checkServerConnection('https://example.com')).toEqual({ valid: false, error: 'server' });
    });

    it('reports an unreachable server', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
        expect(await checkServerConnection('https://example.com')).toEqual({ valid: false, error: 'connection' });
    });

    it('aborts stalled probes instead of leaving Save disabled indefinitely', async () => {
        vi.useFakeTimers();
        try {
            vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
                options.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
            })));
            const result = checkServerConnection('https://example.com');
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await result).toEqual({ valid: false, error: 'connection' });
        } finally {
            vi.useRealTimers();
        }
    });
});
