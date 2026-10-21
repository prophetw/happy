import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { CodexCommunicationHandler } from './communicationHandler';
import { emitReadyIfIdle } from '../emitReadyIfIdle';

function setup(initial: AgentState = {}) {
    let state: AgentState = initial;
    let reply!: (value: unknown) => Promise<unknown>;
    const emit = vi.fn();
    const sendAnswer = vi.fn(async (_text: string) => {});
    const metadata = { path: '/project', summary: { text: 'Project work', updatedAt: 1 } };
    const push = { sendSessionNotification: vi.fn() };
    const session = {
        sessionId: 'session',
        getMetadata: () => metadata,
        updateAgentState: (update: (state: AgentState) => AgentState) => { state = update(state); },
        sendSessionProtocolMessage: emit,
        rpcHandlerManager: { registerHandler: (_name: string, handler: typeof reply) => { reply = handler; } },
    } as unknown as ApiSessionClient;
    const handler = new CodexCommunicationHandler(session, sendAnswer, push);
    return { handler, state: () => state, reply: (value: unknown) => reply(value), emit, sendAnswer, push, metadata };
}

const native = {
    threadId: 'thread', turnId: 'turn', itemId: 'item',
    questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'Blue theme' }] }],
};
const asyncQuestion = {
    threadId: 'thread', turnId: 'turn', itemId: 'async',
    questions: [{ title: 'Which color?', options: ['Blue', 'Red'] }],
};

