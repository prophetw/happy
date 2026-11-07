import { z } from 'zod';

export const TESTLOOP_DOTS_PREFIX = 'TESTLOOP_DOTS_V1\n';
const uuid = z.string().uuid();
const sessionId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);

export const TestloopDotsMetadataSchema = z.discriminatedUnion('kind', [
    z.object({ schemaVersion: z.literal(1), kind: z.literal('workspace'), workspaceId: uuid }).passthrough(),
    z.object({ schemaVersion: z.literal(1), kind: z.literal('dot'), workspaceId: uuid,
        workspaceSessionId: sessionId, dotId: uuid, instruction: z.string().max(2000).optional() }).passthrough(),
]);
export type TestloopDotsMetadata = z.infer<typeof TestloopDotsMetadataSchema>;

export function readTestloopDotsMetadata(metadata: unknown): TestloopDotsMetadata | null {
    if (!metadata || typeof metadata !== 'object' || !('testloopDots' in metadata)) return null;
    const parsed = TestloopDotsMetadataSchema.safeParse(metadata.testloopDots);
    return parsed.success ? parsed.data : null;
}

const modelSettings = z.object({ agent: z.literal('codex'), model: z.string().min(1), effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) }).strict();
export const TestloopDotsRequestSchema = z.discriminatedUnion('action', [
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('list') }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('create'),
        name: z.string().trim().min(1).max(80), instruction: z.string().trim().min(1).max(2000), settings: modelSettings.optional() }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('update'), dotId: uuid,
        name: z.string().trim().min(1).max(80), instruction: z.string().trim().min(1).max(2000), settings: modelSettings.optional() }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('clear'), dotId: uuid }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('delete'), dotId: uuid }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('inspect'), dotId: uuid }).strict(),
]);
export type TestloopDotsRequest = z.infer<typeof TestloopDotsRequestSchema>;

export function testloopDotsCommand(raw: TestloopDotsRequest): string {
    return '/dots ' + JSON.stringify(TestloopDotsRequestSchema.parse(raw));
}

const workSummary = z.object({ id: uuid, title: z.string().max(200), kind: z.string().max(60), status: z.string().max(80),
    needsReview: z.boolean(), projectID: z.string().max(200).nullable(), goalPhase: z.string().max(80).nullable() });
const workDetail = workSummary.extend({ instruction: z.string().max(600), runId: uuid.nullable(), reason: z.string().max(200).nullable(),
    nextWakeAt: z.string().nullable(), finishedAt: z.string().nullable(), executionSessionId: sessionId.nullable(),
    executionOutcome: z.string().max(80).nullable(), businessVerification: z.string().max(80),
    steps: z.array(z.object({ id: z.string().max(100), title: z.string().max(500), status: z.string().max(80) })).max(10),
    result: z.string().max(1200).nullable(), resultTruncated: z.boolean() });
const dotDetail = z.object({ dotId: uuid, taskTotal: z.number().int().nonnegative(), tasks: z.array(workDetail).max(10),
    memory: z.object({ total: z.number().int().nonnegative(), omittedCount: z.number().int().nonnegative(),
        access: z.array(z.enum(['read', 'write', 'forget'])), items: z.array(z.object({ key: z.string().max(200), value: z.unknown(),
            kind: z.enum(['fact', 'preference', 'commitment']), revision: z.number().int().positive(), verified: z.boolean(),
            expired: z.boolean(), expiresAt: z.string().nullable() })).max(10) }).nullable() });
const workbench = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), asOf: z.string(),
    dots: z.array(z.object({ id: uuid, available: z.boolean(), taskTotal: z.number().int().nonnegative().nullable(),
        tasks: z.array(workSummary).max(5), error: z.string().max(200).optional() })).max(9), detail: dotDetail.optional() });

