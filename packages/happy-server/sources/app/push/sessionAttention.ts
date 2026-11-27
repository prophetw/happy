import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { kvMutateInTx } from '@/app/kv/kvMutate';
import { SESSION_ATTENTION_PREFIX, encodeAttentionValue, readAttentionValue, type AttentionKind, type AttentionValue } from './sessionAttentionValue';

async function updateAttention(tx: Tx, userId: string, sessionId: string, update: (value: AttentionValue | null) => AttentionValue | undefined) {
    const key = SESSION_ATTENTION_PREFIX + sessionId;
    const row = await tx.userKVStore.findUnique({ where: { accountId_key: { accountId: userId, key } } });
    const value = update(readAttentionValue(row?.value));
    if (value) {
        const result = await kvMutateInTx(tx, { uid: userId }, [{ key, value: encodeAttentionValue(value), version: row?.version ?? -1 }]);
        if (!result.success) throw new Error('Session attention version changed within the transaction');
    }
}

export function recordSessionAttention(userId: string, sessionId: string, kind: AttentionKind, eventId: string, errorCode?: string,
    signal?: { occurredAt?: number; visibility?: AttentionValue['visibility']; active?: boolean }) {
    const at = Date.now();
    const occurredAt = signal?.occurredAt === undefined ? undefined : Math.min(at, signal.occurredAt);
    return inTx(async tx => {
        let outcome = { created: false, shouldNotify: false };
        await updateAttention(tx, userId, sessionId, previous => {
            if (previous?.eventId === eventId) {
                outcome.shouldNotify = !previous.read && !previous.pushDelivered;
                return;
            }
            const seq = Number(eventId.split(':')[1]);
            if (previous?.eventId === `${kind}:${seq}` && previous.read) return;
            if (previous?.seq !== undefined && (previous.seq > seq || (kind === 'done' && previous.kind === 'failed' && previous.seq === seq))) return;
            if (previous?.archivedAt !== undefined && (!signal?.active || (occurredAt ?? at) <= previous.archivedAt)) return;
            if ((kind === 'done' || kind === 'failed') && occurredAt !== undefined && occurredAt <= (previous?.turnStartedAt ?? -1)) return;
            if ((kind === 'permission' || kind === 'question') && occurredAt !== undefined && previous?.action?.kind === null && occurredAt <= previous.action.at) return;

            outcome = { created: true, shouldNotify: true };
            return { kind, eventId, seq, at, read: false, occurredAt, action: previous?.action,
                turnStartedAt: previous?.turnStartedAt, visibility: signal?.visibility ?? previous?.visibility,
                ...(kind === 'failed' && errorCode ? { errorCode } : {}) };
        });
        return outcome;
    });
}

export function markAttentionPushDelivered(userId: string, sessionId: string, eventId: string) {
    return inTx(tx => updateAttention(tx, userId, sessionId, value =>
        value && value.eventId === eventId && !value.pushDelivered ? { ...value, pushDelivered: true } : undefined));
}

export function syncAttentionAction(tx: Tx, userId: string, sessionId: string, action: NonNullable<AttentionValue['action']>, visibility: AttentionValue['visibility'], active: boolean) {
    action = { ...action, at: Math.min(action.at, Date.now()) };
    return updateAttention(tx, userId, sessionId, value => {
        if (!value && !action.kind) return;
        if (value?.action && value.action.version >= action.version) return;
        if (value?.archivedAt !== undefined && (!active || action.at <= value.archivedAt)) return;
        const base = value ?? { kind: action.kind!, eventId: `action:${action.version}`, at: action.at, read: true };
        // Repeated state updates for the same pending action don't change its
        // order in the list or require another KV update.
        const unresolvedPush = value && (value.kind === 'permission' || value.kind === 'question')
            && (value.occurredAt ?? value.at) > (value.action?.at ?? -1);
        if (value?.action?.kind === action.kind && value.visibility === (visibility ?? value.visibility) && !value.archivedAt
            && (action.kind || !unresolvedPush)) return;
        return { ...base, action, visibility: visibility ?? base.visibility, archivedAt: undefined };
    });
}

export function retireAttentionResult(userId: string, sessionId: string, turnStartedAt: number, visibility: AttentionValue['visibility']) {
    return inTx(tx => updateAttention(tx, userId, sessionId, value => {
        if (value?.archivedAt !== undefined || (value?.turnStartedAt ?? -1) >= turnStartedAt) return;
        const base = value ?? { kind: 'done' as const, eventId: `turn-start:${turnStartedAt}`, at: turnStartedAt, read: true };
        const read = base.read || ((base.kind === 'done' || base.kind === 'failed') && (base.occurredAt ?? base.at) <= turnStartedAt);
        return { ...base, read, turnStartedAt, visibility: visibility ?? base.visibility };
    }));
}

export function archiveSessionAttention(tx: Tx, userId: string, sessionId: string, at: number, keepPersistent = false) {
    return updateAttention(tx, userId, sessionId, value => {
        if ((value?.archivedAt ?? -1) >= at || (keepPersistent && value?.visibility !== 'normal')) return;
        return { ...(value ?? { kind: 'done', eventId: `archive:${at}`, at }), action: undefined, read: true, archivedAt: at };
    });
}

export async function listSessionAttention(userId: string) {
    // Join the account KV keys to the session rows in one snapshot. Missing
    // sessions and archived/inactive ordinary sessions never contribute.
    const records = await db.$queryRaw<Array<{ sessionId: string; active: boolean; value: Uint8Array }>>`
        SELECT s."id" AS "sessionId", s."active", k."value"
        FROM "UserKVStore" k
        JOIN "Session" s ON s."accountId" = k."accountId" AND k."key" = ${SESSION_ATTENTION_PREFIX} || s."id"
        WHERE k."accountId" = ${userId} AND k."key" LIKE ${SESSION_ATTENTION_PREFIX + '%'} AND k."value" IS NOT NULL
    `;
    return records.flatMap(({ sessionId, active, value: raw }) => {
        const value = readAttentionValue(raw);
        if (!value || value.visibility === 'hidden' || value.archivedAt !== undefined || (!active && value.visibility !== 'persistent')) return [];
        if (value.action?.kind) {
            const { kind, at, version } = value.action;
            const matchingPush = value.kind === kind && (value.occurredAt ?? value.at) >= at;
            return [{ sessionId, kind, at: matchingPush ? value.at : at, eventId: matchingPush ? value.eventId : `action:${version}` }];
        }
        if (value.read || value.kind === 'intervention') return [];
        if ((value.kind === 'permission' || value.kind === 'question') && value.action && (value.occurredAt ?? value.at) <= value.action.at) return [];
        return [{ sessionId, kind: value.kind, at: value.at, eventId: value.eventId, ...(value.errorCode ? { errorCode: value.errorCode } : {}) }];
    });
}

export async function getAttentionBadgeCount(userId: string): Promise<number> {
    return (await listSessionAttention(userId)).length;
}
