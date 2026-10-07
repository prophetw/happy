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
        expect(durations.get('final')).toEqual({ durationMs: 5000, completedAt: 10000 }); // 10000 - 5000
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
        expect(durations.get('prev-final')).toEqual({ durationMs: 2000, completedAt: 12000 }); // 12000 - 10000
    });

    it('handles turn without preceding user prompt (e.g. system greeting)', () => {
        const messages: TurnDurationMessage[] = [
            { kind: 'agent-text', id: 'welcome', text: 'Hello! How can I help?', createdAt: 1000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: true });
        expect(durations.has('welcome')).toBe(false);
    });

    it('counts tool work that lands after the final visible text into the turn duration', () => {
        // The turn's last visible text is not the turn's end: tool calls can
        // continue after it. Stopping at the text measured "prompt → last text"
        // and read like the gap between two adjacent messages.
        const messages: TurnDurationMessage[] = [
            { kind: 'tool-call', id: 'tool-end', createdAt: 20000 },
            { kind: 'agent-text', id: 'final', text: 'Sure, done', createdAt: 11000 },
            { kind: 'user-text', id: 'user', text: 'Do it', createdAt: 10000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: true });
        expect(durations.get('final')).toEqual({ durationMs: 10000, completedAt: 20000 });
    });

    it('excludes a pending user message from both the turn start and end', () => {
        // A pending send has not started a turn yet; it must neither move the
        // clock forward (its createdAt is "now") nor mark the turn's end.
        const messages: TurnDurationMessage[] = [
            { kind: 'user-text', id: 'pending-user', text: 'Next...', createdAt: 50000, pending: true },
            { kind: 'agent-text', id: 'final', text: 'Done', createdAt: 16000 },
            { kind: 'user-text', id: 'user', text: 'Do it', createdAt: 8000 },
        ];

        const durations = buildAgentTurnDurationByMessageId(messages, { currentTurnComplete: true });
        expect(durations.get('final')).toEqual({ durationMs: 8000, completedAt: 16000 });
    });
});
