import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import { normalizeRawMessage } from '../typesRaw';
function chunk(offset: number, text: string, thread = 'thread-a') {
    return normalizeRawMessage(`row-${thread}-${offset}`, null, 1000 + offset, { role: 'session', content: {
        id: `${thread}:item:${offset}`, time: 1000 + offset, role: 'agent', turn: 'turn-1', codexItemId: `${thread}:item`,
        ev: { t: 'text', text, textOffset: offset },
    } } as any)!;
}
describe('hosted Codex text streaming', () => {
    it('restores a long item from its final snapshot without older delta pages', () => {
        const state = createReducer(), final = chunk(0, 'z'.repeat(5000)); final.id = 'final-snapshot'; final.textStreamSnapshot = true;
        reducer(state, [final]); reducer(state, [chunk(9, 'stale chunk')]);
        const messages = [...state.messages.values()].filter(m => m.role === 'agent');
        expect(messages).toHaveLength(1); expect(messages[0].text).toBe('z'.repeat(5000));
    });
    it('grows one message, including out-of-order history and replay', () => {
        const state = createReducer();
        expect(chunk(0, 'hello').textStreamOffset).toBe(0);
        reducer(state, [chunk(5, ' world')]); reducer(state, [chunk(0, 'hello')]);
        const result = reducer(state, [chunk(5, ' world')]);
        const messages = [...state.messages.values()].filter(m => m.role === 'agent' && m.text !== null);
        expect(messages).toHaveLength(1); expect(messages[0].text).toBe('hello world'); expect(result.messages).toHaveLength(0);
        reducer(state, [chunk(0, 'different thread', 'thread-b')]);
        expect([...state.messages.values()].filter(m => m.role === 'agent')).toHaveLength(2);
    });
});
