import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

function usageMessage(id: string, time: number, speed?: unknown, turn?: string) {
    return normalizeRawMessage(id, null, time, {
        role: 'session', content: { type: 'session', data: {
            id, time, role: 'agent', turn, ev: { t: 'service', text: '' },
            usage: { input_tokens: 1200, output_tokens: 50, output_tokens_per_second: speed },
        } },
    } as any)!;
}

function textMessage(id: string, time: number, role: 'agent' | 'user', turn = 'turn-1') {
    return normalizeRawMessage(id, null, time, {
        role: 'session', content: { type: 'session', data: {
            id, time, role, turn, ev: { t: 'text', text: id },
        } },
    } as any)!;
}

function replySpeed(result: ReturnType<typeof reducer>, text: string) {
    const reply = result.messages.find((m) => m.kind === 'agent-text' && m.text === text);
    expect(reply?.kind).toBe('agent-text');
    return reply?.kind === 'agent-text' ? reply.tokensPerSecond : undefined;
}

describe('output speed normalization and storage', () => {
    it('exposes speed from invisible Claude/Codex usage snapshots without rendering blank rows', () => {
        const state = createReducer();
        const message = usageMessage('speed', 1000, 50);
        expect(message).not.toBeNull();
        const result = reducer(state, [message]);
        expect(result.messages).toEqual([]);
        expect(result.usage?.tokensPerSecond).toBe(50);
        expect(state.latestUsage?.tokensPerSecond).toBe(50);
        expect(result.usage?.contextSize).toBe(1200);
    });

    it('accepts a final speed at the same millisecond, ignores old history, and clears stale speed on new usage', () => {
        const state = createReducer();
        reducer(state, [usageMessage('first', 1000)]);
        expect(reducer(state, [usageMessage('final', 1000, 50)]).usage?.tokensPerSecond).toBe(50);
        expect(reducer(state, [usageMessage('old', 900, 100)]).usage?.tokensPerSecond).toBe(50);
        expect(reducer(state, [usageMessage('next', 2000)]).usage?.tokensPerSecond).toBeUndefined();
    });

    it.each([0, -1, NaN, Infinity, '50'])('ignores an invalid speed without dropping context usage: %s', (speed) => {
        const result = reducer(createReducer(), [textMessage('reply', 500, 'agent'), usageMessage('invalid', 1000, speed)]);
        expect(result.usage?.tokensPerSecond).toBeUndefined();
        expect(result.usage?.contextSize).toBe(1200);
        expect(replySpeed(result, 'reply')).toBeUndefined();
    });

    it('keeps a separate speed on each turn’s final reply when a later turn has no speed', () => {
        const state = createReducer();
        const first = reducer(state, [
            textMessage('user-1', 1000, 'user'),
            textMessage('reply-1', 2000, 'agent'),
            usageMessage('speed-1', 3000, 50),
        ]);
        expect(replySpeed(first, 'reply-1')).toBe(50);
        const next = reducer(state, [
            textMessage('user-2', 4000, 'user', 'turn-2'),
            textMessage('reply-2', 5000, 'agent', 'turn-2'),
            usageMessage('speed-2', 6000),
        ]);
        expect(replySpeed(next, 'reply-2')).toBeUndefined();
        expect(next.messages.some((m) => m.kind === 'agent-text' && m.text === 'reply-1')).toBe(false);
        expect(first.messages.find((m) => m.kind === 'agent-text')?.tokensPerSecond).toBe(50);
    });

    it('updates a rendered reply when invisible final usage arrives at the same millisecond', () => {
        const state = createReducer();
        reducer(state, [textMessage('reply', 1000, 'agent'), usageMessage('sample', 2000, 10)]);
        const final = reducer(state, [usageMessage('final', 2000, 25)]);
        expect(final.messages).toHaveLength(1);
        expect(replySpeed(final, 'reply')).toBe(25);
        expect(reducer(state, [usageMessage('final', 2000, 25)]).messages).toEqual([]);
    });

    it('moves a turn’s speed from an intermediate message to its final reply', () => {
        const state = createReducer();
        reducer(state, [textMessage('progress', 1000, 'agent'), usageMessage('sample', 2000, 10)]);
        const final = reducer(state, [textMessage('final', 3000, 'agent'), usageMessage('completed', 4000, 25)]);
        expect(replySpeed(final, 'progress')).toBeUndefined();
        expect(replySpeed(final, 'final')).toBe(25);
    });

    it('reconstructs historical speeds when usage snapshots load before their text', () => {
        const state = createReducer();
        expect(reducer(state, [usageMessage('new-speed', 6000, 80), usageMessage('old-speed', 3000, 25)]).messages).toEqual([]);
        const history = reducer(state, [
            textMessage('new-reply', 5000, 'agent', 'turn-2'),
            textMessage('new-user', 4000, 'user', 'turn-2'),
            textMessage('old-reply', 2000, 'agent'),
            textMessage('old-user', 1000, 'user'),
        ]);
        expect(replySpeed(history, 'new-reply')).toBe(80);
        expect(replySpeed(history, 'old-reply')).toBe(25);
        expect(history.usage?.tokensPerSecond).toBe(80);
    });

    it('uses preceding rows and explicit turn ids when user messages are absent', () => {
        const state = createReducer();
        const result = reducer(state, [
            textMessage('old-reply', 1000, 'agent'), usageMessage('old-speed', 2000, 25),
            textMessage('new-reply', 3000, 'agent', 'turn-2'), usageMessage('new-speed', 4000, 80),
            usageMessage('late-old-speed', 5000, 30, 'turn-1'),
        ]);
        expect(replySpeed(result, 'old-reply')).toBe(30);
        expect(replySpeed(result, 'new-reply')).toBe(80);
    });

    it('ignores pending sends when matching final usage to a reply', () => {
        const state = createReducer();
        const result = reducer(state, [
            textMessage('reply', 1000, 'agent'),
            { ...textMessage('queued', 2000, 'user'), localId: 'queued' },
            usageMessage('final', 3000, 50),
        ], undefined, { holdUserMessagesUntilAccepted: true });
        expect(replySpeed(result, 'reply')).toBe(50);
    });

    it('does not attach a new turn’s usage to the previous answer before any agent row arrives', () => {
        const state = createReducer();
        reducer(state, [textMessage('reply', 1000, 'agent'), usageMessage('old-speed', 2000, 25)]);
        const next = reducer(state, [textMessage('next-user', 3000, 'user', 'turn-2'), usageMessage('new-speed', 4000, 80)]);
        expect(next.messages.filter((m) => m.kind === 'agent-text')).toEqual([]);
    });
});
