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

export const TestloopDotsRequestSchema = z.discriminatedUnion('action', [
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('list') }).strict(),
    z.object({ schemaVersion: z.literal(1), requestId: uuid, action: z.literal('create'),
        name: z.string().trim().min(1).max(80), instruction: z.string().trim().min(1).max(2000) }).strict(),
]);
export type TestloopDotsRequest = z.infer<typeof TestloopDotsRequestSchema>;

export function testloopDotsCommand(raw: TestloopDotsRequest): string {
    return '/dots ' + JSON.stringify(TestloopDotsRequestSchema.parse(raw));
}

export const TestloopDotsSnapshotSchema = z.object({
    schemaVersion: z.literal(1), workspaceId: uuid, revision: z.number().int().nonnegative(), requestId: uuid,
    ok: z.boolean(), error: z.string().max(1000).optional(),
    dots: z.array(z.object({ id: uuid, name: z.string().min(1).max(80), instruction: z.string().max(2000),
        sessionId, status: z.literal('active') }).strict()).max(1000),
    limits: z.unknown().optional(),
}).passthrough().refine(value => new Set(value.dots.map(dot => dot.id)).size === value.dots.length
    && new Set(value.dots.map(dot => dot.sessionId)).size === value.dots.length, 'duplicate_dot_binding');
export type TestloopDotsSnapshot = z.infer<typeof TestloopDotsSnapshotSchema>;
export type TestloopDot = TestloopDotsSnapshot['dots'][number];

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
    received.sort((left, right) => left.snapshot.revision - right.snapshot.revision || compareMessages(left, right));
    const receipts: Record<string, TestloopDotsSnapshot> = Object.create(null);
    for (const row of received) receipts[row.snapshot.requestId] = row.snapshot;
    commands.sort(compareMessages);
    const pending = commands.filter(row => !receipts[row.request.requestId]).at(-1)?.request ?? null;
    return { snapshot: received.at(-1)?.snapshot ?? null, receipts, pendingRequest: pending };
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
