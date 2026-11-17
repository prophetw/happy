import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHostedStorageWriter, readHostedStorage, saveHostedStorage, HOSTED_STORAGE_LIMIT } from './hostedDotStorage';
import { createHostedAuthorityPublisher } from './hostedDotAuthorityPublisher';
import { hostedProducerIdentity } from './hostedDotState';

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
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('appends and acknowledges output without serializing settled historical bodies again', () => {
    const f = fixture();
    f.state.outputs.push(output('current')); f.commit();
    f.state.outputs.at(-1).sent = true; f.state.inputs[0].status = 'completed'; f.state.inputs[0].beforeTurns = []; f.commit();
    expect(f.encodedHistory()).toBe(0);
    const recovered = readHostedStorage(f.file)!;
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
