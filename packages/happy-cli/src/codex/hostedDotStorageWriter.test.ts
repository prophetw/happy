import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostedStorageWriter, readHostedStorage, saveHostedStorage, HOSTED_STORAGE_LIMIT } from './hostedDotStorage';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { hostedProducerIdentity, addOutput, compactFinalTextOutputs, reclaimDeliveredOutputPrefix } from './hostedDotState';
import { createEnvelope } from '@slopus/happy-wire';
import { HostedOutputDelivery } from './hostedOutputDelivery';

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
function fixture(history = 600) {
    const directory = mkdtempSync(join(tmpdir(), 'happy-incremental-output-')); roots.push(directory);
    const file = join(directory, 'state.json');
    writeFileSync(join(directory, 'storage.json'), JSON.stringify({ version: 1, kind: 'happy-dot-state', directory, backend: 'sqlite', pending: true }), { mode: 0o600 });
    writeFileSync(file, JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_reader_required' }), { mode: 0o600 });
    let historicalEncodings = 0;
    const state: any = { version: 1, epoch: 0, status: 'ready', error: null, inputs: [{ id: 'input', status: 'accepted', beforeTurns: ['old'] }],
        outputs: Array.from({ length: history }, (_, n) => {
            const envelope = { id: `history-${n}`, ev: { t: 'text', text: '历史🙂'.repeat(4) } };
            Object.defineProperty(envelope, 'toJSON', { value() { historicalEncodings++; return { id: this.id, ev: this.ev }; } });
            return { localId: `hosted:0:history-${n}`, sent: true, envelope };
        }), controls: [] };
    saveHostedStorage(file, state);
    const commit = createHostedStorageWriter(file, state); commit(); historicalEncodings = 0;
    return { directory, file, state, commit, encodedHistory: () => historicalEncodings };
}
const output = (id: string, text = '文🙂') => ({ localId: `hosted:0:${id}`, sent: false, envelope: { id, ev: { t: 'text', text, textOffset: 0 } } });
const stream = (turn: string, item: string, text: string, offset: number, snapshot = false) => {
    const envelope = createEnvelope('agent', { t: 'text', text, textOffset: offset, ...(snapshot ? { textSnapshot: true } : {}) },
        { id: `thread:${turn}:${item}:${snapshot ? 'snapshot' : offset}`, turn, codexItemId: `thread:${item}` });
    return { localId: `hosted:0:${envelope.id}`, sent: true, envelope };
};
const turnBoundary = (turn: string, end = false) => {
    const envelope = createEnvelope('agent', end ? { t: 'turn-end', status: 'completed' } : { t: 'turn-start' },
        { id: `thread:${turn}:${end ? 'end' : 'start'}`, turn });
    return { localId: `hosted:0:${envelope.id}`, sent: true, envelope };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('appends and acknowledges output without serializing settled historical bodies again', () => {
    const f = fixture();
    f.state.outputs.push(output('current')); f.commit();
    f.state.outputs.at(-1).sent = true; f.state.inputs[0].status = 'completed'; f.state.inputs[0].beforeTurns = []; f.commit();
    expect(f.encodedHistory()).toBe(0);
    const recovered: any = readHostedStorage(f.file)!;
    expect(recovered).toEqual(f.state);
    expect(recovered.outputs.at(-1).sent).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(recovered))).toBe(f.commit().logicalBytes);
});

it('preserves old readers, UTF-8 byte counts and digest trees across checkpoint boundaries and partial ACKs', () => {
    const f = fixture(515);
    for (let n = 0; n < 5; n++) f.state.outputs.push(output(`new-${n}`, '界🙂'.repeat(n + 1)));
    f.commit();
    f.state.outputs[0].sent = false; f.state.outputs[256].sent = false;
    f.state.outputs[516].sent = true; f.state.outputs[519].sent = true;
    f.state.controls.push('stop-receipt'); f.state.inputs.push({ id: 'second', status: 'unknown' });
    const result = f.commit();
    expect(readHostedStorage(f.file)).toEqual(f.state);
    expect(result.logicalBytes).toBe(Buffer.byteLength(JSON.stringify(f.state)));
    const fresh = readHostedStorage(f.file)!;
    const resume = createHostedStorageWriter(f.file, fresh); fresh.outputs[517].sent = true; resume();
    expect(readHostedStorage(f.file)).toEqual(fresh);
    expect(fresh.outputs.filter((row: any) => !row.sent).map((row: any) => row.localId)).toEqual([
        'hosted:0:history-0', 'hosted:0:history-256', 'hosted:0:new-0', 'hosted:0:new-3',
    ]);
});

