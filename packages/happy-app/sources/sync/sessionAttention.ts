import { z } from 'zod';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decodeUTF8, encodeUTF8 } from '@/encryption/text';
import type { KvItem } from './apiKv';
import type { Session } from './storageTypes';
import { isRigMetadata } from './rig';
import { testloopDotsKind } from './testloopDotsList';
import { selectPendingCommunications } from './agentCommunications';

export const SESSION_ATTENTION_PREFIX = 'session-attention-v1:';
export const AttentionValueSchema = z.object({
    kind: z.enum(['done', 'permission', 'question', 'failed', 'intervention']),
    eventId: z.string().min(1), at: z.number().finite(), read: z.boolean(), seq: z.number().optional(),
    pushDelivered: z.boolean().optional(),
    errorCode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/).optional(),
    visibility: z.enum(['normal', 'persistent', 'hidden']).optional(),
    occurredAt: z.number().optional(),
    action: z.object({ kind: z.enum(['permission', 'question']).nullable(), at: z.number(), version: z.number().int() }).optional(),
    archivedAt: z.number().optional(),
});
export const RelaySessionAttentionSchema = z.object({ items: z.array(z.object({
    sessionId: z.string(), kind: z.enum(['done', 'permission', 'question', 'failed']),
    eventId: z.string(), at: z.number(), errorCode: z.string().optional(),
})) });
export type RelaySessionAttention = z.infer<typeof RelaySessionAttentionSchema>['items'];
export type AttentionKind = z.infer<typeof AttentionValueSchema>['kind'];
export const CachedAttentionRecordSchema = AttentionValueSchema.extend({ version: z.number(),
    pendingRead: z.boolean().optional(), pendingEvent: z.boolean().optional(), pendingProjection: z.boolean().optional(),
});
export type SessionAttentionRecord = z.infer<typeof CachedAttentionRecordSchema>;
export type SessionAttentionRecords = Record<string, SessionAttentionRecord>;

export function getSessionAttentionKind(session: Session, record: SessionAttentionRecord | undefined): AttentionKind | undefined {
    if (session.lastTurnStatus === 'failed' || session.lastTurnStatus === 'partial') return 'failed';
    // Keep old intervention notifications neutral rather than presenting them
    // as completed work. Legacy agent state no longer controls attention.
    if (record?.kind === 'intervention' || (!record && session.attentionKind === 'intervention')) return 'intervention';
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

export function reconcileSessionAttention(session: Session | undefined, record: SessionAttentionRecord | undefined): SessionAttentionRecord | undefined {
    if (!session?.metadata) return record;
    const visibility = session.metadata.isSideChat || session.metadata.lifecycleState === 'archived' ? 'hidden'
        : isRigMetadata(session.metadata) || testloopDotsKind(session) ? 'persistent' : 'normal';
    let next = record;
    if (record && (record.visibility ?? 'normal') !== visibility) next = { ...record, visibility, pendingProjection: true };
    // Also cover older CLI and Rig producers. Their decrypted state arrives
    // with the same version as the producer's public action, if one was sent.
    const version = session.agentStateVersion;
    if (visibility === 'hidden' || record?.archivedAt !== undefined || version <= (record?.action?.version ?? -1)) return next;
    const kind = Object.keys(session.agentState?.requests ?? {}).length ? 'permission'
        : selectPendingCommunications(session.agentState).length ? 'question' : null;
    const legacyAction = record?.kind === 'permission' || record?.kind === 'question';
    if (kind === record?.action?.kind || (!kind && !record?.action?.kind && !legacyAction)) return next;
    // Push can arrive just before its encrypted state update. Wait for a newer
    // agent state before declaring an older producer's request resolved.
    if (!kind && !record?.action?.kind && legacyAction && version <= Number(record.eventId.split(':')[2])) return next;
    const at = Math.max(session.updatedAt, record?.at ?? 0);
    return { ...(next ?? { kind: kind!, eventId: `action:${version}`, at, read: true, version: -1 }),
        visibility, action: { kind, version, at }, pendingProjection: true };
}
