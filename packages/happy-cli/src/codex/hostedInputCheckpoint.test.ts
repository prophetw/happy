import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { checkpointHostedUserInputs, hostedUnboundRecoveryTurns } from './hostedInputCheckpoint';
import { createHostedStorageWriter, readHostedStorage } from './hostedDotStorage';
import type { HostedState } from './hostedDotState';

function input(seq: number): HostedState['inputs'][number] {
    return { epoch: 0, id: `input-${seq}`, seq, text: 'repeatable message', status: 'completed',
        delivery: 'queue', turnId: `turn-${seq}`, beforeTurns: [] };
}
function state(count: number): HostedState {
    return { version: 1, binding: 'test', epoch: 0, threadId: 'native', creating: false,
        afterSeq: count, status: 'ready', error: null,
        authority: { version: 1, producer: { pid: 1, start: '1', boot: 'ff096cb2-eedc-4bc3-a73d-53efb0c797a0' }, revision: 1 },
        inputs: Array.from({ length: count }, (_, i) => input(i + 1)), outputs: [], outputReceipts: [], controls: [] };
}

it('crosses the old input limit in the original thread across two real SQLite restarts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-input-checkpoint-')), file = join(directory, 'state.json');
    try {
        writeFileSync(join(directory, 'storage.json'), JSON.stringify({ version: 1, kind: 'happy-dot-state', directory, backend: 'sqlite', pending: true }), { mode: 0o600 });
        writeFileSync(file, JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_reader_required' }), { mode: 0o600 });
        let journal = state(8000);
        journal.outputReceipts.push('hosted:0:known-output');
        let writer = createHostedStorageWriter(file, journal);
        writer();
        for (const last of [12000, 16000]) {
            const retired = checkpointHostedUserInputs(journal, 0);
            expect(retired).toHaveLength(4000);
            expect(readHostedStorage(file, ['inputs'], [retired[0]])?.archivedInputs).toEqual([]);
            // Force failure after archive insertion has started. Neither the new
            // archive nor the removal and watermark may survive this transaction.
            expect(() => writer([retired[0], retired[0]])).toThrow();
            expect(readHostedStorage(file)?.inputs).toHaveLength(8000);
            expect(readHostedStorage(file, ['inputs'], [retired[0]])?.archivedInputs).toEqual([]);
            writer(retired);
            const archived = readHostedStorage(file, ['inputs'], [retired[0], { seq: retired[0].seq, id: 'wrong' }])?.archivedInputs;
            expect(archived).toEqual([retired[0]]);
            expect(Object.hasOwn(archived[0], 'text')).toBe(false);
            journal = readHostedStorage(file) as HostedState;
            expect(journal.inputs).toHaveLength(4000);
            expect(journal.retiredUserSeq).toBe(last - 8000);
            expect(journal.afterSeq).toBe(last - 4000);
            expect(journal.threadId).toBe('native');
            expect(journal.outputReceipts).toEqual(['hosted:0:known-output']);
            for (let seq = journal.afterSeq + 1; seq <= last; seq++) journal.inputs.push(input(seq));
            journal.afterSeq = last;
            writer = createHostedStorageWriter(file, journal);
            writer();
        }
        expect(readHostedStorage(file)?.afterSeq).toBe(16000);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps pending outputs, unresolved dispatches, and task-result identities', () => {
    const journal = state(8000);
    journal.outputs.push({ localId: 'pending', envelope: {}, sent: false });
    expect(checkpointHostedUserInputs(journal, 0)).toHaveLength(0);
    journal.outputs[0].sent = true;
    journal.inputs[1].status = 'unknown';
    expect(checkpointHostedUserInputs(journal, 0)).toHaveLength(0);
    journal.inputs[1].status = 'completed';
    journal.inputs[0].origin = 'task-result';
    expect(checkpointHostedUserInputs(journal, 0)).toHaveLength(4000);
    expect(journal.inputs[0]).toEqual(expect.objectContaining({ id: 'input-1', origin: 'task-result' }));
    expect(journal.outputs).toHaveLength(1);
});

it('starts reclaiming byte pressure before the row limit and keeps the native anchor', () => {
    const journal = state(2500);
    for (const row of journal.inputs) row.text = '长'.repeat(7000);
    expect(checkpointHostedUserInputs(journal, 50 * 1024 * 1024).length).toBeGreaterThan(0);
    expect(journal.inputs.at(-1)?.turnId).toBe('turn-2500');
    expect(Buffer.byteLength(JSON.stringify(journal.inputs))).toBeLessThanOrEqual(12 * 1024 * 1024);
});

it('does not reconcile an unbound input against a retired turn with identical text', () => {
    const old = { id: 'retired' }, anchor = { id: 'native-anchor' }, live = { id: 'live' };
    expect(hostedUnboundRecoveryTurns([old, anchor, live], [anchor.id], true)).toEqual([live]);
    expect(hostedUnboundRecoveryTurns([old, live], [anchor.id], true)).toEqual([]);
    expect(hostedUnboundRecoveryTurns([old, live], [old.id, anchor.id], true)).toEqual([]);
    expect(hostedUnboundRecoveryTurns([old, live], [old.id], false)).toEqual([live]);
});