it('persists exact output receipts outside active logical bytes and deduplicates them after restart', () => {
    const f = fixture(3), reclaimed = f.state.outputs.slice(0, 2), tail = JSON.stringify(f.state.outputs[2]);
    f.state.outputs[2].sent = false;
    f.state.outputReceipts = reclaimed.map((row: any) => row.localId);
    f.state.outputs.splice(0, reclaimed.length);
    const result = f.commit();
    expect(result.logicalBytes).toBe(Buffer.byteLength(JSON.stringify({ ...f.state, outputReceipts: [] })));

    const recovered: any = readHostedStorage(f.file)!;
    expect(recovered).toEqual(f.state);
    expect(JSON.stringify(recovered.outputs[0])).toBe(tail.replace('"sent":true', '"sent":false'));
    expect(addOutput(recovered, reclaimed[0].envelope)).toBe(false);
    expect(addOutput(recovered, reclaimed[1].envelope)).toBe(false);
    recovered.outputs[0].sent = true;
    const resume = createHostedStorageWriter(f.file, recovered); resume();
    expect(readHostedStorage(f.file)).toEqual(recovered);
    saveHostedStorage(f.file, recovered);
    expect(readHostedStorage(f.file)).toEqual(recovered);
});

it('rejects overlap between active outputs and durable receipts without replacing the valid journal', () => {
    const f = fixture(2), reclaimed = f.state.outputs[0];
    f.state.outputReceipts = [reclaimed.localId]; f.state.outputs.shift(); f.commit();
    const before = readHostedStorage(f.file);
    f.state.outputs.push(reclaimed);
    expect(f.commit).toThrow('hosted_storage_receipts_invalid');
    expect(readHostedStorage(f.file)).toEqual(before);
});

it('rolls back a receipt append and its active-row removal in the same transaction', () => {
    const f = fixture(3);
    f.state.outputReceipts = [f.state.outputs[0].localId]; f.state.outputs.shift(); f.commit();
    const before = readHostedStorage(f.file), next = f.state.outputs[0];
    const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
    db.exec('CREATE TRIGGER reject_receipt BEFORE INSERT ON output_receipts WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT, \'synthetic receipt failure\'); END');
    f.state.outputReceipts.push(next.localId); f.state.outputs.shift();
    expect(f.commit).toThrow('synthetic receipt failure');
    expect(readHostedStorage(f.file)).toEqual(before);
    db.exec('DROP TRIGGER reject_receipt'); db.close();
    f.commit(); expect(readHostedStorage(f.file)).toEqual(f.state);
});

it('reclaims only the acknowledged prefix and keeps the unsent tail byte-for-byte unchanged', () => {
    const f = fixture(3); f.state.outputs[2].sent = false;
    const tail = JSON.stringify(f.state.outputs[2]);
    expect(reclaimDeliveredOutputPrefix(f.state)).toBe(2);
    expect(f.state.outputReceipts).toEqual(['hosted:0:history-0', 'hosted:0:history-1']);
    expect(JSON.stringify(f.state.outputs[0])).toBe(tail);
    f.commit();
    expect(readHostedStorage(f.file)).toEqual(f.state);
});

