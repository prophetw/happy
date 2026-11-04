import { z } from 'zod';
import type { ApiMessage } from './apiTypes';

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const MAX_RECORDS = PAGE_SIZE * MAX_PAGES;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const record = z.object({
    id: z.string().min(1).max(200), seq: z.number().int().nonnegative(),
    metadata: z.string(), metadataVersion: z.number().int().nonnegative(),
    agentState: z.string().nullable(), agentStateVersion: z.number().int().nonnegative(),
    dataEncryptionKey: z.string().nullable(), projectId: z.string().nullable().optional(),
    avatar: z.unknown().optional(), avatarVersion: z.unknown().optional(),
    active: z.boolean(), activeAt: z.number().nonnegative(),
    createdAt: z.number().nonnegative(), updatedAt: z.number().nonnegative(),
    tag: z.string().optional(),
}).passthrough();
export type SessionHydrationRecord = z.infer<typeof record> & { lastMessage: ApiMessage | null };
const page = z.object({ sessions: z.array(record).max(PAGE_SIZE), hasNext: z.boolean(),
    nextCursor: z.string().min(1).max(256).nullable() });

function assertCurrent(signal: AbortSignal | undefined, isCurrent: () => boolean) {
    if (signal?.aborted || !isCurrent()) throw new Error('Dots directory request canceled or account changed');
}
function parseJson(text: string): unknown {
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error('Dots directory response is not valid JSON'); }
}
async function responseJson(response: Response, signal: AbortSignal | undefined, isCurrent: () => boolean) {
    assertCurrent(signal, isCurrent);
    if (Number(response.headers?.get('content-length')) > MAX_PAGE_BYTES) {
        throw new Error('Dots directory response exceeds its size limit');
    }
    const reader = response.body?.getReader?.();
    // React Native's fetch polyfill exposes text(), but no streaming body.
    if (!reader) {
        const text = await response.text();
        assertCurrent(signal, isCurrent);
        if (text.length > MAX_PAGE_BYTES || new TextEncoder().encode(text).byteLength > MAX_PAGE_BYTES) {
            throw new Error('Dots directory response exceeds its size limit');
        }
        return parseJson(text);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            assertCurrent(signal, isCurrent);
            const part = await reader.read();
            assertCurrent(signal, isCurrent);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_PAGE_BYTES) throw new Error('Dots directory response exceeds its size limit');
            chunks.push(part.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseJson(new TextDecoder().decode(bytes));
}

/** Existing v2 cursor protocol; publish nothing until every bounded page is complete. */
export async function fetchSessionDirectory(options: {
    serverUrl: string; headers: Record<string, string>; signal?: AbortSignal; isCurrent: () => boolean;
}): Promise<SessionHydrationRecord[]> {
    const rows: SessionHydrationRecord[] = [];
    const seenIds = new Set<string>(), seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let index = 0; index < MAX_PAGES; index++) {
        assertCurrent(options.signal, options.isCurrent);
        const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(`${options.serverUrl.replace(/\/$/, '')}/v2/sessions?${query}`, {
            headers: options.headers, signal: options.signal, redirect: 'error',
        });
        assertCurrent(options.signal, options.isCurrent);
        if (!response.ok) throw new Error(`Failed to fetch Dots directory: ${response.status}`);
        const parsed = page.safeParse(await responseJson(response, options.signal, options.isCurrent));
        if (!parsed.success) throw new Error('Dots directory response has an invalid shape');
        const current = parsed.data;
        if (current.hasNext !== (current.nextCursor !== null)) throw new Error('Dots directory pagination is inconsistent');
        for (const session of current.sessions) {
            if (seenIds.has(session.id)) throw new Error('Dots directory cursor did not advance');
            seenIds.add(session.id);
            rows.push({ ...session, lastMessage: null });
        }
        if (rows.length > MAX_RECORDS) throw new Error('Dots directory record limit reached');
        if (!current.hasNext) return rows;
        const next = current.nextCursor!;
        if (current.sessions.length === 0 || next !== `cursor_v1_${current.sessions.at(-1)!.id}`
            || next === cursor || seenCursors.has(next)) throw new Error('Dots directory cursor did not advance');
        seenCursors.add(next); cursor = next;
    }
    throw new Error('Dots directory page limit reached');
}
