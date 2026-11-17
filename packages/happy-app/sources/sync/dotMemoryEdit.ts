import { z } from 'zod';
import * as Crypto from 'expo-crypto';
import { apiSocket } from './apiSocket';
import { ObservationMemorySchema, requestDotObservation, type MemoryScope } from './dotObservation';

const id = z.string().uuid(), revision = z.number().int().nonnegative();
export const DOT_MEMORY_VALUE_MAX_BYTES = 4096;
export function dotMemoryValueBytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
const memoryValue = z.json().refine(value => dotMemoryValueBytes(value) <= DOT_MEMORY_VALUE_MAX_BYTES);
const operation = z.discriminatedUnion('action', [
    z.object({ action: z.literal('remember'), key: z.string().min(1).max(200), revision,
        kind: z.enum(['fact', 'preference', 'commitment']), value: memoryValue, expiresAt: z.string().datetime({ offset: true }).nullable().default(null) }).strict(),
    z.object({ action: z.literal('forget'), key: z.string().min(1).max(200), revision: revision.positive() }).strict(),
]);
const requestSchema = z.object({ schemaVersion: z.literal(1), workspaceId: id, dotId: id,
    dotSessionId: z.string().min(1), scope: z.enum(['dot', 'user']), requestID: id, operation }).strict();
const receiptSchema = requestSchema.omit({ operation: true }).extend({ action: z.enum(['remember', 'forget']),
    keyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), revision: revision.positive(), currentRevision: revision.positive(),
    currentStatus: z.enum(['active', 'deleted']), duplicate: z.boolean(), indexing: z.enum(['pending', 'not_required']) });
export type DotMemoryEditRequest = z.infer<typeof requestSchema>;
export type DotMemoryEditReceipt = z.infer<typeof receiptSchema>;

/** Reads only public metadata; deleted memory keys and values remain erased on the host. */
export async function readDotMemoryTombstone(sessionId: string, dotId: string, scope: MemoryScope, key: string): Promise<number | null> {
    const input = new TextEncoder().encode(JSON.stringify(key.trim().normalize('NFC')));
    const hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, input);
    const keyDigest = 'sha256:' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    try {
        const result = await requestDotObservation(sessionId, { dotId, action: 'memory', keyDigest, scope }, ObservationMemorySchema);
        return result.memory.status === 'deleted' ? result.memory.revision : null;
    } catch (error) {
        if (error instanceof Error && error.message === 'observation_memory_not_found') return null;
        throw error;
    }
}

export async function requestDotMemoryEdit(sessionId: string, request: DotMemoryEditRequest): Promise<DotMemoryEditReceipt> {
    const checked = requestSchema.safeParse(request);
    if (!checked.success) throw new Error('memory_edit_invalid_request');
    let raw: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    try {
        raw = await Promise.race([apiSocket.sessionRPC(sessionId, 'testloop-dot-memory-edit', checked.data),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); })]);
    } catch { throw new Error('memory_edit_transport_unconfirmed'); }
    finally { clearTimeout(timer); }
    const parsed = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: receiptSchema }),
        z.object({ ok: z.literal(false), error: z.string().regex(/^memory_edit_[a-z_]+$/) })]).safeParse(raw);
    if (!parsed.success) throw new Error('memory_edit_invalid_response');
    if (!parsed.data.ok) throw new Error(parsed.data.error);
    const result = parsed.data.data;
    if (result.workspaceId !== request.workspaceId || result.dotId !== request.dotId || result.dotSessionId !== request.dotSessionId
        || result.scope !== request.scope || result.requestID !== request.requestID || result.action !== request.operation.action
        || result.revision !== request.operation.revision + 1 || result.currentRevision < result.revision
        || result.currentRevision === result.revision && result.currentStatus !== (result.action === 'remember' ? 'active' : 'deleted'))
        throw new Error('memory_edit_invalid_response');
    return result;
}

// Only explicit pre-commit refusals allow editing the request; all other outcomes keep its ID and payload.
export function dotMemoryEditRejected(error: unknown) {
    return error instanceof Error && ['invalid_request', 'not_authorized', 'binding_changed', 'revision_conflict', 'request_conflict',
        'identity_changed', 'identity_unavailable', 'expired', 'not_found', 'limit', 'busy'].some(code => error.message === `memory_edit_${code}`);
}
export function dotMemoryEditError(error: unknown): string {
    const code = error instanceof Error ? error.message : '';
    return ({
        memory_edit_revision_conflict: '这条记忆已有更新，未覆盖。草稿已保留，请关闭后刷新记忆并重新编辑。',
        memory_edit_not_authorized: '当前没有修改这条记忆的权限，请核对连接与授权。草稿已保留。',
        memory_edit_binding_changed: 'Dot 会话已变化，未继续保存。请刷新工作台后重试。',
        memory_edit_identity_changed: '宿主账号已变化，未继续保存。请核对账号后重试。',
        memory_edit_identity_unavailable: '用户级记忆暂不可用，请核对宿主账号连接后重试。',
        memory_edit_expired: '有效期已过，请修改为未来时间或清空有效期。',
        memory_edit_not_found: '这条记忆已不存在，请刷新后核对。',
        memory_edit_limit: '记忆已达到容量限制，请先整理记忆后重试。',
        memory_edit_busy: '这条记忆正在处理中，请稍后重试。',
        memory_edit_request_conflict: '请求与原记录不一致，未覆盖原操作。请刷新后核对。',
        memory_edit_invalid_request: '记忆内容或版本无法核对，请检查输入后重试。',
    } as Record<string, string>)[code] ?? '尚未收到可核对的保存回执。内容已保留，请重试上次记忆操作以核对结果。';
}