it('reclaims through the real writer proxy without detaching pending rows or resending verified output', async () => {
    const f = fixture(0), deltas = [0, 1, 2, 3].map(n => stream('turn', 'item', 'x', n));
    f.state.outputs = deltas;
    for (const row of f.state.outputs) row.sent = false;
    f.commit();
    const send = vi.fn().mockImplementationOnce(async (batch: any[]) => batch.slice(0, 2).map(row => row.localId))
        .mockImplementation(async (batch: any[]) => batch.map(row => row.localId));
    const delivery = new HostedOutputDelivery(f.state.outputs, send, async () => { f.commit(); });
    try {
        delivery.durable(); await expect(delivery.flush()).rejects.toThrow('hosted_output_unconfirmed');
        expect(readHostedStorage(f.file)!.outputs.map((row: any) => row.sent)).toEqual([true, true, false, false]);
        expect(delivery.reclaimAcknowledgedPrefix(() => reclaimDeliveredOutputPrefix(f.state))).toBe(2);
        f.commit();
        f.state.outputs.push(output('after-reclaim')); f.commit(); delivery.durable(); await delivery.flush();
        expect(send.mock.calls.slice(1).flatMap(call => call[0]).map((row: any) => row.localId)).toEqual([
            deltas[2].localId, deltas[3].localId, 'hosted:0:after-reclaim',
        ]);
    } finally { await delivery.close(); }
    const recovered = readHostedStorage(f.file)!;
    expect(recovered.outputReceipts).toEqual([deltas[0].localId, deltas[1].localId]);
    expect(recovered.outputs.every((row: any) => row.sent)).toBe(true);
    const restartSend = vi.fn(async (batch: any[]) => batch.map(row => row.localId));
    const restarted = new HostedOutputDelivery(recovered.outputs, restartSend, () => {});
    restarted.durable(); await restarted.flush(); expect(restartSend).not.toHaveBeenCalled(); await restarted.close();
}, 15000);

it('restarts a 50,000-row journal with 49,783 receipts and the original 217-row unsent tail', () => {
    const f = fixture(50000);
    for (let n = 49783; n < 50000; n++) f.state.outputs[n].sent = false;
    const reclaimed = f.state.outputs.slice(0, 49783), tail = f.state.outputs.slice(49783).map((row: any) => JSON.stringify(row));
    const input = JSON.stringify(f.state.inputs);
    f.state.threadId = 'original-thread'; f.state.afterSeq = 23;
    f.state.outputReceipts = reclaimed.map((row: any) => row.localId);
    f.state.outputs.splice(0, reclaimed.length);
    const result = f.commit();
    expect(result.logicalBytes).toBeLessThan(32 * 1024 * 1024);

    const recovered: any = readHostedStorage(f.file)!;
    expect(recovered.outputReceipts).toHaveLength(49783);
    expect(recovered.outputs.map((row: any) => JSON.stringify(row))).toEqual(tail);
    expect(JSON.stringify(recovered.inputs)).toBe(input);
    expect(recovered.threadId).toBe('original-thread'); expect(recovered.afterSeq).toBe(23);
    expect(addOutput(recovered, reclaimed[0].envelope)).toBe(false);
    expect(addOutput(recovered, reclaimed.at(-1)!.envelope)).toBe(false);

    recovered.outputs[0].sent = true;
    const resume = createHostedStorageWriter(f.file, recovered); resume();
    saveHostedStorage(f.file, recovered);
    const reloaded = readHostedStorage(f.file)!;
    expect(reloaded).toEqual(recovered);
    expect(reloaded.outputs).toHaveLength(217); expect(reloaded.outputs[0].sent).toBe(true);
    expect(reloaded.outputs.slice(1).every((row: any) => !row.sent)).toBe(true);
}, 60000);

it('preserves every output and ACK across the legacy row and byte limits after restart', () => {
    const f = fixture(50000), legacyLimit = 32 * 1024 * 1024;
    for (let n = 49783; n < 50000; n++) f.state.outputs[n].sent = false;
    const originalFirst = JSON.stringify(f.state.outputs[0]), originalTail = JSON.stringify(f.state.outputs[49999]);
    const originalUnsent = f.state.outputs.slice(49783).map((row: any) => row.localId);
    const initialBytes = Buffer.byteLength(JSON.stringify(f.state));
    expect(initialBytes).toBeLessThan(legacyLimit);
    f.state.outputs.push(output('after-legacy-cap', 'x'.repeat(legacyLimit - initialBytes + 2048)));
    expect(f.commit().logicalBytes).toBeGreaterThan(legacyLimit);

    const recovered: any = readHostedStorage(f.file)!;
    expect(recovered.outputs).toHaveLength(50001);
    expect(JSON.stringify(recovered.outputs[0])).toBe(originalFirst);
    expect(JSON.stringify(recovered.outputs[49999])).toBe(originalTail);
    expect(recovered.outputs.slice(49783, 50000).map((row: any) => row.localId)).toEqual(originalUnsent);
    expect(recovered.outputs.slice(49783).every((row: any) => !row.sent)).toBe(true);

    const resume = createHostedStorageWriter(f.file, recovered);
    recovered.outputs[49783].sent = true; recovered.outputs[50000].sent = true; resume();
    const reloaded = readHostedStorage(f.file)!;
    expect(reloaded.outputs[49783].sent).toBe(true); expect(reloaded.outputs[50000].sent).toBe(true);
    expect(reloaded.outputs.slice(49784, 50000).every((row: any) => !row.sent)).toBe(true);
    saveHostedStorage(f.file, reloaded);
    expect(readHostedStorage(f.file)!.outputs).toHaveLength(50001);
}, 60000);

