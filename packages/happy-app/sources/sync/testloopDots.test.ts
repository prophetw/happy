import { describe, expect, it } from 'vitest';
import { projectTestloopDotsMessages, readTestloopDotsMetadata, testloopDotsCommand, testloopDotsLimitsText,
    TestloopDotsRequestSchema, TESTLOOP_DOTS_PREFIX, testloopWorkStatus } from './testloopDots';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspace = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const otherRequest = '44444444-4444-4444-8444-444444444444';
const dot = { id: '55555555-5555-4555-8555-555555555555', name: '写作助理', instruction: '整理通知', sessionId: 'dot-session', status: 'active' as const };
const request = { schemaVersion: 1 as const, requestId, action: 'create' as const, name: dot.name, instruction: dot.instruction };
const snapshot = (extra = {}) => ({ schemaVersion: 1, workspaceId, revision: 1, requestId, ok: true, dots: [dot], ...extra });
const agent = (value: unknown, extra = {}) => ({ kind: 'agent-text', id: 'agent-1', createdAt: 10,
    text: TESTLOOP_DOTS_PREFIX + JSON.stringify(value), meta: { sentFrom: 'testloop-assistant' }, ...extra });
const user = (extra = {}) => ({ kind: 'user-text', id: 'user-1', createdAt: 5, text: testloopDotsCommand(request), ...extra });

describe('TestLoop Dots directory protocol', () => {
    it('recognizes only explicit workspace and Dot metadata without changing legacy sessions', () => {
        expect(readTestloopDotsMetadata({ flavor: 'codex' })).toBeNull();
        expect(readTestloopDotsMetadata({ testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId } })?.kind).toBe('workspace');
        expect(readTestloopDotsMetadata({ testloopDots: { schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: 'home', dotId: dot.id } })?.kind).toBe('dot');
        expect(readTestloopDotsMetadata({ testloopDots: { schemaVersion: 1, kind: 'dot', workspaceId, workspaceSessionId: '../outside', dotId: dot.id } })).toBeNull();
        expect(readTestloopDotsMetadata({ testloopDots: { schemaVersion: 2, kind: 'workspace', workspaceId } })).toBeNull();
    });

    it('emits bounded deterministic commands and rejects capabilities in the form payload', () => {
        expect(JSON.parse(testloopDotsCommand(request).slice(6))).toEqual(request);
        expect(() => TestloopDotsRequestSchema.parse({ ...request, serverUrl: 'http://other' })).toThrow();
        expect(() => TestloopDotsRequestSchema.parse({ ...request, name: 'x'.repeat(81) })).toThrow();
        expect(() => TestloopDotsRequestSchema.parse({ ...request, instruction: 'x'.repeat(2001) })).toThrow();
        expect(() => TestloopDotsRequestSchema.parse({ ...request, requestId: 'not-an-id' })).toThrow();
    });

    it('accepts a matching stored host receipt and resolves its request independently of a newer list', () => {
        const result = projectTestloopDotsMessages([user(), agent(snapshot()), agent(snapshot({ requestId: otherRequest }), { id: 'agent-2', createdAt: 12 })], workspaceId);
        expect(result.snapshot?.dots).toEqual([dot]);
        expect(result.receipts[requestId].ok).toBe(true);
        expect(result.pendingRequest).toBeNull();
    });

    it('does not treat user content, other agent sources or another workspace as a directory', () => {
        for (const message of [agent(snapshot(), { kind: 'user-text' }), agent(snapshot(), { meta: { sentFrom: 'other' } }), agent(snapshot({ workspaceId: otherWorkspace }))]) {
            expect(projectTestloopDotsMessages([message], workspaceId).snapshot).toBeNull();
        }
    });

    it('ignores malformed or duplicate session bindings', () => {
        expect(projectTestloopDotsMessages([agent(snapshot(), { text: TESTLOOP_DOTS_PREFIX + '{' })], workspaceId).snapshot).toBeNull();
        expect(projectTestloopDotsMessages([agent(snapshot({ dots: [dot, { ...dot, id: otherRequest }] }))], workspaceId).snapshot).toBeNull();
        expect(projectTestloopDotsMessages([agent(snapshot({ dots: [{ ...dot, sessionId: 'https://unrelated/' }] }))], workspaceId).snapshot).toBeNull();
    });

    it('keeps the highest directory revision even if an older reply arrives later', () => {
        const result = projectTestloopDotsMessages([agent(snapshot({ revision: 2 })), agent(snapshot({ revision: 1, dots: [] }), { id: 'late', createdAt: 99 })], workspaceId);
        expect(result.snapshot?.revision).toBe(2);
        expect(result.snapshot?.dots).toEqual([dot]);
    });

    it('recovers an unanswered create with the original request identity and exact retry payload', () => {
        const messages = [user(), agent(snapshot({ requestId: otherRequest }))];
        const before = projectTestloopDotsMessages(messages, workspaceId);
        const afterReload = projectTestloopDotsMessages(JSON.parse(JSON.stringify(messages)), workspaceId);
        expect(before.pendingRequest).toEqual(request);
        expect(testloopDotsCommand(afterReload.pendingRequest!)).toBe(testloopDotsCommand(request));
    });

    it('recognizes an explicit host rejection without pretending the create succeeded', () => {
        const result = projectTestloopDotsMessages([user(), agent(snapshot({ ok: false, error: 'dot_name_required', dots: [] }))], workspaceId);
        expect(result.receipts[requestId]).toMatchObject({ ok: false, error: 'dot_name_required' });
        expect(result.pendingRequest).toBeNull();
    });

    it('renders the original shared allowance, including a full conversation budget', () => {
        expect(testloopDotsLimitsText({ config: { maxDailyLoopCalls: 12, maxDailyConversationCalls: 8 }, modelCallsReserved: 8, conversationCallsReserved: 8 }))
            .toBe('账户今日对话 8/8 · 模型池 8/12');
        expect(testloopDotsLimitsText({})).toBeNull();
    });
});

