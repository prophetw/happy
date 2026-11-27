import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, dbMock } = vi.hoisted(() => {
    const state = { rows: new Map<string, { value: Uint8Array | null; version: number }>(), sessions: new Map<string, boolean>() };
    const dbMock = {
        userKVStore: {
            findUnique: async ({ where }: { where: { accountId_key: { key: string } } }) => state.rows.get(where.accountId_key.key),
            create: async ({ data }: { data: { key: string; value: Uint8Array | null } }) => {
                const row = { value: data.value, version: 0 };
                state.rows.set(data.key, row);
                return row;
            },
            update: async ({ where, data }: { where: { accountId_key: { key: string } }; data: { value: Uint8Array; version: number } }) => {
                state.rows.set(where.accountId_key.key, data);
                return data;
            },
        },
        $queryRaw: async () => [...state.sessions.entries()].flatMap(([sessionId, active]) => {
            const value = state.rows.get(`session-attention-v1:${sessionId}`)?.value;
            return value ? [{ sessionId, active, value }] : [];
        }),
    };
    return { state, dbMock };
});
vi.mock('@/storage/db', () => ({ db: dbMock }));
vi.mock('@/storage/inTx', () => ({ inTx: (run: (tx: typeof dbMock) => unknown) => run(dbMock), afterTx: vi.fn() }));

import { kvMutate } from '@/app/kv/kvMutate';
import type { Tx } from '@/storage/inTx';
import { archiveSessionAttention, recordSessionAttention, getAttentionBadgeCount, listSessionAttention, markAttentionPushDelivered, retireAttentionResult, syncAttentionAction } from './sessionAttention';
import { readAttentionValue } from './sessionAttentionValue';

const tx = dbMock as unknown as Tx;
const key = (id: string) => `session-attention-v1:${id}`;
const get = (id = 's') => readAttentionValue(state.rows.get(key(id))?.value)!;
beforeEach(() => { state.rows.clear(); state.sessions.clear(); state.sessions.set('s', true); vi.clearAllMocks(); });

describe('durable session attention', () => {
    it('keeps a newer successful turn ahead of an old failure and retains error codes on delivery', async () => {
        await recordSessionAttention('u', 's', 'failed', 'failed:3:1', 'serverOverloaded');
        await markAttentionPushDelivered('u', 's', 'failed:3:1');
        expect(get()).toMatchObject({ errorCode: 'serverOverloaded' });
        await recordSessionAttention('u', 's', 'done', 'done:7:1');
        expect(await recordSessionAttention('u', 's', 'failed', 'failed:3:1')).toEqual({ created: false, shouldNotify: false });
        expect(get()).toMatchObject({ kind: 'done', seq: 7 });
    });
    it('records delivery metadata before push, counts unread, and preserves read on retries', async () => {
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: true, shouldNotify: true });
        const record = get();
        expect(record).toMatchObject({ kind: 'done', eventId: 'done:3:1', seq: 3, read: false });
        expect(record).not.toHaveProperty('title');
        expect(await getAttentionBadgeCount('u')).toBe(1);
        await kvMutate({ uid: 'u' }, [{ key: key('s'), value: Buffer.from(JSON.stringify({ ...record, read: true })).toString('base64'), version: 0 }]);
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
        expect(await getAttentionBadgeCount('u')).toBe(0);
        expect(await recordSessionAttention('u', 's', 'done', 'done:7:1')).toEqual({ created: true, shouldNotify: true });
        expect(await getAttentionBadgeCount('u')).toBe(1);
    });

    it('does not turn an explicit failure into success at the same sequence', async () => {
        await recordSessionAttention('u', 's', 'failed', 'failed:3:1');
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
    });

    it('allows a failed delivery to retry, then suppresses duplicates after delivery', async () => {
        await recordSessionAttention('u', 's', 'done', 'done:3:1');
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: true });
        await markAttentionPushDelivered('u', 's', 'done:3:1');
        expect(await recordSessionAttention('u', 's', 'done', 'done:3:1')).toEqual({ created: false, shouldNotify: false });
    });

    it('returns one visible item and a badge of one for seven attention records', async () => {
        for (const id of ['s', 'ended', 'deleted', 'archived', 'hidden', 'window', 'read']) {
            if (id !== 'deleted') state.sessions.set(id, !['ended', 'archived'].includes(id));
            await recordSessionAttention('u', id, id === 'window' ? 'intervention' : 'done', 'done:3:1', undefined,
                { visibility: id === 'hidden' ? 'hidden' : id === 'archived' ? 'persistent' : 'normal' });
        }
        await archiveSessionAttention(tx, 'u', 'archived', Date.now());
        state.rows.get(key('read'))!.value = Buffer.from(JSON.stringify({ ...get('read'), read: true }));
        expect(await listSessionAttention('u')).toEqual([expect.objectContaining({ sessionId: 's', kind: 'done' })]);
        expect(await getAttentionBadgeCount('u')).toBe(1);
    });

    it('keeps an offline Rig action after a legacy read and clears it on a newer resolution', async () => {
        state.sessions.set('s', false);
        await recordSessionAttention('u', 's', 'permission', 'permission:3:1');
        await syncAttentionAction(tx, 'u', 's', { kind: 'permission', version: 2, at: 10 }, 'persistent', false);
        await kvMutate({ uid: 'u' }, [{ key: key('s'), version: 1,
            value: Buffer.from(JSON.stringify({ kind: 'permission', eventId: 'permission:3:1', at: get().at, read: true })).toString('base64') }]);
        expect(await listSessionAttention('u')).toEqual([expect.objectContaining({ sessionId: 's', kind: 'permission' })]);
        await syncAttentionAction(tx, 'u', 's', { kind: null, version: 3, at: 20 }, 'persistent', false);
        await syncAttentionAction(tx, 'u', 's', { kind: 'question', version: 2, at: 15 }, 'persistent', false);
        expect(await getAttentionBadgeCount('u')).toBe(0);
    });

    it('retires the previous result at a new turn without hiding a newer result or an open action', async () => {
        await recordSessionAttention('u', 's', 'failed', 'failed:3:1', undefined, { occurredAt: 10 });
        await retireAttentionResult('u', 's', 20, 'normal');
        expect(await getAttentionBadgeCount('u')).toBe(0);
        expect(await recordSessionAttention('u', 's', 'failed', 'failed:4:1', undefined, { occurredAt: 15 })).toMatchObject({ created: false });
        await recordSessionAttention('u', 's', 'done', 'done:5:1', undefined, { occurredAt: 30 });
        await retireAttentionResult('u', 's', 25, 'normal');
        expect(await listSessionAttention('u')).toEqual([expect.objectContaining({ kind: 'done', eventId: 'done:5:1' })]);
        await syncAttentionAction(tx, 'u', 's', { kind: 'question', version: 2, at: 35 }, 'normal', true);
        await retireAttentionResult('u', 's', 40, 'normal');
        expect(await listSessionAttention('u')).toEqual([expect.objectContaining({ kind: 'question' })]);
    });
});
