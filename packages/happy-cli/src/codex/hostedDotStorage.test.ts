import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { hostedStorageBackend, readHostedStorage, saveHostedStorage } from './hostedDotStorage';
import { HostedDotConfig, HostedDotJournal, hash, loadHostedState, hostedProducerIdentity } from './hostedDotState';
import { changeHostedDotStorage, statusHostedDot, readHostedDotEpoch, readHostedDotJournal, prepareHostedDotClear, clearHostedDot, stopHostedDot } from './hostedDotLifecycle';
import { readHostedInputAuthority } from './hostedDotAuthority';
const require = createRequire(import.meta.url);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'hosted-sqlite-')); dirs.push(directory);
    const config = HostedDotConfig.parse({ version: 1, dotId: randomUUID(), sessionId: 'session', directory,
        happyHome: '/tmp/happy', serverUrl: 'http://localhost:1234', executable: 'codex', args: [], model: 'test',
        provider: 'openai', instruction: 'test', codexHome: join(directory, 'native') });
    const file = join(directory, 'state.json');
    const state = HostedDotJournal.parse({ version: 1, binding: hash(config), epoch: 2, threadId: 'original-thread', creating: false,
        afterSeq: 7, status: 'ready', error: null, authority: { version: 1, producer: { pid: 2147483647, start: '1', boot: randomUUID() }, revision: 94 },
        inputs: [{ epoch: 2, seq: 7, id: 'user', text: 'original request', status: 'completed', turnId: 'original-turn' }],
        outputs: [{ localId: 'original-output', envelope: { id: 'message', text: 'original reply' }, sent: false }], controls: ['old-control'] });
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config)); writeFileSync(file, JSON.stringify(state));
    const binding = { directory, dotId: config.dotId, sessionId: config.sessionId };
    return { directory, config, binding, file, state, read: () => readHostedStorage(file)!, migrate: () => changeHostedDotStorage(binding, 'sqlite') };
}
function dbFor(directory: string) { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(join(directory, 'state.sqlite')); }
it('cold migration preserves every value and source byte, and is idempotent', () => {
    const f = fixture(), original = readFileSync(f.file);
    expect(f.migrate()).toMatchObject({ backend: 'sqlite', alreadyMigrated: false });
    expect(f.read()).toEqual(f.state); expect(loadHostedState(f.file, f.config)).toEqual(f.state);
    expect(readFileSync(join(f.directory, 'state.json.pre-sqlite'))).toEqual(original);
    expect(hostedStorageBackend(f.directory)).toBe('sqlite');
    expect(JSON.parse(readFileSync(f.file, 'utf8'))).toMatchObject({ version: 0, storage: 'sqlite' });
    expect(() => HostedDotJournal.parse(JSON.parse(readFileSync(f.file, 'utf8')))).toThrow();
    expect(f.migrate()).toMatchObject({ alreadyMigrated: true });
});
it('updates one output acknowledgement without rewriting other SQL records and preserves restart state', () => {
    const f = fixture(); f.migrate(); const state = f.read(); state.outputs[0].sent = true;
    expect(saveHostedStorage(f.file, state)).toMatchObject({ changedRecords: 1, deletedRecords: 0 });
    expect(f.read().outputs[0].sent).toBe(true); expect(f.read().inputs).toEqual(f.state.inputs);
    state.outputs.push({ localId: 'next', envelope: { id: 'next' }, sent: false }); state.controls.push('next-control');
    expect(saveHostedStorage(f.file, state)).toMatchObject({ changedRecords: 2 });
    expect(loadHostedState(f.file, f.config)).toEqual(state);
});
it('new and existing JSON roots keep their backend until explicit cold migration', () => {
    const f = fixture(); saveHostedStorage(f.file, f.state); expect(hostedStorageBackend(f.directory)).toBe('json');
    rmSync(f.file); saveHostedStorage(f.file, f.state); expect(hostedStorageBackend(f.directory)).toBe('json'); f.migrate();
    expect(f.read()).toEqual(f.state);
});
it('SQL write failure rolls back all records and the header together', () => {
    const f = fixture(); f.migrate(); const db = dbFor(f.directory);
    db.exec("CREATE TRIGGER fail_output BEFORE UPDATE ON records WHEN NEW.kind='outputs' BEGIN SELECT RAISE(ABORT,'fixture_disk_failure'); END"); db.close();
    const state = f.read(); state.inputs[0].status = 'failed'; state.outputs[0].sent = true; state.status = 'blocked';
    expect(() => saveHostedStorage(f.file, state)).toThrow('fixture_disk_failure'); expect(f.read()).toEqual(f.state);
});
it.each(['delete', 'body'])('detects %s corruption instead of silently losing output history', kind => {
    const f = fixture(); f.migrate(); const db = dbFor(f.directory);
    db.exec(kind === 'delete' ? "DELETE FROM records WHERE kind='outputs'" : "UPDATE records SET value='{}' WHERE kind='outputs'"); db.close();
    expect(f.read).toThrow('hosted_storage_records_invalid');
    // Input authorization does not read or depend on unrelated output payloads.
    expect(readHostedStorage(f.file, ['inputs'])?.inputs).toEqual(f.state.inputs);
});
it('formal status, epoch and authority read the SQLite source without requiring a live owner', () => {
    const f = fixture(); f.migrate();
    expect(statusHostedDot(f.binding)).toMatchObject({ running: false, epoch: 2, threadId: 'original-thread' });
    expect(readHostedDotEpoch(f.binding).epoch).toBe(2); expect(readHostedDotJournal(f.binding).inputs).toEqual(f.state.inputs);
    expect(readHostedInputAuthority(f.config)).toMatchObject({ epoch: 2, revision: 94, inputs: [{ id: 'user', origin: 'user' }] });
    expect(() => readHostedInputAuthority({ ...f.config, sessionId: 'wrong' })).toThrow();
});
it('rejects live owners, uncertain inputs and pending clear before creating migration files', () => {
    const f = fixture(); writeFileSync(join(f.directory, 'owner.json'), JSON.stringify(hostedProducerIdentity()));
    expect(f.migrate).toThrow('dot_runtime_stop_hosted_first'); rmSync(join(f.directory, 'owner.json'));
    f.state.inputs[0].status = 'unknown'; writeFileSync(f.file, JSON.stringify(f.state));
    expect(f.migrate).toThrow('hosted_storage_input_unconfirmed');
    expect(existsSync(join(f.directory, 'state.json.pre-sqlite'))).toBe(false);
    writeFileSync(join(f.directory, 'lifecycle-clear.json'), '{}'); expect(f.migrate).toThrow('hosted_lifecycle_clear_pending');
});
it('rejects linked database/marker paths and detects an old writer replacing the refusal marker', () => {
    const f = fixture(); f.migrate(); writeFileSync(f.file, JSON.stringify(f.state));
    expect(f.read).toThrow('hosted_storage_legacy_writer');
    writeFileSync(f.file, JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_reader_required' }));
    const db = join(f.directory, 'state.sqlite'); renameSync(db, db + '.real'); symlinkSync(db + '.real', db);
    expect(f.read).toThrow('hosted_storage_symlink');
});
it('fails closed after an interrupted publication and explicitly resumes the validated migration', () => {
    const f = fixture(); f.migrate(); rmSync(join(f.directory, 'storage.json'));
    expect(f.read).toThrow('hosted_storage_migration_incomplete');
    expect(f.migrate()).toMatchObject({ backend: 'sqlite' }); expect(f.read()).toEqual(f.state);
});
it('rolls back the latest committed state, preserving the database and original backup', () => {
    const f = fixture(); f.migrate(); const state = f.read(); state.outputs[0].sent = true; saveHostedStorage(f.file, state);
    expect(changeHostedDotStorage(f.binding, 'json')).toMatchObject({ backend: 'json' });
    expect(f.read()).toEqual(state); expect(hostedStorageBackend(f.directory)).toBe('json');
    expect(existsSync(join(f.directory, 'state.sqlite.pre-json'))).toBe(true);
    expect(readFileSync(join(f.directory, 'state.json.pre-sqlite'), 'utf8')).toBe(JSON.stringify(f.state));
    expect(f.migrate).toThrow('hosted_storage_archive_previous_migration_first');
});
it('preserves SQLite selection across explicit clear and initializes the next epoch without old inputs', async () => {
    const f = fixture(); f.migrate();
    const clear = { ...f.binding, requestId: 'clear', epoch: 3, codexHome: f.config.codexHome };
    await prepareHostedDotClear(clear); clearHostedDot(clear); clearHostedDot(clear);
    expect(hostedStorageBackend(f.directory)).toBe('sqlite'); expect(f.read()).toBeNull();
    expect(existsSync(join(f.directory, 'state.json.pre-sqlite'))).toBe(false);
    const next = { ...f.config, sessionId: 'next-session' }; writeFileSync(join(f.directory, 'config.json'), JSON.stringify(next));
    const state = loadHostedState(f.file, next); expect(state.epoch).toBe(3); expect(state.inputs).toEqual([]);
    saveHostedStorage(f.file, state); expect(f.read()).toEqual(state); expect(hostedStorageBackend(f.directory)).toBe('sqlite');
});
it('rejects malformed JSON roots and oversized writes without replacing the last committed state', () => {
    const f = fixture(); writeFileSync(f.file, 'null'); expect(() => loadHostedState(f.file, f.config)).toThrow();
    writeFileSync(f.file, JSON.stringify(f.state)); f.migrate();
    const state = f.read(); state.outputs[0].envelope.text = 'x'.repeat(32 * 1024 * 1024);
    expect(() => saveHostedStorage(f.file, state)).toThrow('hosted_authority_state_too_large'); expect(f.read()).toEqual(f.state);
});
it('a killed SQL writer leaves recovery explicit and preserves the last complete commit', () => {
    const f = fixture(); f.migrate();
    const child = spawnSync(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA cache_size=1;BEGIN IMMEDIATE;UPDATE records SET value=hex(randomblob(100000)) WHERE kind='outputs'");process.stdout.write('UNCOMMITTED');process.kill(process.pid,'SIGKILL');`, join(f.directory, 'state.sqlite')], { encoding: 'utf8', timeout: 10000 });
    expect(child.error).toBeUndefined(); expect(child.signal).toBe('SIGKILL'); expect(child.stdout).toBe('UNCOMMITTED');
    expect(existsSync(join(f.directory, 'state.sqlite-journal'))).toBe(true); expect(f.read).toThrow();
    expect(changeHostedDotStorage(f.binding, 'recover')).toMatchObject({ recovered: true }); expect(f.read()).toEqual(f.state);
});
it('explicit rollback resumes after publishing JSON and renaming the database', () => {
    const f = fixture(); f.migrate(); writeFileSync(f.file, JSON.stringify(f.state));
    renameSync(join(f.directory, 'state.sqlite'), join(f.directory, 'state.sqlite.pre-json'));
    expect(f.read).toThrow(); expect(changeHostedDotStorage(f.binding, 'json')).toMatchObject({ backend: 'json' }); expect(f.read()).toEqual(f.state);
});
it('keeps pending activation invisible to readers and explicitly recovers its committed database', () => {
    const f = fixture(); f.migrate(); rmSync(join(f.directory, 'state.json.pre-sqlite'));
    const file = join(f.directory, 'storage.json'), marker = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...marker, pending: true }));
    expect(f.read()).toBeNull(); expect(statusHostedDot(f.binding).status).toBe('not_started');
    expect(() => loadHostedState(f.file, f.config)).toThrow('hosted_storage_migration_incomplete');
    expect(changeHostedDotStorage(f.binding, 'recover')).toMatchObject({ recovered: true }); expect(f.read()).toEqual(f.state);
});
it('acknowledges an offline stop under runtime lock without altering inputs, output receipts or authority', async () => {
    const f = fixture(); f.migrate();
    writeFileSync(join(f.directory, 'control.json'), JSON.stringify({ id: 'maintenance-stop', action: 'stop' }));
    await stopHostedDot({ ...f.binding, requestId: 'maintenance-stop' });
    await stopHostedDot({ ...f.binding, requestId: 'maintenance-stop' });
    expect(f.read()).toEqual({ ...f.state, controls: [...f.state.controls, 'maintenance-stop'] });
    expect(statusHostedDot(f.binding).pendingInputs).toBe(0);
});
it('offline stop for a never-started Dot leaves no pending control that could block its first start', async () => {
    const f = fixture(); rmSync(f.file);
    await stopHostedDot({ ...f.binding, requestId: 'never-started-stop' });
    expect(existsSync(join(f.directory, 'control.json'))).toBe(false);
    writeFileSync(join(f.directory, 'control.json'), JSON.stringify({ id: 'never-started-stop', action: 'stop' }));
    await stopHostedDot({ ...f.binding, requestId: 'never-started-stop' });
    expect(existsSync(join(f.directory, 'control.json'))).toBe(false);
});