export const TestloopDotsSnapshotSchema = z.object({
    schemaVersion: z.literal(1), workspaceId: uuid, revision: z.number().int().nonnegative(), requestId: uuid,
    ok: z.boolean(), error: z.string().max(1000).optional(),
    dots: z.array(z.object({ id: uuid, name: z.string().min(1).max(80), instruction: z.string().max(2000),
        sessionId, conversationEpoch: z.number().int().nonnegative().optional(), status: z.literal('active'), settings: modelSettings.optional() }).strict()).max(1000),
    deletedDot: z.object({ id: uuid, sessionId }).strict().optional(),
    modelOptions: z.array(z.object({ code: z.string(), value: z.string(), thinkingLevels: z.array(z.string()), defaultThinkingLevel: z.string() })).optional(),
    limits: z.unknown().optional(),
    workbench: workbench.optional(),
}).passthrough().refine(value => new Set(value.dots.map(dot => dot.id)).size === value.dots.length
    && new Set(value.dots.map(dot => dot.sessionId)).size === value.dots.length, 'duplicate_dot_binding')
    .refine(value => !value.deletedDot || (value.ok
        && !value.dots.some(dot => dot.id === value.deletedDot!.id || dot.sessionId === value.deletedDot!.sessionId)), 'invalid_deleted_dot_binding')
    .refine(value => !value.workbench || (new Set(value.workbench.dots.map(dot => dot.id)).size === value.workbench.dots.length
        && value.workbench.dots.every(dot => value.dots.some(item => item.id === dot.id))
        && (!value.workbench.detail || value.dots.some(dot => dot.id === value.workbench!.detail!.dotId))), 'workbench_dot_binding_changed');
export type TestloopDotsSnapshot = z.infer<typeof TestloopDotsSnapshotSchema>;
export type TestloopDot = TestloopDotsSnapshot['dots'][number];
export type TestloopDotDetail = z.infer<typeof dotDetail>;
export type TestloopDotWork = z.infer<typeof workDetail>;

type WorkspaceMessage = { kind: string; id: string; createdAt: number; text?: string; meta?: { sentFrom?: string } };
type ReceivedSnapshot = { snapshot: TestloopDotsSnapshot; createdAt: number; id: string };

/** Only host agent replies can supply the directory; user messages are commands, never receipts. */
function snapshotFromMessage(message: WorkspaceMessage, workspaceId: string): TestloopDotsSnapshot | null {
    if (message.kind !== 'agent-text' || message.meta?.sentFrom !== 'testloop-assistant'
        || !message.text?.startsWith(TESTLOOP_DOTS_PREFIX) || message.text.length > 128 * 1024) return null;
    try {
        const parsed = TestloopDotsSnapshotSchema.safeParse(JSON.parse(message.text.slice(TESTLOOP_DOTS_PREFIX.length)));
        return parsed.success && parsed.data.workspaceId === workspaceId ? parsed.data : null;
    } catch { return null; }
}

