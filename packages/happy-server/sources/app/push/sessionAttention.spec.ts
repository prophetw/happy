import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ record: null as null | { value: Uint8Array; version: number }, conflicts: 0 }));
vi.mock('@/storage/db', () => ({ db: { userKVStore: {
    findUnique: vi.fn(async () => state.record), findMany: vi.fn(async () => state.record ? [state.record] : []),
} } }));
vi.mock('@/app/kv/kvMutate', () => ({ kvMutate: vi.fn(async (_context, mutations) => {
    if (state.conflicts-- > 0) return { success: false, errors: [] };
    const mutation = mutations[0];
    state.record = { value: Buffer.from(mutation.value, 'base64'), version: mutation.version + 1 };
    return { success: true, results: [{ key: mutation.key, version: mutation.version + 1 }] };
}) }));

import { kvMutate } from '@/app/kv/kvMutate';
import { recordSessionAttention, getAttentionBadgeCount, markAttentionPushDelivered } from './sessionAttention';

beforeEach(() => { state.record = null; state.conflicts = 0; vi.clearAllMocks(); });

describe('durable session attention', () => {
    it('records delivery metadata before push, counts unread, and preserves read on retries', async () => {
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: true, shouldNotify: true });
        const record = JSON.parse(Buffer.from(state.record!.value).toString());
        expect(record).toMatchObject({ kind: 'done', eventId: 'done:3:1', seq: 3, read: false });
        expect(record).not.toHaveProperty('title');
        expect(await getAttentionBadgeCount('u')).toBe(1);
        state.record!.value = Buffer.from(JSON.stringify({ ...record, read: true }));
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
        expect(await getAttentionBadgeCount('u')).toBe(0);
        expect(await recordSessionAttention('u', 's', 'done', 'done:7:1')).toEqual({ created: true, shouldNotify: true });
        expect(await getAttentionBadgeCount('u')).toBe(1);
    });

    it('retries a compare-and-set conflict and does not turn an explicit failure into success', async () => {
        state.conflicts = 1;
        await recordSessionAttention('u', 's', 'failed', 'failed:3:1');
        expect(kvMutate).toHaveBeenCalledTimes(2);
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
    });

    it('allows a failed delivery to retry, then suppresses duplicates after delivery', async () => {
        await recordSessionAttention('u', 's', 'done', 'done:3:1');
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: true });
        await markAttentionPushDelivered('u', 's', 'done:3:1');
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
    });
});