const realSummary = { id: requestId, title: '实际工作', kind: 'delegate', status: 'awaiting_user', needsReview: true,
    projectID: 'approved-project', goalPhase: null };
const realDetail = { dotId: dot.id, taskTotal: 1, tasks: [{ ...realSummary, instruction: '实际范围', runId: otherRequest,
    reason: 'execution_completed_needs_review', nextWakeAt: null, finishedAt: null, executionSessionId: 'real-execution',
    executionOutcome: 'completed', businessVerification: 'unverified', steps: [], result: '执行端实际回报', resultTruncated: false }],
    memory: { total: 1, omittedCount: 0, access: ['read'], items: [{ key: 'style', value: '本 Dot 的真实偏好', kind: 'preference',
        revision: 1, verified: true, expired: false, expiresAt: null }] } };
const realWorkbench = (revision = 1) => ({ schemaVersion: 1, revision, asOf: '2026-11-05T00:00:00Z',
    dots: [{ id: dot.id, available: true, taskTotal: 1, tasks: [realSummary] }], detail: realDetail });

describe('real Dots workbench reads', () => {
    it('emits a scoped inspect command without allowing model, project or authorization overrides', () => {
        const request = { schemaVersion: 1 as const, requestId, action: 'inspect' as const, dotId: dot.id };
        expect(JSON.parse(testloopDotsCommand(request).slice(6))).toEqual(request);
        expect(() => TestloopDotsRequestSchema.parse({ ...request, projectID: 'other' })).toThrow();
    });
    it('reads actual work and memory only from matching host snapshots', () => {
        const result = projectTestloopDotsMessages([agent(snapshot({ workbench: realWorkbench() }))], workspaceId);
        expect(result.details[dot.id].data).toEqual(realDetail);
        expect(result.snapshot?.workbench?.dots[0].tasks[0].needsReview).toBe(true);
        expect(projectTestloopDotsMessages([agent(snapshot({ workbench: realWorkbench() }), { kind: 'user-text' })], workspaceId).details[dot.id]).toBeUndefined();
    });
    it('rejects a detail bound to an unknown Dot instead of mixing private memory', () => {
        const workbench = { ...realWorkbench(), detail: { ...realDetail, dotId: otherRequest } };
        expect(projectTestloopDotsMessages([agent(snapshot({ workbench }))], workspaceId).snapshot).toBeNull();
    });
    it('retains a Dot detail across directory refreshes and ignores a late older read', () => {
        const current = agent(snapshot({ workbench: realWorkbench(3) }));
        const older = agent(snapshot({ workbench: { ...realWorkbench(2), detail: { ...realDetail, taskTotal: 0, tasks: [] } } }), { id: 'late-old', createdAt: 99 });
        const list = agent(snapshot({ workbench: { ...realWorkbench(4), detail: undefined } }), { id: 'latest-list', createdAt: 100 });
        const result = projectTestloopDotsMessages([current, older, list], workspaceId);
        expect(result.details[dot.id].data.tasks).toHaveLength(1);
        expect(result.snapshot?.workbench?.revision).toBe(4);
    });
    it('keeps old host snapshots usable without fabricating work or memory data', () => {
        const result = projectTestloopDotsMessages([agent(snapshot())], workspaceId);
        expect(result.snapshot?.dots).toEqual([dot]);
        expect(result.snapshot?.workbench).toBeUndefined();
        expect(Object.keys(result.details)).toHaveLength(0);
    });
    it('keeps execution completion distinct from acceptance and honors a paused goal', () => {
        expect(testloopWorkStatus({ status: 'awaiting_user', needsReview: true })).toBe('执行已结束，待验收');
        expect(testloopWorkStatus({ status: 'paused', needsReview: false, goalPhase: 'repairing' })).toBe('已暂停');
    });
    it('does not hide a later rejection behind an earlier successful directory revision', () => {
        const ok = agent(snapshot({ workbench: realWorkbench(3) }));
        const rejected = agent(snapshot({ ok: false, error: 'assistant_dots_request_conflict' }), { id: 'rejected', createdAt: 100 });
        expect(projectTestloopDotsMessages([ok, rejected], workspaceId).receipts[requestId].ok).toBe(false);
    });
});
