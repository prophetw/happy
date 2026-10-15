import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { CodexCommunicationHandler } from './communicationHandler';

function setup() {
    let state: AgentState = {};
    let reply!: (value: unknown) => Promise<unknown>;
    const emit = vi.fn();
    const sendAnswer = vi.fn(async (_text: string) => {});
    const session = {
        updateAgentState: (update: (state: AgentState) => AgentState) => { state = update(state); },
        sendSessionProtocolMessage: emit,
        rpcHandlerManager: { registerHandler: (_name: string, handler: typeof reply) => { reply = handler; } },
    } as unknown as ApiSessionClient;
    const handler = new CodexCommunicationHandler(session, sendAnswer);
    return { handler, state: () => state, reply: (value: unknown) => reply(value), emit, sendAnswer };
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
    it('returns structured native answers, including free text, through the communication RPC', async () => {
        const test = setup();
        const result = test.handler.requestNative('42', native);
        expect(test.handler.hasBlockingRequests()).toBe(true);
        await test.reply({ id: 'codex-input:thread:42', kind: 'form', status: 'answered', answers: { color: { options: [], custom: 'Green' } } });
        expect(await result).toEqual({ answers: { color: { answers: ['Green'] } } });
        expect(test.state().communications).toEqual({});
        expect(test.state().completedCommunications?.['codex-input:thread:42'].status).toBe('answered');
        expect(test.sendAnswer).not.toHaveBeenCalled();
    });

    it('keeps asynchronous questions answerable after native turn cleanup', async () => {
        const test = setup();
        test.handler.addAsync(asyncQuestion);
        expect(test.handler.hasBlockingRequests()).toBe(false);
        test.handler.cancelNativeRequests();
        const id = 'codex-async:thread:async';
        const question = test.state().communications![id].form.questions[0];
        await test.reply({ id, kind: 'form', status: 'answered', answers: { [question.id]: { options: ['Blue'] } } });
        expect(test.sendAnswer).toHaveBeenCalledExactlyOnceWith('Which color?\nBlue');
        expect(test.state().completedCommunications?.[id].status).toBe('answered');
        test.handler.addAsync(asyncQuestion);
        expect(test.state().communications).toEqual({});
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
