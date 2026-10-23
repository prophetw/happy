import { describe, expect, it } from 'vitest';
import { normalizeRawMessage } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';

function usageMessage(id: string, time: number, speed?: unknown) {
    return normalizeRawMessage(id, null, time, {
        role: 'session', content: { type: 'session', data: {
            id, time, role: 'agent', ev: { t: 'service', text: '' },
            usage: { input_tokens: 1200, output_tokens: 50, output_tokens_per_second: speed },
        } },
    } as any)!;
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
        const result = reducer(createReducer(), [usageMessage('invalid', 1000, speed)]);
        expect(result.usage?.tokensPerSecond).toBeUndefined();
        expect(result.usage?.contextSize).toBe(1200);
    });
});
