import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decodeUTF8, encodeUTF8 } from '@/encryption/text';
import type { KvItem } from './apiKv';
import type { Session } from './storageTypes';

export const SESSION_ATTENTION_PREFIX = 'session-attention-v1:';
export const AttentionValueSchema = z.object({
    kind: z.enum(['done', 'permission', 'question', 'failed']),
    eventId: z.string().min(1), at: z.number().finite(), read: z.boolean(), seq: z.number().optional(),
    pushDelivered: z.boolean().optional(),
    errorCode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/).optional(),
});
export type AttentionKind = z.infer<typeof AttentionValueSchema>['kind'];
export type SessionAttentionRecord = z.infer<typeof AttentionValueSchema> & { version: number; pendingRead?: boolean; pendingEvent?: boolean };
export type SessionAttentionRecords = Record<string, SessionAttentionRecord>;

export function getSessionAttentionKind(session: Session, record: SessionAttentionRecord | undefined): AttentionKind | undefined {
    if (session.lastTurnStatus === 'failed') return 'failed';
    if (session.lastTurnStatus === 'completed') return 'done';
    return record?.kind ?? session.attentionKind;
}

export function decodeAttentionItem(item: KvItem): [string, SessionAttentionRecord] | null {
    if (!item.key.startsWith(SESSION_ATTENTION_PREFIX)) return null;
    try {
        const value = AttentionValueSchema.parse(JSON.parse(decodeUTF8(decodeBase64(item.value))));
        return [item.key.slice(SESSION_ATTENTION_PREFIX.length), { ...value, version: item.version }];
    } catch (error) {
        console.warn('Invalid session attention metadata', error);
        return null;
    }
}

export function encodeAttentionValue(record: SessionAttentionRecord): string {
    return encodeBase64(encodeUTF8(JSON.stringify(AttentionValueSchema.parse(record))), 'base64');
}

/** A read receipt acknowledges one event; a newer event must remain unread. */
export function mergeAttentionRecord(previous: SessionAttentionRecord | undefined, incoming: SessionAttentionRecord): SessionAttentionRecord {
    if (!previous) return incoming;
    if (incoming.version < previous.version) return previous;
    if (previous.seq !== undefined && incoming.seq !== undefined && incoming.seq < previous.seq) {
        return { ...previous, version: incoming.version, pendingEvent: true };
    }
    if (previous.pendingEvent && incoming.eventId !== previous.eventId
        && (previous.seq === undefined || incoming.seq === undefined || previous.seq >= incoming.seq)) {
        return { ...previous, version: incoming.version };
    }
    if (previous.pendingRead && incoming.eventId === previous.eventId && !incoming.read) {
        return { ...incoming, read: true, pendingRead: true };
    }
    return incoming;
}

export function readAttentionRecord(record: SessionAttentionRecord): SessionAttentionRecord {
    return record.read ? record : { ...record, read: true, pendingRead: true };
}