function commandFromMessage(message: WorkspaceMessage): TestloopDotsRequest | null {
    if (message.kind !== 'user-text' || !message.text?.startsWith('/dots ') || message.text.length > 12000) return null;
    try {
        const parsed = TestloopDotsRequestSchema.safeParse(JSON.parse(message.text.slice('/dots '.length)));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

const compareMessages = (left: { createdAt: number; id: string }, right: { createdAt: number; id: string }) =>
    left.createdAt - right.createdAt || left.id.localeCompare(right.id);

/** Reconstructs state and unanswered requests from the actual encrypted session history. */
export function projectTestloopDotsMessages(messages: readonly WorkspaceMessage[], workspaceId: string) {
    const received: ReceivedSnapshot[] = [];
    const commands: { request: TestloopDotsRequest; createdAt: number; id: string }[] = [];
    for (const message of messages) {
        const snapshot = snapshotFromMessage(message, workspaceId);
        if (snapshot) received.push({ snapshot, createdAt: message.createdAt, id: message.id });
        const request = commandFromMessage(message);
        if (request) commands.push({ request, createdAt: message.createdAt, id: message.id });
    }
    received.sort((left, right) => left.snapshot.revision - right.snapshot.revision
        || (left.snapshot.workbench?.revision ?? -1) - (right.snapshot.workbench?.revision ?? -1) || compareMessages(left, right));
    const receipts: Record<string, TestloopDotsSnapshot> = Object.create(null);
    const details: Record<string, { data: TestloopDotDetail; asOf: string }> = Object.create(null);
    for (const row of received) {
        const view = row.snapshot.workbench;
        if (row.snapshot.ok && view?.detail) details[view.detail.dotId] = { data: view.detail, asOf: view.asOf };
    }
    for (const row of [...received].sort(compareMessages)) receipts[row.snapshot.requestId] = row.snapshot;
    commands.sort(compareMessages);
    const requests = new Map(commands.map(row => [row.request.requestId, row.request]));
    const deletions: Record<string, { requestId: string; revision: number; id: string; sessionId: string }> = Object.create(null);
    for (const [receiptId, receipt] of Object.entries(receipts)) {
        const request = requests.get(receiptId);
        if (!receipt.ok || !receipt.deletedDot || request?.action !== 'delete' || request.dotId !== receipt.deletedDot.id) continue;
        deletions[receiptId] = { requestId: receiptId, revision: receipt.revision, ...receipt.deletedDot };
    }
    const pending = commands.filter(row => !receipts[row.request.requestId]).at(-1)?.request ?? null;
    return { snapshot: received.at(-1)?.snapshot ?? null, receipts, deletions, details, pendingRequest: pending };
}

export function testloopWorkStatus(task: { status: string; needsReview: boolean; goalPhase?: string | null }) {
    const stopped: Record<string, string> = { paused: '已暂停', canceled: '已取消', failed: '执行失败', blocked: '遇到阻塞' };
    if (stopped[task.status]) return stopped[task.status];
    if (task.needsReview) return '执行已结束，待验收';
    if (task.goalPhase === 'reviewing') return '独立验收中';
    if (task.goalPhase === 'repairing') return '返工中';
    const labels: Record<string, string> = { queued: '等待执行', preparing: '准备中', running: '执行中', paused: '已暂停',
        creating: '创建执行会话', created: '会话已创建，尚未交办', canceling: '正在取消',
        awaiting_user: '等待你的答复', awaiting_approval: '等待审批', blocked: '遇到阻塞', failed: '执行失败',
        completed: '已完成', succeeded: '已完成', canceled: '已取消', scheduled: '待执行', deferred: '已延后',
        waiting_event: '等待事件', unscheduled: '没有后续安排' };
    return labels[task.status] ?? task.status;
}

const LimitsDisplaySchema = z.object({ config: z.object({ maxDailyLoopCalls: z.number().int().nonnegative(),
    maxDailyConversationCalls: z.number().int().nonnegative().optional() }).passthrough(),
    modelCallsReserved: z.number().int().nonnegative(), conversationCallsReserved: z.number().int().nonnegative(),
}).passthrough();

export function testloopDotsLimitsText(limits: unknown): string | null {
    const parsed = LimitsDisplaySchema.safeParse(limits);
    if (!parsed.success) return null;
    const { config, modelCallsReserved, conversationCallsReserved } = parsed.data;
    return `账户今日对话 ${conversationCallsReserved}/${config.maxDailyConversationCalls ?? 0} · 模型池 ${modelCallsReserved}/${config.maxDailyLoopCalls}`;
}

/** Only a newer conversation epoch can retire an offline cached session. */
export function retiredDotSessionIds(snapshot: TestloopDotsSnapshot, sessions: readonly { id: string; metadata: unknown }[]): string[] {
    if (!snapshot.ok) return [];
    return sessions.flatMap(session => {
        const binding = readTestloopDotsMetadata(session.metadata);
        if (binding?.kind !== 'dot' || binding.workspaceId !== snapshot.workspaceId) return [];
        const current = snapshot.dots.find(dot => dot.id === binding.dotId);
        const epoch = binding.conversationEpoch;
        return current && current.sessionId !== session.id && (current.conversationEpoch ?? 0) > (typeof epoch === 'number' ? epoch : 0) ? [session.id] : [];
    });
}
