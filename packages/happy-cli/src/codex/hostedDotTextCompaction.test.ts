import { saveHostedStorage } from './hostedDotStorage';
import { expect, it } from 'vitest';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { addOutput, compactFinalTextOutputs, hash, HostedDotConfig, HostedDotJournal, loadHostedState,  type HostedState } from './hostedDotState';

const empty = (): HostedState => HostedDotJournal.parse({ version: 1, binding: 'test', epoch: 0, threadId: null,
    creating: false, afterSeq: 0, status: 'ready', error: null, inputs: [], outputs: [], controls: [] });
const append = (state: HostedState, envelope: SessionEnvelope, sent = true) => {
    expect(addOutput(state, envelope)).toBe(true); state.outputs.at(-1)!.sent = sent;
};
const text = (turn: string, item: string, value: string, offset: number, snapshot = false) => createEnvelope('agent',
    { t: 'text', text: value, textOffset: offset, ...(snapshot ? { textSnapshot: true } : {}) },
    { id: `thread:${turn}:${item}:${snapshot ? 'snapshot' : offset}`, turn, codexItemId: `thread:${item}` });
const boundary = (turn: string, end = false) => createEnvelope('agent', end ? { t: 'turn-end', status: 'completed' } : { t: 'turn-start' },
    { id: `thread:${turn}:${end ? 'end' : 'start'}`, turn });
function turn(state: HostedState, id: string, items: Array<{ id: string; parts: string[]; snapshot?: string }>, end = true) {
    append(state, boundary(id));
    for (const item of items) {
        let offset = 0;
        for (const part of item.parts) { append(state, text(id, item.id, part, offset)); offset += part.length; }
        append(state, text(id, item.id, item.snapshot ?? item.parts.join(''), 0, true));
    }
    if (end) append(state, boundary(id, true));
}

it('compacts only fully acknowledged, exactly reconstructing items and preserves every other row', () => {
    const state = empty();
    turn(state, 'complete', [{ id: 'a', parts: ['hello', ' ', 'world'] }, { id: 'b', parts: ['🙂', '文'] }]);
    append(state, createEnvelope('agent', { t: 'service', text: 'keep' }, { id: 'service' }));
    turn(state, 'mismatch', [{ id: 'a', parts: ['abc'], snapshot: 'abcd' }]);
    turn(state, 'missing-end', [{ id: 'a', parts: ['xy'] }], false);
    turn(state, 'unacked', [{ id: 'a', parts: ['u'] }]);
    turn(state, 'empty', [{ id: 'a', parts: [''] }]);
    state.inputs.push({ epoch: 0, delivery: 'queue', id: 'input', seq: 1, text: 'keep', status: 'completed', beforeTurns: [] });
    state.controls.push('keep-control');
    state.outputs.find(row => row.localId === 'hosted:0:thread:unacked:a:0')!.sent = false;
    const before = structuredClone(state.outputs), retainedInputs = structuredClone(state.inputs);
    expect(compactFinalTextOutputs(state.outputs)).toBe(5);
    expect(state.outputs.map(row => row.localId)).toEqual([
        'hosted:0:thread:complete:start', 'hosted:0:thread:complete:a:snapshot', 'hosted:0:thread:complete:b:snapshot',
        'hosted:0:thread:complete:end', 'hosted:0:service',
        ...before.slice(10).map(row => row.localId),
    ]);
    for (const id of ['thread:complete:a:snapshot', 'thread:complete:b:snapshot']) {
        const localId = `hosted:0:${id}`;
        expect(state.outputs.find(row => row.localId === localId)).toEqual(before.find(row => row.localId === localId));
    }
    expect(state.outputs.slice(5)).toEqual(before.slice(10));
    expect(state.inputs).toEqual(retainedInputs); expect(state.controls).toEqual(['keep-control']);
    const once = structuredClone(state.outputs);
    expect(compactFinalTextOutputs(state.outputs)).toBe(0); expect(state.outputs).toEqual(once);

    const count = state.outputs.length;
    expect(addOutput(state, text('complete', 'a', 'hello', 0))).toBe(false);
    expect(addOutput(state, text('complete', 'b', '文', 2))).toBe(false);
    expect(state.outputs).toHaveLength(count);
    expect(addOutput(state, text('complete', 'a', '!', 11))).toBe(true);
    expect(addOutput(state, text('complete', 'a', 'H', 0))).toBe(true);
    state.epoch++;
    expect(addOutput(state, text('complete', 'a', 'hello', 0))).toBe(true);
});

it('fails closed for malformed, ambiguous, noncanonical, or isolated streams', () => {
    const state = empty();
    turn(state, 'duplicate', [{ id: 'a', parts: ['a'] }]);
    append(state, createEnvelope('agent', { t: 'text', text: 'a', textOffset: 0, textSnapshot: true },
        { id: 'thread:duplicate:a:other:snapshot', turn: 'duplicate', codexItemId: 'thread:a' }));
    turn(state, 'gap', [{ id: 'a', parts: ['a'] }]);
    append(state, text('gap', 'a', 'b', 2));
    turn(state, 'noncanonical', [{ id: 'a', parts: ['a'] }]);
    const custom = state.outputs.find(row => row.localId === 'hosted:0:thread:noncanonical:a:0')!;
    (custom.envelope as SessionEnvelope).id = 'custom-delta'; custom.localId = 'hosted:0:custom-delta';
    turn(state, 'other-turn', [{ id: 'a', parts: ['same'] }]);
    turn(state, 'other-item', [{ id: 'b', parts: ['same'] }]);
    state.outputs.push({ localId: 'legacy-null', sent: true, envelope: null }, { localId: 'legacy-object', sent: true, envelope: {} });
    const before = structuredClone(state.outputs);
    expect(compactFinalTextOutputs(state.outputs)).toBe(2);
    expect(state.outputs).toEqual(before.filter(row => !['hosted:0:thread:other-turn:a:0', 'hosted:0:thread:other-item:b:0'].includes(row.localId)));
    // Each ordinary item compacts independently; malformed groups remain byte-for-byte intact.
    expect(state.outputs.length).toBe(before.length - 2);
});

it('cold-loads the compacted baseline before native replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-text-compaction-'));
    try {
        const config = HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'isolated', happyHome: '/tmp/happy',
            serverUrl: 'http://127.0.0.1:4567', directory, executable: 'codex', args: [], model: 'test', provider: 'openai',
            instruction: 'chat', codexHome: join(directory, 'codex') });
        const state = empty(); state.binding = hash(config);
        turn(state, 'turn', [{ id: 'item', parts: ['cold', ' ', 'load'] }]);
        const file = join(directory, 'state.json'); saveHostedStorage(file, state);
        const recovered = loadHostedState(file, config);
        expect(recovered.outputs.map(row => row.localId)).toEqual([
            'hosted:0:thread:turn:start', 'hosted:0:thread:turn:item:snapshot', 'hosted:0:thread:turn:end',
        ]);
        expect(addOutput(recovered, text('turn', 'item', 'cold', 0))).toBe(false);
        expect(addOutput(recovered, text('turn', 'item', ' load', 4))).toBe(false);
        expect(recovered.outputs).toHaveLength(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
