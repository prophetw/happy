import { z } from 'zod';
import { createEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentCommunication, AgentQuestionAnswer } from '@/api/types';
import type {
    AsyncUserInputQuestion,
    ToolRequestUserInputParams,
    ToolRequestUserInputResponse,
} from '../codexAppServerTypes';

const replySchema = z.object({
    id: z.string(),
    kind: z.literal('form'),
    status: z.enum(['answered', 'cancelled']),
    answers: z.record(z.string(), z.object({
        options: z.array(z.string()).default([]),
        custom: z.string().nullish(),
    })).optional(),
});

type Pending = {
    communication: AgentCommunication;
    turnId: string;
    nativeRequestId?: string;
    resolve?: (response: ToolRequestUserInputResponse) => void;
    submitting?: boolean;
};

/** Owns question lifetimes independently of the lifetime of a generation turn. */
export class CodexCommunicationHandler {
    private pending = new Map<string, Pending>();
    private seenAsyncIds = new Set<string>();

    constructor(
        private session: ApiSessionClient,
        private readonly sendAnswer: (text: string) => Promise<void>,
    ) {
        this.registerRpc();
    }

    updateSession(session: ApiSessionClient): void {
        this.session = session;
        this.registerRpc();
        for (const [id, entry] of this.pending) this.publish(id, entry);
    }

    hasBlockingRequests(): boolean {
        return [...this.pending.values()].some(entry => entry.communication.isBlocking);
    }

    requestNative(requestId: string, params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        if (params.questions.length === 0) return Promise.resolve({ answers: {} });
        const id = `codex-input:${params.threadId}:${requestId}`;
        return new Promise(resolve => {
            const communication: AgentCommunication = {
                kind: 'form',
                createdAt: Date.now(),
                toolUseId: id,
                // Older Codex versions omit isBlocking. Their requests block.
                isBlocking: params.isBlocking !== false,
                form: { questions: params.questions.map(question => ({
                    id: question.id,
                    header: question.header,
                    question: question.question,
                    options: question.options ?? [],
                    allowCustom: true,
                    ...(question.isSecret ? { isSecret: true } : {}),
                })) },
            };
            this.add(id, { communication, turnId: params.turnId, nativeRequestId: requestId, resolve });
        });
    }

    addAsync(params: { threadId: string; turnId: string; itemId: string; questions: AsyncUserInputQuestion[] }): void {
        if (params.questions.length === 0) return;
        const id = `codex-async:${params.threadId}:${params.itemId}`;
        if (this.seenAsyncIds.has(id)) return;
        this.seenAsyncIds.add(id);
        this.add(id, {
            turnId: params.turnId,
            communication: {
                kind: 'form', createdAt: Date.now(), toolUseId: id, isBlocking: false,
                form: { questions: params.questions.map((question, index) => ({
                    id: `${id}:${index}`, header: `${index + 1}`, question: question.title,
                    options: (question.options ?? []).map(label => ({ label })), allowCustom: true,
                })) },
            },
        });
    }

    resolveNative(requestId: string): void {
        for (const [id, entry] of this.pending) {
            if (entry.nativeRequestId === requestId) this.finish(id, 'cancelled');
        }
    }

    cancelNativeRequests(): void {
        for (const [id, entry] of this.pending) {
            if (entry.nativeRequestId !== undefined) this.finish(id, 'cancelled');
        }
    }

    cancelAll(): void {
        for (const id of this.pending.keys()) this.finish(id, 'cancelled');
    }

    private registerRpc(): void {
        this.session.rpcHandlerManager.registerHandler('communication', async (raw: unknown) => {
            const reply = replySchema.parse(raw);
            const entry = this.pending.get(reply.id);
            if (!entry) return; // Another device or Codex already resolved it.
            if (entry.submitting) throw new Error('This answer is already being sent.');
            if (reply.status === 'cancelled') {
                this.finish(reply.id, 'cancelled');
                return;
            }
            const answers = reply.answers ?? {};
            const response: ToolRequestUserInputResponse = { answers: {} };
            for (const question of entry.communication.form.questions) {
                const answer = answers[question.id];
                const values = [...(answer?.options ?? []), ...(answer?.custom?.trim() ? [answer.custom.trim()] : [])];
                if (values.length === 0) throw new Error('Please answer every question.');
                response.answers[question.id] = { answers: values };
            }
            entry.submitting = true;
            try {
                if (entry.nativeRequestId === undefined) {
                    const text = entry.communication.form.questions.map(question => (
                        `${question.question}\n${response.answers[question.id].answers.join('\n')}`
                    )).join('\n\n');
                    await this.sendAnswer(text);
                }
                if (this.pending.get(reply.id) === entry) this.finish(reply.id, 'answered', answers, response);
            } finally {
                entry.submitting = false;
            }
        });
    }

    private add(id: string, entry: Pending): void {
        this.pending.set(id, entry);
        this.publish(id, entry);
        this.session.sendSessionProtocolMessage(createEnvelope('agent', {
            t: 'tool-call-start', call: entry.communication.toolUseId,
            name: 'request_user_input', title: entry.communication.form.questions[0]?.question ?? 'Question',
            description: entry.communication.isBlocking ? 'Waiting for your answer' : 'You can answer while Codex continues working',
            args: { questions: entry.communication.form.questions, isBlocking: entry.communication.isBlocking },
        }, { turn: entry.turnId }));
    }

    private publish(id: string, entry: Pending): void {
        this.session.updateAgentState(state => ({
            ...state, communications: { ...state.communications, [id]: entry.communication },
        }));
    }

    private finish(
        id: string,
        status: 'answered' | 'cancelled',
        answers?: Record<string, AgentQuestionAnswer>,
        response: ToolRequestUserInputResponse = { answers: {} },
    ): void {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        this.session.updateAgentState(state => {
            const { [id]: _, ...communications } = state.communications ?? {};
            return {
                ...state, communications,
                completedCommunications: {
                    ...state.completedCommunications,
                    [id]: { ...entry.communication, completedAt: Date.now(), status, ...(answers ? { answers } : {}) },
                },
            };
        });
        this.session.sendSessionProtocolMessage(createEnvelope('agent', {
            t: 'tool-call-end', call: entry.communication.toolUseId,
        }, { turn: entry.turnId }));
        entry.resolve?.(response);
    }
}
