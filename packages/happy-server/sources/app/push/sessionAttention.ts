import { db } from '@/storage/db';
import { kvMutate } from '@/app/kv/kvMutate';
import { z } from 'zod';
import { log } from '@/utils/log';

// Account KV namespace for delivery metadata only. No titles, messages or credentials.
export const SESSION_ATTENTION_PREFIX = 'session-attention-v1:';
export type AttentionKind = 'done' | 'permission' | 'question' | 'failed';
const valueSchema = z.object({ kind: z.enum(['done', 'permission', 'question', 'failed']), eventId: z.string(), read: z.boolean(), at: z.number(), seq: z.number().optional(), pushDelivered: z.boolean().optional(), errorCode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/).optional() });

function readValue(value: Uint8Array | null | undefined) {
    if (!value) return null;
    try { return valueSchema.parse(JSON.parse(Buffer.from(value).toString('utf8'))); }
    catch { log({ module: 'push', level: 'warn' }, 'Ignoring invalid session attention metadata'); return null; }
}

export async function recordSessionAttention(userId: string, sessionId: string, kind: AttentionKind, eventId: string, errorCode?: string) {
    const key = SESSION_ATTENTION_PREFIX + sessionId;
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: userId, key } } });
        const previous = readValue(current?.value);
        if (previous?.eventId === eventId) return { created: false, shouldNotify: !previous.read && !previous.pushDelivered };
        const seq = Number(eventId.split(':')[1]);
        if (previous?.seq !== undefined && previous.seq > seq) return { created: false, shouldNotify: false };
        if (kind === 'done' && previous?.kind === 'failed' && previous.seq === seq) return { created: false, shouldNotify: false };
        const value = Buffer.from(JSON.stringify({ kind, eventId, seq, at: Date.now(), read: false, ...(kind === 'failed' && errorCode ? { errorCode } : {}) })).toString('base64');
        const result = await kvMutate({ uid: userId }, [{ key, value, version: current?.version ?? -1 }]);
        if (result.success) return { created: true, shouldNotify: true };
    }
    throw new Error('Session attention changed repeatedly while recording an event');
}

export async function markAttentionPushDelivered(userId: string, sessionId: string, eventId: string) {
    const key = SESSION_ATTENTION_PREFIX + sessionId;
    for (let attempt = 0; attempt < 5; attempt++) {
        const current = await db.userKVStore.findUnique({ where: { accountId_key: { accountId: userId, key } } });
        const value = readValue(current?.value);
        if (!current || !value || value.eventId !== eventId || value.pushDelivered) return;
        const result = await kvMutate({ uid: userId }, [{ key, value: Buffer.from(JSON.stringify({ ...value, pushDelivered: true })).toString('base64'), version: current.version }]);
        if (result.success) return;
    }
    throw new Error('Unable to record session push delivery');
}

export async function getAttentionBadgeCount(userId: string): Promise<number> {
    const records = await db.userKVStore.findMany({ where: { accountId: userId, key: { startsWith: SESSION_ATTENTION_PREFIX }, value: { not: null } }, select: { value: true } });
    return records.reduce((count, record) => {
        if (!record.value) return count;
        return count + (readValue(record.value)?.read === false ? 1 : 0);
    }, 0);
}
