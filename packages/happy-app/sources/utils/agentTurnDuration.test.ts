import { describe, expect, it } from 'vitest';
import { buildAgentTurnDurationByMessageId, type TurnDurationMessage } from './agentTurnDuration';

describe('buildAgentTurnDurationByMessageId', () => {
    it('calculates duration from user prompt to final agent text in a completed turn', () => {
        const messages: TurnDurationMessage[] = [
            { kind: 'agent-text', id: 'final', text: 'Final answer', createdAt: 10000 },
            { kind: 'tool-call', id: 'tool', createdAt: 7000 },
            { kind: 'agent-text', id: 'progress', text: 'Progress update', createdAt: 6000 },
            { kind: 'user-text', id: 'user', text: 'Do it', createdAt: 5000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: true });
        expect(durations.get('final')).toBe(5000); // 10000 - 5000
    });

    it('does not calculate duration for the current turn while it is still running', () => {
        const messages: TurnDurationMessage[] = [
            { kind: 'agent-text', id: 'streaming', text: 'Still working', createdAt: 6000 },
            { kind: 'user-text', id: 'user', text: 'Do it', createdAt: 5000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: false });
        expect(durations.size).toBe(0);
    });

    it('calculates duration for previous completed turns even when current turn is running', () => {
        const messages: TurnDurationMessage[] = [
            { kind: 'agent-text', id: 'current-streaming', text: 'Streaming...', createdAt: 16000 },
            { kind: 'user-text', id: 'current-user', text: 'Next task', createdAt: 15000 },
            { kind: 'agent-text', id: 'prev-final', text: 'Prev answer', createdAt: 12000 },
            { kind: 'tool-call', id: 'prev-tool', createdAt: 11000 },
            { kind: 'user-text', id: 'prev-user', text: 'First task', createdAt: 10000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: false });
        expect(durations.size).toBe(1);
        expect(durations.get('prev-final')).toBe(2000); // 12000 - 10000
    });

    it('handles turn without preceding user prompt (e.g. system greeting)', () => {
        const messages: TurnDurationMessage[] = [
            { kind: 'agent-text', id: 'welcome', text: 'Hello! How can I help?', createdAt: 1000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: true });
        expect(durations.has('welcome')).toBe(false);
    });
});