describe('Codex user questions', () => {
    it.each([true, false])('notifies for a native question with isBlocking=%s', async (isBlocking) => {
        const test = setup();
        const result = test.handler.requestNative('42', { ...native, isBlocking });
        expect(test.handler.hasPendingQuestions()).toBe(true);
        expect(test.push.sendSessionNotification).toHaveBeenCalledExactlyOnceWith({
            kind: 'question', metadata: test.metadata,
            data: {
                sessionId: 'session', type: 'question_request', provider: 'codex',
                tool: 'request_user_input', toolCallId: 'codex-input:thread:turn:item:42',
            },
        });
        test.handler.resolveNative('42');
        await result;
        expect(test.handler.hasPendingQuestions()).toBe(false);
    });

    it('notifies once for an async question even when its event is replayed', () => {
        const test = setup();
        test.handler.addAsync(asyncQuestion);
        test.handler.addAsync(asyncQuestion);
        expect(test.push.sendSessionNotification).toHaveBeenCalledExactlyOnceWith({
            kind: 'question', metadata: test.metadata,
            data: {
                sessionId: 'session', type: 'question_request', provider: 'codex',
                tool: 'request_user_input', toolCallId: 'codex-async:thread:async',
            },
        });
    });

    it('does not notify for empty questions', async () => {
        const test = setup();
        await test.handler.requestNative('42', { ...native, questions: [] });
        test.handler.addAsync({ ...asyncQuestion, questions: [] });
        expect(test.push.sendSessionNotification).not.toHaveBeenCalled();
    });

    it('keeps the question reminder until the async answer has been delivered', async () => {
        const test = setup();
        const sendReady = vi.fn();
        const completeTurn = () => emitReadyIfIdle({
            pending: null, queueSize: () => 0, shouldExit: false, sendReady,
            hasPendingQuestions: test.handler.hasPendingQuestions(),
        });
        test.handler.addAsync(asyncQuestion);
        expect(completeTurn()).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
        expect(test.handler.hasBlockingRequests()).toBe(false);

        const id = 'codex-async:thread:async';
        const questionId = test.state().communications![id].form.questions[0].id;
        test.sendAnswer.mockRejectedValueOnce(new Error('offline'));
        const answer = { id, kind: 'form', status: 'answered', answers: { [questionId]: { options: ['Blue'] } } };
        await expect(test.reply(answer)).rejects.toThrow('offline');
        expect(completeTurn()).toBe(false);
        await test.reply(answer);
        expect(completeTurn()).toBe(true);
        expect(sendReady).toHaveBeenCalledOnce();
        expect(test.push.sendSessionNotification).toHaveBeenCalledOnce();
    });

    it('returns structured native answers, including free text, through the communication RPC', async () => {
        const test = setup();
        const result = test.handler.requestNative('42', native);
        expect(test.handler.hasBlockingRequests()).toBe(true);
        await test.reply({ id: 'codex-input:thread:turn:item:42', kind: 'form', status: 'answered', answers: { color: { options: [], custom: 'Green' } } });
        expect(await result).toEqual({ answers: { color: { answers: ['Green'] } } });
        expect(test.state().communications).toEqual({});
        expect(test.state().completedCommunications?.['codex-input:thread:turn:item:42'].status).toBe('answered');
        expect(test.sendAnswer).not.toHaveBeenCalled();
    });

    it('keeps asynchronous questions answerable after native request cleanup', async () => {
        const test = setup();
        const nativeAnswer = test.handler.requestNative('42', native);
        test.handler.addAsync(asyncQuestion);
        test.handler.resolveNative('42');
        await nativeAnswer;
        expect(test.handler.hasBlockingRequests()).toBe(false);
        const id = 'codex-async:thread:async';
        const question = test.state().communications![id].form.questions[0];
        await test.reply({ id, kind: 'form', status: 'answered', answers: { [question.id]: { options: ['Blue'] } } });
        expect(test.sendAnswer).toHaveBeenCalledExactlyOnceWith('Which color?\nBlue');
        expect(test.state().completedCommunications?.[id].status).toBe('answered');
        test.handler.addAsync(asyncQuestion);
        expect(test.state().communications).toEqual({});
    });

    it('does not hide a new question when a restarted server reuses a request id', async () => {
        const test = setup();
        const first = test.handler.requestNative('42', native);
        await test.reply({ id: 'codex-input:thread:turn:item:42', kind: 'form', status: 'answered', answers: { color: { options: ['Blue'] } } });
        await first;
        const second = test.handler.requestNative('42', { ...native, turnId: 'next', itemId: 'other' });
        expect(Object.keys(test.state().communications!)).toEqual(['codex-input:thread:next:other:42']);
        expect(test.state().completedCommunications?.['codex-input:thread:next:other:42']).toBeUndefined();
        test.handler.resolveNative('42');
        await second;
    });

    it('retires stale Codex questions when replacing the CLI without dropping other forms', () => {
        const communication = {
            kind: 'form' as const, createdAt: 1, toolUseId: 'old', isBlocking: true,
            form: { questions: [] },
        };
        const test = setup({ communications: { 'codex-input:old': communication, unrelated: communication } });
        expect(Object.keys(test.state().communications!)).toEqual(['unrelated']);
        expect(test.state().completedCommunications?.['codex-input:old'].status).toBe('cancelled');
        expect(test.push.sendSessionNotification).not.toHaveBeenCalled();
    });

    it('clears an expired native request without cancelling other questions', async () => {
        const test = setup();
        const result = test.handler.requestNative('42', { ...native, isBlocking: false });
        test.handler.addAsync(asyncQuestion);
        test.handler.resolveNative('42');
        expect(await result).toEqual({ answers: {} });
        expect(Object.keys(test.state().communications!)).toEqual(['codex-async:thread:async']);
        expect(test.handler.hasBlockingRequests()).toBe(false);
    });

    it('leaves the question pending when answer delivery fails, so the user can retry', async () => {
        const test = setup();
        test.handler.addAsync(asyncQuestion);
        const id = 'codex-async:thread:async';
        const questionId = test.state().communications![id].form.questions[0].id;
        const reply = { id, kind: 'form', status: 'answered', answers: { [questionId]: { options: ['Red'] } } };
        test.sendAnswer.mockRejectedValueOnce(new Error('offline'));
        await expect(test.reply(reply)).rejects.toThrow('offline');
        expect(test.state().communications?.[id]).toBeDefined();
        await test.reply(reply);
        expect(test.state().completedCommunications?.[id].status).toBe('answered');
    });

    it('does not deliver the same async answer twice when two devices submit concurrently', async () => {
        const test = setup();
        test.handler.addAsync(asyncQuestion);
        const id = 'codex-async:thread:async';
        const questionId = test.state().communications![id].form.questions[0].id;
        const reply = { id, kind: 'form', status: 'answered', answers: { [questionId]: { options: ['Red'] } } };
        const first = test.reply(reply);
        await expect(test.reply(reply)).rejects.toThrow('already being sent');
        await first;
        expect(test.sendAnswer).toHaveBeenCalledOnce();
    });
});