it('uses the incremental writer at the actual authority publication seam', () => {
    const f = fixture();
    const publish = createHostedAuthorityPublisher(f.file, f.state, hostedProducerIdentity()); publish();
    const before = f.encodedHistory(), revision = f.state.authority.revision;
    f.state.outputs.push(output('published')); publish(); f.state.outputs.at(-1).sent = true; publish();
    expect(f.encodedHistory()).toBe(before);
    expect(readHostedStorage(f.file)).toEqual(f.state);
    expect(f.state.authority.revision).toBe(revision + 2);
});

it('rolls back all record/header/ACK changes on a failed transaction and retries the same IDs', () => {
    const f = fixture(2), before = readHostedStorage(f.file);
    const db = new DatabaseSync(join(f.directory, 'state.sqlite'));
    db.exec("CREATE TRIGGER reject_output BEFORE INSERT ON records WHEN NEW.kind='outputs' AND NEW.position=2 BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    f.state.outputs.push(output('retry')); f.state.outputs[0].sent = false; f.state.status = 'running';
    expect(f.commit).toThrow('synthetic disk failure'); expect(readHostedStorage(f.file)).toEqual(before);
    db.exec('DROP TRIGGER reject_output'); db.close();
    f.commit(); expect(readHostedStorage(f.file)).toEqual(f.state);
    expect(readHostedStorage(f.file)!.outputs.map((row: any) => row.localId)).toEqual(['hosted:0:history-0', 'hosted:0:history-1', 'hosted:0:retry']);
});

it('rejects a different writer generation instead of overwriting its committed receipts', () => {
    const f = fixture(2), other = readHostedStorage(f.file)!;
    other.controls.push('external-receipt'); saveHostedStorage(f.file, other);
    f.state.outputs.push(output('stale'));
    expect(f.commit).toThrow('hosted_storage_revision_changed');
    expect(readHostedStorage(f.file)).toEqual(other);
});

it('retains the last committed journal after an oversized append and can retry after removing it', () => {
    const f = fixture(2), before = readHostedStorage(f.file);
    f.state.outputs.push(output('oversized', '界'.repeat(Math.ceil(HOSTED_STORAGE_LIMIT / 3))));
    expect(f.commit).toThrow('hosted_authority_state_too_large'); expect(readHostedStorage(f.file)).toEqual(before);
    f.state.outputs.pop(); f.state.outputs.push(output('valid')); f.commit();
    expect(readHostedStorage(f.file)).toEqual(f.state);
});

it('tracks output replacement/truncation while immutable envelopes prevent untracked body edits', () => {
    const f = fixture(4);
    expect(() => { f.state.outputs[0].envelope.ev.text = 'mutated'; }).toThrow();
    f.state.outputs[2] = output('replacement'); f.state.outputs.length = 3; f.commit();
    expect(readHostedStorage(f.file)).toEqual(f.state);
    f.state.outputs = [output('reset')]; f.commit();
    expect(readHostedStorage(f.file)).toEqual(f.state);
});

it('keeps JSON compatibility and refuses projection writeback in the incremental entry point', () => {
    const f = fixture(2), projection = readHostedStorage(f.file, ['inputs', 'controls'])!;
    expect(() => createHostedStorageWriter(f.file, { ...projection })()).toThrow('hosted_storage_projection_read_only');
    const directory = join(f.directory, 'json'); mkdirSync(directory);
    const state = { version: 1, outputs: [output('json')] }, file = join(directory, 'state.json');
    const commit = createHostedStorageWriter(file, state); commit(); state.outputs[0].sent = true; commit();
    expect(readHostedStorage(file)).toEqual(state);
});

it('compacts through the output proxy and preserves shifted ACK positions after writer restart', () => {
    const f = fixture(0), open = output('open');
    f.state.outputs = [turnBoundary('turn'), stream('turn', 'item', 'a', 0), stream('turn', 'item', 'b', 1),
        stream('turn', 'item', 'ab', 0, true), turnBoundary('turn', true), open];
    f.commit();
    const snapshot = JSON.stringify(f.state.outputs[3]);
    expect(compactFinalTextOutputs(f.state.outputs)).toBe(2); f.commit();
    expect(f.state.outputs.map((row: any) => row.localId)).toEqual([
        'hosted:0:thread:turn:start', 'hosted:0:thread:turn:item:snapshot', 'hosted:0:thread:turn:end', 'hosted:0:open',
    ]);
    expect(JSON.stringify(f.state.outputs[1])).toBe(snapshot);
    f.state.outputs[3].sent = true; f.commit();
    let recovered = readHostedStorage(f.file)!;
    expect(recovered.outputs[3].sent).toBe(true); expect(recovered.outputs[1].envelope.ev.text).toBe('ab');
    expect(compactFinalTextOutputs(recovered.outputs)).toBe(0);
    const resume = createHostedStorageWriter(f.file, recovered); resume();
    recovered = readHostedStorage(f.file)!;
    expect(recovered.outputs).toHaveLength(4); expect(recovered.outputs[3].sent).toBe(true);
});

it('retains text-delta receipts after their final snapshot and turn boundaries are reclaimed', () => {
    const f = fixture(0), delta = stream('turn', 'item', 'a', 0);
    f.state.outputs = [turnBoundary('turn'), delta, stream('turn', 'item', 'b', 1),
        stream('turn', 'item', 'ab', 0, true), turnBoundary('turn', true), output('open')];
    f.commit();
    expect(compactFinalTextOutputs(f.state.outputs, f.state)).toBe(2);
    expect(reclaimDeliveredOutputPrefix(f.state)).toBe(3);
    f.commit();
    const recovered: any = readHostedStorage(f.file)!;
    expect(recovered.outputs.map((row: any) => row.localId)).toEqual(['hosted:0:open']);
    expect(recovered.outputReceipts).toHaveLength(5);
    expect(addOutput(recovered, delta.envelope)).toBe(false);
    expect(addOutput(recovered, createEnvelope('agent', { t: 'service', text: 'after' }, { id: 'after' }))).toBe(true);
});

it('compacts a 50,000-row SQLite journal before append and preserves replay dedup and the open item', () => {
    const f = fixture(0), deltas = Array.from({ length: 49996 }, (_, n) => stream('turn', 'item', 'x', n));
    f.state.outputs = [turnBoundary('turn'), ...deltas, stream('turn', 'item', 'x'.repeat(49996), 0, true),
        turnBoundary('turn', true), output('open')];
    expect(f.state.outputs).toHaveLength(50000); f.commit();
    const recovered: any = readHostedStorage(f.file)!, open = JSON.stringify(recovered.outputs.at(-1));
    expect(compactFinalTextOutputs(recovered.outputs)).toBe(49996);
    const writer = createHostedStorageWriter(f.file, recovered); writer();
    expect(recovered.outputs).toHaveLength(4); expect(JSON.stringify(recovered.outputs.at(-1))).toBe(open);
    expect(addOutput(recovered, deltas[0].envelope)).toBe(false);
    expect(addOutput(recovered, deltas.at(-1)!.envelope)).toBe(false);
    expect(addOutput(recovered, createEnvelope('agent', { t: 'service', text: 'after' }, { id: 'after' }))).toBe(true);
    writer(); recovered.outputs.at(-1).sent = true; writer();
    const reloaded = readHostedStorage(f.file)!;
    expect(reloaded.outputs).toHaveLength(5); expect(reloaded.outputs.at(-1).sent).toBe(true);
    expect(reloaded.outputs.filter((row: any) => row.localId.endsWith(':snapshot'))).toHaveLength(1);
    expect(reloaded.outputs[1].envelope.ev.text).toBe('x'.repeat(49996));
}, 60000);
