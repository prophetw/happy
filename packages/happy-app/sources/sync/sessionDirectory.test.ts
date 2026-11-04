import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSessionDirectory } from './sessionDirectory';

const wire = (id: string) => ({
    id, seq: 1, metadata: 'opaque', metadataVersion: 1,
    agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
    active: false, activeAt: 1, createdAt: 1, updatedAt: 1,
});
const complete = (sessions = [wire('old-dot')]) => ({ sessions, hasNext: false, nextCursor: null });
const options = (patch: Partial<Parameters<typeof fetchSessionDirectory>[0]> = {}) => ({
    serverUrl: 'https://example.invalid/', headers: { Authorization: 'Bearer synthetic' }, isCurrent: () => true,
    ...patch,
});
afterEach(() => vi.unstubAllGlobals());

describe('bounded v2 session directory', () => {
    it('follows the existing cursor API and normalizes the absent last message', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(Response.json({ sessions: [wire('newer')], hasNext: true, nextCursor: 'cursor_v1_newer' }))
            .mockResolvedValueOnce(Response.json(complete()));
        vi.stubGlobal('fetch', fetcher);
        const rows = await fetchSessionDirectory(options());
        expect(rows.map(row => [row.id, row.lastMessage, row.active])).toEqual([
            ['newer', null, false], ['old-dot', null, false],
        ]);
        expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
            'https://example.invalid/v2/sessions?limit=200',
            'https://example.invalid/v2/sessions?limit=200&cursor=cursor_v1_newer',
        ]);
        expect(fetcher.mock.calls[0][1]).toMatchObject({
            headers: { Authorization: 'Bearer synthetic' }, redirect: 'error',
        });
    });

    it('also reads native fetch Responses without a ReadableStream body', async () => {
        const text = vi.fn(async () => JSON.stringify(complete()));
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers(), text, body: undefined })));
        await expect(fetchSessionDirectory(options())).resolves.toMatchObject([{ id: 'old-dot', lastMessage: null }]);
        expect(text).toHaveBeenCalledOnce();
    });

    it.each([
        ['HTTP failure', () => new Response('unavailable', { status: 503 }), '503'],
        ['invalid JSON', () => new Response('{'), 'not valid JSON'],
        ['invalid record', () => Response.json(complete([{ id: 'invalid' } as any])), 'invalid shape'],
        ['contradictory cursor', () => Response.json({ ...complete(), hasNext: true }), 'inconsistent'],
        ['empty advancing page', () => Response.json({ sessions: [], hasNext: true, nextCursor: 'cursor_v1_empty' }), 'did not advance'],
        ['unrelated cursor', () => Response.json({ sessions: [wire('a')], hasNext: true, nextCursor: 'cursor_v1_b' }), 'did not advance'],
    ])('rejects %s rather than returning an empty directory', async (_name, response, error) => {
        vi.stubGlobal('fetch', vi.fn(async () => response()));
        await expect(fetchSessionDirectory(options())).rejects.toThrow(error);
    });

    it('rejects a duplicate record even when the server changes its cursor', async () => {
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(Response.json({ sessions: [wire('same')], hasNext: true, nextCursor: 'cursor_v1_same' }))
            .mockResolvedValueOnce(Response.json(complete([wire('same')]))));
        await expect(fetchSessionDirectory(options())).rejects.toThrow('did not advance');
    });

    it('has a ten-page, two-thousand-record limit', async () => {
        let count = 0;
        const fetcher = vi.fn(async () => {
            const sessions = Array.from({ length: 200 }, (_, index) => wire(`p${count}-${index}`));
            count++;
            return Response.json({ sessions, hasNext: true, nextCursor: `cursor_v1_${sessions.at(-1)!.id}` });
        });
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchSessionDirectory(options())).rejects.toThrow('page limit');
        expect(fetcher).toHaveBeenCalledTimes(10);
    });

    it('rejects oversized stream responses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1))));
        await expect(fetchSessionDirectory(options())).rejects.toThrow('size limit');
    });

    it('rejects native response lengths before reading a known oversized body', async () => {
        const text = vi.fn(async () => JSON.stringify(complete()));
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, headers: new Headers({ 'content-length': String(8 * 1024 * 1024 + 1) }), text,
        })));
        await expect(fetchSessionDirectory(options())).rejects.toThrow('size limit');
        expect(text).not.toHaveBeenCalled();
    });

    it('bounds native response text when no content length is available', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, text: async () => 'x'.repeat(8 * 1024 * 1024 + 1),
        })));
        await expect(fetchSessionDirectory(options())).rejects.toThrow('size limit');
    });

    it('does not request a page for an already aborted caller', async () => {
        const controller = new AbortController();
        controller.abort();
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        await expect(fetchSessionDirectory(options({ signal: controller.signal }))).rejects.toThrow('canceled');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(['abort', 'scope'])('stops %s before advancing to another page', async reason => {
        const controller = new AbortController();
        let current = true;
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            text: async () => {
                if (reason === 'abort') controller.abort();
                else current = false;
                return JSON.stringify({ sessions: [wire('first')], hasNext: true, nextCursor: 'cursor_v1_first' });
            },
        })));
        await expect(fetchSessionDirectory(options({ signal: controller.signal, isCurrent: () => current })))
            .rejects.toThrow('canceled or account changed');
        expect(fetch).toHaveBeenCalledOnce();
    });
});
