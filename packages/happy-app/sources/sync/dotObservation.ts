import { z } from 'zod';
import { apiSocket } from './apiSocket';

const id = z.string().uuid(), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.object({ text: z.string().max(16000), truncated: z.boolean() });
const time = z.string().datetime({ offset: true });
const identity = z.object({ name: z.string().max(80), instruction: z.string().max(2000) });
export const observationMemoryStatus = { effective: '有效', unconfirmed: '待确认', expired: '已过期', deleted: '已忘记' };
export const observationReasons = { included: '已带入有效背景', unconfirmed: '未确认', expired: '已过期', deleted: '已忘记',
    entry_limit: '达到条数上限', byte_limit: '达到字节上限', disabled: '未启用记忆背景' };
export type MemoryScope = 'dot' | 'user';
const memoryScope = z.enum(['dot', 'user']).default('dot');
const memoryStatus = z.enum(['effective', 'unconfirmed', 'expired', 'deleted']);
const base = z.object({ schemaVersion: z.literal(1), dotId: id, asOf: time, snapshotId: hash });
const page = <T extends z.ZodTypeAny>(row: T) => z.object({ items: z.array(row).max(20), total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable() });
export const ObservationOverviewSchema = base.extend({ action: z.literal('overview'), scope: memoryScope, dot: identity.extend({ id, createdAt: time }),
    host: z.object({ status: z.enum(['stopped', 'healthy', 'unhealthy']), heartbeatAt: time.nullable(), error: z.string().nullable() }),
    channel: z.object({ lastSuccessAt: time.nullable(), error: z.string().nullable() }), processing: z.boolean(), taskTotal: z.number().int().nonnegative(),
    tasks: z.array(z.object({ id, title: z.string(), status: z.string(), needsReview: z.boolean(), goalPhase: z.string().nullable() })).max(5),
    memory: z.object({ total: z.number().int().nonnegative(), access: z.array(z.enum(['read', 'write', 'forget'])), counts: z.object({ effective: z.number(), unconfirmed: z.number(), expired: z.number(), deleted: z.number() }) }).nullable(),
    retention: z.object({ startedAt: time.nullable(), retainedFrom: time.nullable(), droppedEvents: z.number(), eventLimit: z.number(),
        selectionTurnLimit: z.number(), selectionTurns: z.array(id).max(20) }),
});
const event = z.object({ sequence: z.number().int().positive(), id: z.string(), at: time,
    kind: z.enum(['dot', 'turn', 'run', 'memory', 'memory-proposal', 'delivery']), entityId: z.string(), status: z.string(), previousStatus: z.string().nullable(),
    reason: z.string().nullable(), workId: id.nullable(), turnId: id.nullable(), keyDigest: hash.nullable(), label: z.string().nullable(),
    identity: identity.optional(), previousIdentity: identity.optional() });
export const ObservationActivitySchema = base.extend({ action: z.literal('activity'), page: page(event) });
export const ObservationMemoriesSchema = base.extend({ action: z.literal('memories'), scope: memoryScope, page: page(z.object({
    keyDigest: hash, key: z.string().nullable(), revision: z.number(), status: memoryStatus, kind: z.string().optional(),
    preview: text.optional(), source: z.string().optional(), expiresAt: time.nullable().optional(), deletedAt: time.optional(),
})) });
const turnBase = base.extend({ turnId: id });
const turnSummary = z.object({ id, seq: z.number(), createdAt: time, status: z.string(), source: z.enum(['user', 'execution-result']),
    trigger: text, contextAvailable: z.boolean(), error: z.string().nullable() });
export const ObservationTurnsSchema = base.extend({ action: z.literal('turns'), page: page(turnSummary) });
export const ObservationTurnSchema = turnBase.extend({ action: z.literal('turn'), section: z.literal('overview'), turn: turnSummary.extend({
    reply: text, frozenAt: time.nullable(), identity: identity.nullable(), decisionKind: z.string().nullable(), decision: text, inputDigest: hash.nullable(),
    calls: z.array(z.object({ id, reservedAt: time, finishedAt: time.nullable(), elapsedMs: z.number().nullable(),
        nativeSessionId: z.string().nullable(), model: z.null(), usage: z.null() })).max(2), relatedWork: z.array(id), originRunId: id.nullable(),
    historyTotal: z.number(), memoryReadable: z.boolean(), selectionAvailable: z.boolean(), selectionPolicyVersion: z.number().nullable(),
    deliveries: z.array(z.object({ status: z.enum(['pending', 'accepted', 'stored_verified', 'error']), messageSeq: z.number().nullable(), attempts: z.number(), error: z.string().nullable() })),
}) });
export const ObservationHistorySchema = turnBase.extend({ action: z.literal('turn'), section: z.literal('history'), page: page(z.object({
    seq: z.number(), source: z.string(), status: z.string(), user: text, reply: text, inputTruncated: z.boolean(),
})) });
export const ObservationInputMemorySchema = turnBase.extend({ action: z.literal('turn'), section: z.literal('memory'), contextAvailable: z.boolean(),
    backgroundOmitted: z.number(), catalogOmitted: z.number(), page: page(z.object({ keyDigest: hash, key: z.string(), revision: z.number(),
        value: z.unknown(), kind: z.string(), source: z.string(), sourceRef: z.string().nullable(), verified: z.boolean(),
        expiresAt: time.nullable(), expired: z.boolean(), locations: z.array(z.enum(['background', 'catalog'])),
    })) });
