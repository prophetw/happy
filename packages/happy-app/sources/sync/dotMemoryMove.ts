import { z } from 'zod';
import { MMKV } from 'react-native-mmkv';
import { apiSocket } from './apiSocket';
import type { MemoryScope } from './dotObservation';

const id = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
export const DotMemoryMoveIntentSchema = z.object({ requestID: id, dotId: id, keyDigest: digest,
    sourceScope: z.enum(['dot', 'user']), sourceRevision: revision.positive(), targetRevision: revision.optional() });
export type DotMemoryMoveIntent = z.infer<typeof DotMemoryMoveIntentSchema>;
export const DotMemoryMoveReceiptSchema = z.object({ schemaVersion: z.literal(1), requestID: id, dotId: id, keyDigest: digest,
    status: z.enum(['ready', 'completed_locally', 'target_saved', 'needs_attention', 'abandoned']),
    sourceScope: z.enum(['dot', 'user']), targetScope: z.enum(['dot', 'user']), sourceRevision: revision.positive(), targetRevision: revision, targetExpectedRevision: revision,
    indexing: z.enum(['pending', 'indexed', 'blocked', 'superseded']), cleanup: z.enum(['pending', 'complete', 'blocked']),
    duplicate: z.boolean().optional(), error: z.string().regex(/^memory_move_[a-z_]+$/).optional() });
export type DotMemoryMoveReceipt = z.infer<typeof DotMemoryMoveReceiptSchema>;

/** Only opaque IDs and revisions survive an app restart. No credentials, keys or memory values are stored. */
const pending = new MMKV({ id: 'dot-memory-moves' });
export function loadDotMemoryMoves(scope: string): DotMemoryMoveIntent[] {
    try {
        const raw = pending.getString(scope);
        return raw ? z.array(DotMemoryMoveIntentSchema).parse(JSON.parse(raw)) : [];
    }
    catch { throw new Error('memory_move_local_recovery_invalid'); }
}
export function saveDotMemoryMove(scope: string, intent: DotMemoryMoveIntent) {
    const intents = loadDotMemoryMoves(scope).filter(item => item.requestID !== intent.requestID);
    pending.set(scope, JSON.stringify([...intents, DotMemoryMoveIntentSchema.parse(intent)]));
}
export function clearDotMemoryMove(scope: string, requestID: string) {
    pending.set(scope, JSON.stringify(loadDotMemoryMoves(scope).filter(item => item.requestID !== requestID)));
}

export function targetMemoryScope(source: MemoryScope): MemoryScope { return source === 'dot' ? 'user' : 'dot'; }
export async function requestDotMemoryMove(sessionId: string, action: 'prepare' | 'move' | 'status' | 'cancel', intent: DotMemoryMoveIntent): Promise<DotMemoryMoveReceipt> {
    const checked = DotMemoryMoveIntentSchema.safeParse(intent);
    if (!checked.success || action === 'move' && checked.data.targetRevision === undefined) throw new Error('memory_move_invalid_request');
    const { targetRevision, ...source } = checked.data;
    const request = action === 'status' || action === 'cancel' ? { schemaVersion: 1, action, dotId: intent.dotId, requestID: intent.requestID }
        : { schemaVersion: 1, action, ...source, ...(action === 'move' ? { targetRevision } : {}) };
    let raw: unknown;
    try { raw = await apiSocket.sessionRPC(sessionId, 'testloop-dot-memory-move', request); }
    catch { throw new Error('memory_move_transport_unconfirmed'); }
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: DotMemoryMoveReceiptSchema }),
        z.object({ ok: z.literal(false), error: z.string().regex(/^memory_move_[a-z_]+$/) })]).safeParse(raw);
    if (!envelope.success) throw new Error('memory_move_invalid_response');
    if (!envelope.data.ok) throw new Error(envelope.data.error);
    const result = envelope.data.data;
    // Prepare may discover an older unfinished journal for this source key. It never authorizes automatic continuation.
    const discovered = action === 'prepare' && result.requestID !== intent.requestID && result.sourceRevision <= intent.sourceRevision;
    if (action !== 'prepare' && result.requestID !== intent.requestID || result.dotId !== intent.dotId || result.keyDigest !== intent.keyDigest
        || result.sourceScope !== intent.sourceScope || result.targetScope !== targetMemoryScope(intent.sourceScope)
        || !discovered && result.sourceRevision !== intent.sourceRevision || intent.targetRevision !== undefined && result.targetExpectedRevision !== intent.targetRevision)
        throw new Error('memory_move_invalid_response');
    return result;
}

export function dotMemoryMoveError(failure: unknown) {
    const code = failure instanceof Error ? failure.message : '';
    return ({ memory_move_target_conflict: '目标已有同名有效记忆，未覆盖。请先另存为不同名称，再重新移动。',
        memory_move_invalid_request: '移动请求无法核对，请刷新记忆后重试。',
        memory_move_source_changed: '这条记忆已变化，请刷新后重新移动。', memory_move_target_changed: '目标记忆已变化，请刷新后重新移动。',
        memory_move_revision_conflict: '记忆版本已变化，请刷新后重新移动。',
        memory_move_not_authorized: '移动授权不可用，请核对账号、Dot 绑定及两层记忆的读取、写入和忘记权限。',
        memory_move_identity_unavailable: '用户级记忆暂不可用，请核对宿主账号认证。',
        memory_move_identity_changed: '宿主账号已变化，已停止继续移动，请重新核对账号。',
        memory_move_source_unavailable: '源记忆已过期、未确认或不可用，请刷新后核对。',
        memory_move_request_conflict: '移动请求与原记录不一致，已停止。请核对宿主移动记录。',
        memory_move_incomplete: '上次移动尚未处理完，请使用原请求恢复并核对结果。',
        memory_move_busy: '记忆正在被其他操作使用，请稍后恢复上次移动。',
        memory_move_limit: '目标记忆已达到容量限制，请先整理后恢复上次移动。',
        memory_move_transport_unconfirmed: '未收到移动回执，结果尚未确认。请恢复上次移动，避免重复操作。',
        memory_move_invalid_response: '移动回执无法核对。请核对宿主版本后恢复上次移动。',
        memory_move_local_recovery_invalid: '本机移动恢复记录无法读取，请先核对宿主移动记录。',
        memory_move_not_found: '宿主尚无这次移动记录，可以使用原请求继续。',
    } as Record<string, string>)[code] ?? '移动暂未完成，请核对授权并恢复上次移动。';
}

export function dotMemoryMoveNotice(receipt: DotMemoryMoveReceipt) {
    if (receipt.status === 'abandoned') return '已停止本次移动，已有副本保留，请核对整理两层记忆；这不会回滚已保存的记录。';
    if (receipt.status === 'target_saved') return '目标已持久保存，源记录尚未删除；移动未完成，请恢复上次移动。';
    if (receipt.status === 'needs_attention') return '移动需要核对，尚不能确认完成；源或目标可能已变化，请保留记录并检查。';
    if (receipt.status === 'ready') return '移动已准备，请恢复上次移动以继续。';
    return `已在本地移至${receipt.targetScope === 'user' ? '用户级' : '当前 Dot'}。${receipt.indexing === 'superseded' ? '该目标版本后来已变更或失效。' : receipt.indexing === 'indexed' ? '索引已完成。' : receipt.indexing === 'blocked' ? '索引暂受阻。' : '索引中。'}${receipt.cleanup === 'complete' ? '远端清理已完成。' : receipt.cleanup === 'blocked' ? '远端清理暂受阻。' : '远端清理中。'}`;
}
