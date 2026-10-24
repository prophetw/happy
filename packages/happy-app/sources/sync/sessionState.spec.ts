import { describe, expect, it } from 'vitest';

import { resolveSessionState } from './sessionState';
import type { AgentState } from './storageTypes';

function agentState({
    permission = false,
    communication = false,
    completed = false,
}: {
    permission?: boolean;
    communication?: boolean;
    completed?: boolean;
} = {}): AgentState {
    return {
        requests: permission
            ? { permission: { tool: 'Bash', arguments: {} } }
            : {},
        communications: communication
            ? {
                question: {
                    kind: 'form',
                    form: {
                        questions: [{
                            id: 'choice',
                            header: 'Choice',
                            question: 'Pick one',
                            options: [{ label: 'One' }],
                        }],
                    },
                },
            }
            : {},
        completedCommunications: completed
            ? { question: { kind: 'form', status: 'answered', form: { questions: [] } } }
            : {},
    } as AgentState;
}

describe('resolveSessionState', () => {
    it('keeps a local intervention ahead of thinking and other requests', () => {
        const state = agentState({ permission: true, communication: true });
        state.humanIntervention = { id: 'local-1', kind: 'sudo', instructions: 'Use the local terminal', createdAt: 1 };
        expect(resolveSessionState({ agentState: state, thinking: true, isOnline: true })).toBe('intervention_required');
        expect(resolveSessionState({ agentState: state, thinking: true, isOnline: false })).toBe('disconnected');
    });
    it('keeps working while a non-blocking question is pending and leaves it answerable when idle', () => {
        const state = agentState({ communication: true });
        state.communications!.question.isBlocking = false;
        expect(resolveSessionState({ agentState: state, thinking: true, isOnline: true })).toBe('thinking');
        expect(resolveSessionState({ agentState: state, thinking: false, isOnline: true })).toBe('input_required');
    });
    it('reports a pending agent question as input required ahead of thinking', () => {
        expect(resolveSessionState({
            agentState: agentState({ communication: true }),
            thinking: true,
            isOnline: true,
        })).toBe('input_required');
    });

    it('keeps permission and connection precedence', () => {
        expect(resolveSessionState({
            agentState: agentState({ permission: true, communication: true }),
            thinking: true,
            isOnline: true,
        })).toBe('permission_required');
        expect(resolveSessionState({
            agentState: agentState({ permission: true, communication: true }),
            thinking: true,
            isOnline: false,
        })).toBe('disconnected');
    });

    it.each([true, false])('ignores completed questions with isBlocking=%s', (isBlocking) => {
        const completedQuestion = agentState({ communication: true, completed: true });
        completedQuestion.communications!.question.isBlocking = isBlocking;
        expect(resolveSessionState({
            agentState: completedQuestion,
            thinking: true,
            isOnline: true,
        })).toBe('thinking');
        expect(resolveSessionState({
            agentState: completedQuestion,
            thinking: false,
            isOnline: true,
        })).toBe('waiting');
    });
});