export const ObservationSelectionSchema = turnBase.extend({ action: z.literal('turn'), section: z.literal('selection'), available: z.boolean(),
    policy: z.object({ version: z.number(), asOf: time, enabled: z.boolean(), maxEntries: z.number(), maxBytes: z.number() }).nullable(),
    page: page(z.object({ keyDigest: hash, key: z.string().nullable(), revision: z.number(), reason: z.enum(['included', 'unconfirmed', 'expired', 'deleted', 'entry_limit', 'byte_limit', 'disabled']) })) });
const memoryMetadata = z.object({ keyDigest: hash, key: z.string().nullable(), status: memoryStatus, revision: z.number(), deletedAt: time.nullable() });
export const ObservationMemorySchema = base.extend({ action: z.literal('memory'), section: z.literal('versions'), scope: memoryScope, memory: memoryMetadata,
    page: page(z.object({ revision: z.number(), action: z.enum(['remember', 'confirm']), kind: z.string(), value: z.unknown(), source: z.string(),
        sourceRef: z.string().nullable(), verified: z.boolean(), expiresAt: time.nullable(), recordedAt: time, confirmedAt: time.nullable(), historical: z.boolean() })) });
export const ObservationMemoryUsageSchema = base.extend({ action: z.literal('memory'), section: z.literal('usage'), scope: memoryScope, memory: memoryMetadata,
    page: page(turnSummary.extend({ memoryRevision: z.number() })) });
export const ObservationWorkSchema = base.extend({ action: z.literal('work'), work: z.object({ id, title: z.string(), instruction: z.string(),
    status: z.string(), needsReview: z.boolean(), goalPhase: z.string().nullable(), businessVerification: z.string(),
    executionSessionId: z.string().nullable(), executionOutcome: z.string().nullable(), reason: z.string().nullable(), result: text,
    steps: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })), startedAt: time.nullable(), finishedAt: time.nullable(),
}), page: page(event) });
export const ObservationResponseSchema = z.union([ObservationOverviewSchema, ObservationActivitySchema, ObservationMemoriesSchema,
    ObservationTurnsSchema, ObservationTurnSchema, ObservationHistorySchema, ObservationInputMemorySchema,
    ObservationSelectionSchema, ObservationMemorySchema, ObservationMemoryUsageSchema, ObservationWorkSchema]);
export type ObservationResponse = z.infer<typeof ObservationResponseSchema>;
export type ObservationOverview = z.infer<typeof ObservationOverviewSchema>;
export type ObservationEvent = z.infer<typeof event>;
export type ObservationMemoryVersion = z.infer<typeof ObservationMemorySchema>['page']['items'][number];
export type ObservationRequest = { dotId: string; offset?: number; limit?: number; snapshotId?: string } & (
    { action: 'overview'; scope?: MemoryScope } | { action: 'turns' } | { action: 'activity'; workId?: string } | { action: 'memories'; status?: string; scope?: MemoryScope }
    | { action: 'memory'; scope?: MemoryScope; keyDigest: string; section?: 'versions' | 'usage' }
    | { action: 'turn'; turnId: string; section?: 'overview' | 'history' | 'memory' | 'selection' } | { action: 'work'; workId: string });

export async function requestDotObservation<T extends ObservationResponse>(sessionId: string, request: ObservationRequest, schema: z.ZodType<T>): Promise<T> {
    let reply: unknown;
    try { reply = await apiSocket.sessionRPC(sessionId, 'testloop-dot-observation', { schemaVersion: 1, ...request }); }
    catch { throw new Error('observation_transport_unconfirmed'); }
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.string().regex(/^observation_[a-z_]+$/) })]).safeParse(reply);
    if (!envelope.success) throw new Error('observation_invalid_response');
    if (!envelope.data.ok) throw new Error(envelope.data.error);
    const result = schema.safeParse(envelope.data.data);
    if (!result.success) throw new Error('observation_invalid_response');
    const value = result.data;
    if ('scope' in request && 'scope' in value && value.scope !== (request.scope ?? 'dot')
        || value.dotId !== request.dotId || value.action !== request.action
        || request.action === 'turn' && (value.action !== 'turn' || value.turnId !== request.turnId || value.section !== (request.section ?? 'overview'))
        || request.action === 'memory' && (value.action !== 'memory' || value.memory.keyDigest !== request.keyDigest || value.section !== (request.section ?? 'versions'))
        || request.action === 'work' && (value.action !== 'work' || value.work.id !== request.workId))
        throw new Error('observation_invalid_response');
    return value;
}
export function observationError(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return ({ observation_snapshot_changed: '数据已变化，请刷新后重新翻页。', observation_dot_not_available: '当前 Dot 绑定不可用，请返回工作台核对。',
        observation_memory_permission_denied: '当前 Dot 未授权读取记忆。', observation_turn_not_found: '这条对话记录不可用。',
        observation_user_memory_unavailable: '用户级记忆暂不可用，请核对宿主账号认证、服务器连接和记忆授权后重试。',
        observation_workspace_not_authorized: '当前工作台授权不可用，请返回重新打开。',
        observation_transport_unconfirmed: '未收到观察数据，请检查连接及宿主是否支持观察台，然后刷新。',
        observation_invalid_response: '观察数据格式无法确认，请核对宿主版本后刷新。',
    } as Record<string, string>)[code] ?? '暂时无法读取观察数据，请刷新重试。';
}
