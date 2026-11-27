/** Happy-owned SQLite storage. Legacy JSON is read only by cold maintenance. */
import { createRequire } from 'node:module';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { type BigIntStats, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const nativeRequire = createRequire(import.meta.url);
export const HOSTED_STORAGE_VERSION = 2 as const;
export const HOSTED_STORAGE_LIMIT = 128 * 1024 * 1024;
export const HOSTED_INPUT_MAX_ROWS = 10000;
export const HOSTED_OUTPUT_MAX_ROWS = 100000;
const groups = ['inputs', 'outputs', 'controls'] as const;
type Group = typeof groups[number];
const maxRows = (kind: Group) => kind === 'inputs' ? HOSTED_INPUT_MAX_ROWS : kind === 'outputs' ? HOSTED_OUTPUT_MAX_ROWS : HOSTED_STORAGE_LIMIT;
type State = Record<string, any>;
const projection = Symbol('hosted-storage-read-only-projection');
const readDirectories = new WeakMap<State, string>();
export const hostedStorageReadDirectory = (state: State) => readDirectories.get(state);
// Lazy loading keeps JSON-only and older-Node consumers independent of node:sqlite.
type Database = { exec(sql: string): void; close(): void; prepare(sql: string): { get(...args: any[]): any; all(...args: any[]): any[]; run(...args: any[]): any } };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sentinel = JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_reader_required' });
const historySentinel = JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_history_reader_required' });
const coldName = 'state-history.sqlite';
export const HOSTED_RECEIPT_CHECKPOINT = 8192;
export const HOSTED_RETENTION_PAUSED = 'hosted-retention-paused';
const paths = (directory: string) => ({ json: join(directory, 'state.json'), marker: join(directory, 'storage.json'),
    db: join(directory, 'state.sqlite'), backup: join(directory, 'state.json.pre-sqlite'), temporary: join(directory, 'state.sqlite.migrating') });

function safePath(file: string) {
    if (!isAbsolute(file) || resolve(file) !== file) throw Error('hosted_storage_path_invalid');
    let current = parse(file).root;
    for (const part of file.slice(current.length).split('/').filter(Boolean)) {
        current = join(current, part);
        if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('hosted_storage_symlink');
    }
}
function exists(file: string) { safePath(file); return lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
function regular(file: string, limit = HOSTED_STORAGE_LIMIT) {
    safePath(file); const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw Error('hosted_storage_file_invalid');
    return stat;
}
function bytes(file: string, limit = HOSTED_STORAGE_LIMIT): Buffer {
    const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
    const validFile = (stat: BigIntStats) => stat.isFile() && stat.nlink <= 1n && stat.size <= BigInt(limit);
    let detached: BigIntStats | undefined;
    const descriptors: number[] = [];
    try {
        // A burst can publish an input, its native receipt and output ACK in
        // succession. Reopen only after proven atomic replacement, and keep a
        // small fixed bound so a changing file cannot authorize a stale input.
        for (let attempt = 0; attempt < 4; attempt++) {
            safePath(file);
            const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            // Keep the old descriptor open so the filesystem cannot reuse its inode
            // before the replacement has been verified.
            descriptors.push(fd);
            const before = fstatSync(fd, { bigint: true });
            if (!validFile(before)) throw Error('hosted_storage_file_invalid');
            if (detached && sameInode(before, detached)) throw Error('hosted_storage_file_changed');
            if (before.nlink === 0n) { detached = before; continue; }

            const result = Buffer.alloc(Number(before.size) + 1); let used = 0, n: number;
            while (used < result.length && (n = readSync(fd, result, used, result.length - used, null))) used += n;
            const after = fstatSync(fd, { bigint: true });
            if (!validFile(after) || !sameInode(before, after) || used !== Number(before.size) || after.size !== before.size
                || after.mtimeNs !== before.mtimeNs || after.nlink !== 0n && after.ctimeNs !== before.ctimeNs)
                throw Error('hosted_storage_file_changed');

            safePath(file);
            const named = lstatSync(file, { bigint: true });
            if (!validFile(named)) throw Error('hosted_storage_file_invalid');
            // Publication can detach the inode after open or during lstat. Only a
            // different, fully verified descriptor can supply the retry's bytes.
            if (!sameInode(before, named) || named.nlink === 0n) { detached = before; continue; }
            if (after.nlink !== 1n || named.size !== before.size || named.mtimeNs !== before.mtimeNs
                || named.ctimeNs !== before.ctimeNs) throw Error('hosted_storage_file_changed');
            return result.subarray(0, used);
        }
        throw Error('hosted_storage_file_changed');
    } finally {
        for (const fd of descriptors) closeSync(fd);
    }
}
function json(file: string, limit?: number): any { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(file, limit))); }
function syncDirectory(directory: string) {
    safePath(directory); const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durable(file: string, value: string | Buffer, exclusive = false) {
    safePath(file); if (exists(file)) regular(file);
    const target = exclusive ? file : file + '.' + randomUUID() + '.tmp';
    const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    if (!exclusive) renameSync(target, file);
    syncDirectory(dirname(file));
}
function marker(directory: string, backend: 'json' | 'sqlite', pending = false) {
    durable(paths(directory).marker, JSON.stringify({ version: 1, kind: 'happy-dot-state', directory, backend, ...(pending ? { pending: true } : {}) }));
}
export function hostedStorageBackend(directory: string): 'json' | 'sqlite' {
    const p = paths(directory);
    if (!exists(p.marker)) {
        if ([p.db, p.backup, p.temporary, p.db + '-journal', p.db + '-wal', p.db + '-shm', p.db + '.pre-json'].some(exists))
            throw Error('hosted_storage_migration_incomplete');
        if (exists(p.json)) return 'json';
        if (['config.json', 'owner.json', 'control.json', 'admission-status.json'].some(name => exists(join(directory, name))))
            throw Error('hosted_storage_missing');
        return 'sqlite';
    }
    const value = json(p.marker, 4096);
    if (value?.version !== 1 || value.kind !== 'happy-dot-state' || value.directory !== directory || !['json', 'sqlite'].includes(value.backend)) throw Error('hosted_storage_marker_invalid');
    if (value.pending !== undefined && (value.pending !== true || value.backend !== 'sqlite' || exists(p.backup))) throw Error('hosted_storage_marker_invalid');
    if (value.backend === 'sqlite' && !(value.pending && !exists(p.json))
        && ![sentinel, historySentinel].includes(bytes(p.json, 4096).toString('utf8'))) throw Error('hosted_storage_legacy_writer');
    if (value.backend === 'sqlite' && !value.pending && [p.temporary, p.temporary + '-journal'].some(exists))
        throw Error('hosted_storage_migration_incomplete');
    return value.backend;
}
function database<T>(directory: string, file: string, readonly: boolean, action: (db: Database) => T, sizeLimit = 512 * 1024 * 1024): T {
    regular(file, sizeLimit);
    for (const suffix of ['-journal', '-wal', '-shm']) {
        const sidecar = file + suffix;
        safePath(sidecar);
        let stat = lstatSync(sidecar, { throwIfNoEntry: false });
        // SQLite can unlink its DELETE journal while a concurrent reader is
        // resolving the pathname. Recheck this optional file once.
        if (suffix === '-journal' && stat?.isFile() && stat.nlink === 0) {
            safePath(sidecar);
            stat = lstatSync(sidecar, { throwIfNoEntry: false });
        }
        if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > sizeLimit))
            throw Error('hosted_storage_file_invalid');
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), before = fstatSync(fd);
    let db: Database | undefined;
    const unchanged = () => {
        safePath(file); const after = lstatSync(file), held = fstatSync(fd);
        if (after.dev !== before.dev || after.ino !== before.ino || held.nlink !== 1 || realpathSync(directory) !== directory) throw Error('hosted_storage_file_changed');
    };
    try {
        const { DatabaseSync } = nativeRequire('node:sqlite');
        db = new DatabaseSync(file, { readOnly: readonly, enableDoubleQuotedStringLiterals: false });
        db!.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;');
        if (!readonly) db!.exec('PRAGMA synchronous=FULL;');
        unchanged(); const result = action(db!); unchanged(); return result;
    } finally { db?.close(); closeSync(fd); }
}
function metadata(db: Database, directory: string) {
    const sizes = db.prepare('SELECT length(CAST(header AS BLOB)) AS header, length(counts) AS counts, length(trees) AS trees FROM metadata WHERE id=1').get();
    if (!sizes || sizes.header > HOSTED_STORAGE_LIMIT || sizes.counts > 4096 || sizes.trees > 4096) throw Error('hosted_storage_metadata_invalid');
    const row = db.prepare('SELECT * FROM metadata WHERE id=1').get();
    if (!row || ![1, HOSTED_STORAGE_VERSION].includes(row.version) || row.directory !== directory || !Number.isSafeInteger(row.generation) || row.generation < 1
        || !Number.isSafeInteger(row.logical_bytes) || row.logical_bytes > HOSTED_STORAGE_LIMIT || row.logical_bytes < 2
        || typeof row.header !== 'string' || digest(row.header + row.counts + row.trees) !== row.digest
        || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw Error('hosted_storage_metadata_invalid');
    return row;
}
export type HostedInputKey = { seq: number; id: string };
export type HostedArchivedInput = HostedInputKey & {
    epoch: number; status: 'completed' | 'failed' | 'interrupted' | 'rejected';
    textDigest: string; permissionMode?: string;
};
const archiveTable = `CREATE TABLE IF NOT EXISTS input_archive (
    epoch INTEGER NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL,
    PRIMARY KEY(epoch,seq,id)) WITHOUT ROWID`;
function writeInputArchive(db: Database, retired: readonly HostedArchivedInput[]) {
    if (!retired.length) return;
    db.exec(archiveTable);
    const stmt = db.prepare('INSERT INTO input_archive(epoch,seq,id,value,digest) VALUES(?,?,?,?,?)');
    for (const row of retired) {
        const value = JSON.stringify(row);
        stmt.run(row.epoch, row.seq, row.id, value, digest(value));
    }
}
export type HostedArchivedEvent = { id: string; epoch: number; status: HostedArchivedInput['status']; textDigest: string; acceptedAt?: number };
type Retirement = { users: readonly HostedArchivedInput[]; events: readonly HostedArchivedEvent[] };
function prepareHistory(directory: string, required: boolean) {
    const p = paths(directory), history = join(directory, coldName);
    // Publish the older-reader fence first. A crash here can retry safely, but
    // earlier producers must never see an apparently empty receipt set.
    if (bytes(p.json, 4096).toString('utf8') !== historySentinel) durable(p.json, historySentinel);
    if (!exists(history)) {
        if (required) throw Error('hosted_history_missing');
        durable(history, '', true);
    }
    const stat = regular(history, Number.MAX_SAFE_INTEGER);
    if (stat.dev !== regular(p.db, Number.MAX_SAFE_INTEGER).dev || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw Error('hosted_history_file_invalid');
    return history;
}
function attachHistory(db: Database, file: string, directory: string) {
    db.prepare('ATTACH DATABASE ? AS history').run(file);
    db.exec('PRAGMA history.synchronous=FULL');
    if (db.prepare('PRAGMA main.journal_mode').get()?.journal_mode !== 'delete'
        || db.prepare('PRAGMA history.journal_mode').get()?.journal_mode !== 'delete')
        throw Error('hosted_history_journal_mode_changed');
    db.exec(`CREATE TABLE IF NOT EXISTS history.identity (id INTEGER PRIMARY KEY CHECK(id=1), directory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS history.users (epoch INTEGER, seq INTEGER, id TEXT, value TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY(epoch,seq,id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history.events (epoch INTEGER, id TEXT, value TEXT NOT NULL, digest TEXT NOT NULL,
            PRIMARY KEY(epoch,id)) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history.outputs (id TEXT PRIMARY KEY, digest TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS history.progress (id INTEGER PRIMARY KEY CHECK(id=1), at TEXT NOT NULL,
            users INTEGER NOT NULL, events INTEGER NOT NULL, outputs INTEGER NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO history.identity VALUES(1,?)').run(directory);
    if (db.prepare('SELECT directory FROM history.identity WHERE id=1').get()?.directory !== directory)
        throw Error('hosted_history_binding_changed');
}
function withHistory<T>(directory: string, read: (db: Database) => T): T {
    return database(directory, join(directory, coldName), true, db => {
        if (db.prepare('SELECT directory FROM identity WHERE id=1').get()?.directory !== directory)
            throw Error('hosted_history_binding_changed');
        return read(db);
    }, Number.MAX_SAFE_INTEGER);
}
function verifiedHistoryRow(row: any) {
    if (!row) return;
    if (typeof row.value !== 'string' || digest(row.value) !== row.digest) throw Error('hosted_history_record_changed');
    return JSON.parse(row.value);
}
export function hostedHistoryOutput(directory: string, id: string) {
    return withHistory(directory, db => {
        const row = db.prepare('SELECT digest FROM outputs WHERE id=?').get(id);
        if (row && row.digest !== digest(id)) throw Error('hosted_history_record_changed');
        return !!row;
    });
}
export function hostedColdOutputCount(directory: string) {
    if (!exists(join(directory, coldName))) return 0;
    return withHistory(directory, db => Number(db.prepare('SELECT outputs FROM progress WHERE id=1').get()?.outputs ?? 0));
}
export function hostedHistoryEvent(directory: string, epoch: number, id: string): HostedArchivedEvent | undefined {
    return withHistory(directory, db => {
        const row = verifiedHistoryRow(db.prepare('SELECT value,digest FROM events WHERE epoch=? AND id=?').get(epoch, id));
        if (row && (row.epoch !== epoch || row.id !== id)) throw Error('hosted_history_record_changed');
        return row;
    });
}
function writeHistory(db: Database, retired: Retirement, spill: readonly ReceiptRow[]) {
    const users = db.prepare('INSERT INTO history.users VALUES(?,?,?,?,?)'), events = db.prepare('INSERT INTO history.events VALUES(?,?,?,?)');
    for (const row of retired.users) {
        const value = JSON.stringify(row);
        users.run(row.epoch, row.seq, row.id, value, digest(value));
    }
    for (const row of retired.events) {
        const value = JSON.stringify(row);
        events.run(row.epoch, row.id, value, digest(value));
    }
    const outputs = db.prepare('INSERT INTO history.outputs VALUES(?,?)');
    for (const row of spill) outputs.run(row.localId, row.digest);
    db.prepare(`INSERT INTO history.progress VALUES(1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET at=excluded.at,users=users+excluded.users,events=events+excluded.events,outputs=outputs+excluded.outputs`)
        .run(new Date().toISOString(), retired.users.length, retired.events.length, spill.length);
    if (spill.length) {
        db.exec('DELETE FROM output_receipts');
    }
}
function readInputArchive(db: Database, directory: string, header: State, keys: readonly HostedInputKey[]): HostedArchivedInput[] {
    if (!keys.length || header.retiredUserSeq === undefined) return [];
    const statement = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='input_archive'").get()
        ? db.prepare('SELECT value,digest FROM input_archive WHERE epoch=? AND seq=? AND id=?') : undefined;
    return keys.flatMap(key => {
        if (key.seq > header.retiredUserSeq) return [];
        const row = statement?.get(header.epoch, key.seq, key.id) ?? (header.historyVersion === 1
            ? withHistory(directory, cold => cold.prepare('SELECT value,digest FROM users WHERE epoch=? AND seq=? AND id=?')
                .get(header.epoch, key.seq, key.id)) : undefined);
        if (!row) return [];
        if (typeof row.value !== 'string' || digest(row.value) !== row.digest) throw Error('hosted_input_archive_invalid');
        const value = JSON.parse(row.value);
        if (value.epoch !== header.epoch || value.seq !== key.seq || value.id !== key.id) throw Error('hosted_input_archive_invalid');
        return [value];
    });
}
function readDatabase(directory: string, file: string, selected: readonly Group[] = groups, archiveKeys: readonly HostedInputKey[] = []): State {
    return database(directory, file, true, db => {
        db.exec('BEGIN');
        try {
            const meta = metadata(db, directory), result = JSON.parse(meta.header);
            const counts = JSON.parse(meta.counts), trees = JSON.parse(meta.trees);
            for (const kind of selected) {
                if (!Object.hasOwn(result, kind)) continue;
                const size = db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM records WHERE kind=?').get(kind);
                if (size.count !== counts[kind] || size.count > maxRows(kind) || size.bytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_storage_records_invalid');
                const rows = db.prepare('SELECT position,value,digest FROM records WHERE kind=? ORDER BY position').all(kind);
                if (digest(rows.map(row => row.digest).join('')) !== trees[kind]) throw Error('hosted_storage_records_invalid');
                result[kind] = rows.map((row, position) => {
                    if (position !== row.position || typeof row.value !== 'string' || digest(row.value) !== row.digest) throw Error('hosted_storage_records_invalid');
                    return JSON.parse(row.value);
                });
            }
            if (meta.version === HOSTED_STORAGE_VERSION && groups.every(kind => selected.includes(kind))) {
                const rows = db.prepare('SELECT position,local_id,digest FROM output_receipts ORDER BY position').all();
                if (rows.length !== counts.outputReceipts || digest(rows.map(row => row.digest).join('')) !== trees.outputReceipts) throw Error('hosted_storage_receipts_invalid');
                const seen = new Set<string>();
                result.outputReceipts = rows.map((row, position) => {
                    if (position !== row.position || typeof row.local_id !== 'string' || digest(row.local_id) !== row.digest || seen.has(row.local_id)) throw Error('hosted_storage_receipts_invalid');
                    seen.add(row.local_id); return row.local_id;
                });
                if (Array.isArray(result.outputs) && result.outputs.some((row: any) => seen.has(row?.localId))) throw Error('hosted_storage_receipts_invalid');
            }
            if (result.historyVersion === 1 && !exists(join(directory, coldName))) throw Error('hosted_history_missing');
            if (archiveKeys.length) result.archivedInputs = readInputArchive(db, directory, result, archiveKeys);
            return result;
        } finally { db.exec('ROLLBACK'); }
    });
}
/** Small projections deliberately skip output bodies. Always uses a fresh read transaction. */
export function readHostedStorage(file: string, selected: readonly Group[] = groups, archiveKeys: readonly HostedInputKey[] = []): State | null {
    const directory = dirname(file);
    assertHostedStorageReadyForStart(file);
    const p = paths(directory);
    if (!exists(p.marker) || json(p.marker, 4096).pending) return null;
    const value = readDatabase(directory, p.db, selected, archiveKeys);
    readDirectories.set(value, directory);
    if (groups.some(kind => !selected.includes(kind))) Object.defineProperty(value, projection, { value: true, enumerable: true });
    return value;
}
/** With the runtime lock held, staged files indicate an interrupted activation. */
export function assertHostedStorageReadyForStart(file: string) {
    if (basename(file) !== 'state.json') throw Error('hosted_storage_path_invalid');
    const directory = dirname(file), p = paths(directory);
    if (hostedStorageBackend(directory) !== 'sqlite') throw Error('hosted_storage_migration_required');
    if (exists(p.marker) && json(p.marker, 4096).pending
        && [p.db, p.temporary, p.temporary + '-journal', p.db + '-journal', p.db + '-wal', p.db + '-shm'].some(exists))
        throw Error('hosted_storage_migration_incomplete');
}
/** Reserve a new journal before publishing the configuration that authorizes its producer. */
export function prepareHostedStorage(directory: string) {
    const p = paths(directory);
    assertHostedStorageReadyForStart(p.json);
    if (!exists(p.marker)) marker(directory, 'sqlite', true);
    if (!exists(p.json) && json(p.marker, 4096).pending) durable(p.json, sentinel, true);
}
type ReceiptRow = { position: number; localId: string; digest: string };
function assertReceiptsDisjoint(receiptRows: ReceiptRow[] | Set<string>, outputs: unknown) {
    let ids: Set<string>;
    if (receiptRows instanceof Set) ids = receiptRows;
    else {
        ids = new Set<string>();
        for (const row of receiptRows) {
            if (ids.has(row.localId)) throw Error('hosted_storage_receipts_invalid');
            ids.add(row.localId);
        }
    }
    if (Array.isArray(outputs) && outputs.some(row => ids.has(row?.localId))) throw Error('hosted_storage_receipts_invalid');
}
function encode(state: State) {
    const header = { ...state }, rows: { kind: Group; position: number; value: string; digest: string }[] = [];
    let extraBytes = 0;
    const counts: Record<string, number> = {}, trees: Record<string, string> = {};
    const hasReceipts = Object.hasOwn(state, 'outputReceipts');
    if (hasReceipts && !Array.isArray(state.outputReceipts)) throw Error('hosted_storage_receipts_invalid');
    const receiptRows: ReceiptRow[] = hasReceipts ? state.outputReceipts.map((localId: unknown, position: number) => {
        if (typeof localId !== 'string') throw Error('hosted_storage_receipts_invalid');
        return { position, localId, digest: digest(localId) };
    }) : [];
    assertReceiptsDisjoint(receiptRows, state.outputs);
    if (hasReceipts) {
        header.outputReceipts = [];
        counts.outputReceipts = receiptRows.length;
        trees.outputReceipts = digest(receiptRows.map(row => row.digest).join(''));
    }
    for (const kind of groups) {
        if (!Object.hasOwn(state, kind)) continue;
        if (!Array.isArray(state[kind]) || state[kind].length > maxRows(kind)) throw Error('hosted_storage_records_invalid');
        header[kind] = [];
        state[kind].forEach((row: unknown, position: number) => {
            const value = JSON.stringify(row);
            if (value === undefined) throw Error('hosted_storage_records_invalid');
            extraBytes += Buffer.byteLength(value) + (position ? 1 : 0);
            if (extraBytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_authority_state_too_large');
            rows.push({ kind, position, value, digest: digest(value) });
        });
        counts[kind] = state[kind].length;
        if (kind === 'outputs') counts.pendingOutputs = state.outputs.filter((row: any) => row.sent === false).length;
        trees[kind] = digest(rows.filter(row => row.kind === kind).map(row => row.digest).join(''));
    }
    const value = JSON.stringify(header), logicalBytes = Buffer.byteLength(value) + extraBytes;
    if (logicalBytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_authority_state_too_large');
    return { header: value, rows, receiptRows, hasReceipts, logicalBytes, counts: JSON.stringify(counts), trees: JSON.stringify(trees) };
}
const receiptTable = `CREATE TABLE IF NOT EXISTS output_receipts (
    position INTEGER PRIMARY KEY CHECK(position>=0), local_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL) WITHOUT ROWID`;
function writeReceipts(db: Database, previous: any, encoded: ReturnType<typeof encode>, version: number, unchanged = false) {
    if (version === 1 || unchanged) return;
    if (!encoded.hasReceipts) throw Error('hosted_storage_receipts_invalid');
    db.exec(receiptTable);
    const oldCount = previous?.version === HOSTED_STORAGE_VERSION ? JSON.parse(previous.counts).outputReceipts ?? 0 : 0;
    if (!Number.isSafeInteger(oldCount) || oldCount < 0 || encoded.receiptRows.length < oldCount) throw Error('hosted_storage_receipts_invalid');
    if (oldCount) {
        const oldRows = db.prepare('SELECT position,local_id,digest FROM output_receipts ORDER BY position').all();
        if (oldRows.length !== oldCount) throw Error('hosted_storage_receipts_invalid');
        for (let n = 0; n < oldCount; n++) {
            const old = oldRows[n], current = encoded.receiptRows[n];
            if (old.position !== n || old.local_id !== current.localId || old.digest !== current.digest) throw Error('hosted_storage_receipts_invalid');
        }
    }
    const insert = db.prepare('INSERT INTO output_receipts(position,local_id,digest) VALUES(?,?,?)');
    for (let n = oldCount; n < encoded.receiptRows.length; n++) {
        const row = encoded.receiptRows[n]; insert.run(row.position, row.localId, row.digest);
    }
}
function writeDatabase(directory: string, file: string, state: State, initial = false) {
    const encoded = encode(initial ? { ...state, outputReceipts: state.outputReceipts ?? [] } : state);
    return database(directory, file, false, db => {
        if (initial) db.exec(`PRAGMA journal_mode=DELETE;
            CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, directory TEXT NOT NULL, generation INTEGER NOT NULL, header TEXT NOT NULL, digest TEXT NOT NULL, logical_bytes INTEGER NOT NULL, counts TEXT NOT NULL, trees TEXT NOT NULL);
            CREATE TABLE records (kind TEXT NOT NULL CHECK(kind IN ('inputs','outputs','controls')), position INTEGER NOT NULL CHECK(position>=0), value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind,position)) WITHOUT ROWID;`);
        if (initial) db.exec(receiptTable);
        db.exec('BEGIN IMMEDIATE');
        try {
            const previous = initial ? null : metadata(db, directory);
            const version = initial || previous?.version === HOSTED_STORAGE_VERSION || encoded.receiptRows.length ? HOSTED_STORAGE_VERSION : 1;
            writeReceipts(db, previous, encoded, version);
            const old = new Map(db.prepare('SELECT kind,position,digest FROM records').all().map(row => [row.kind + ':' + row.position, row.digest]));
            const upsert = db.prepare('INSERT INTO records(kind,position,value,digest) VALUES(?,?,?,?) ON CONFLICT(kind,position) DO UPDATE SET value=excluded.value,digest=excluded.digest');
            let changedRecords = 0, deletedRecords = 0;
            for (const row of encoded.rows) {
                const key = row.kind + ':' + row.position;
                if (old.get(key) !== row.digest) { upsert.run(row.kind, row.position, row.value, row.digest); changedRecords++; }
                old.delete(key);
            }
            const remove = db.prepare('DELETE FROM records WHERE kind=? AND position=?');
            for (const key of old.keys()) { const [kind, position] = key.split(':'); remove.run(kind, Number(position)); deletedRecords++; }
            const generation = (previous?.generation ?? 0) + 1;
            if (!Number.isSafeInteger(generation)) throw Error('hosted_storage_revision_exhausted');
            db.prepare('INSERT OR REPLACE INTO metadata VALUES(1,?,?,?,?,?,?,?,?)').run(version, directory, generation, encoded.header, digest(encoded.header + encoded.counts + encoded.trees), encoded.logicalBytes, encoded.counts, encoded.trees);
            db.exec('COMMIT'); return { generation, changedRecords, deletedRecords, logicalBytes: encoded.logicalBytes };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
}
export function saveHostedStorage(file: string, state: State) {
    if (Reflect.get(state, projection)) throw Error('hosted_storage_projection_read_only');
    const directory = dirname(file), p = paths(directory);
    assertHostedStorageReadyForStart(file);
    prepareHostedStorage(directory);
    return json(p.marker, 4096).pending ? activate(directory, state) : writeDatabase(directory, p.db, state);
}

type EncodedRow = { position: number; value: string; digest: string; bytes: number; pending: boolean };
/** Output bodies/identities are immutable. Only delivery ACKs change after append.
 * Own the array and freeze bodies so every supported mutation invalidates its
 * cache, including a retained row reference's sent setter. */
class OutputEncoding {
    readonly rows: any[];
    private dirty = new Set<number>();
    private digests: string[] = [];
    private lengths: number[] = [];
    private pendingRows: boolean[] = [];
    private pending = 0;
    private checkpoints: Hash[] = [createHash('sha256')];
    private tree = digest('');
    private bytes = 0;
    private frozen = new WeakSet<object>();
    private readonly stride = 256;

    constructor(rows: any[]) {
        const owned = rows.map((row, position) => this.own(row, position));
        this.rows = new Proxy(owned, {
            set: (target, key, value) => {
                if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < 0xffffffff) {
                    const position = Number(key); this.dirty.add(position); value = this.own(value, position);
                }
                return Reflect.set(target, key, value);
            },
            deleteProperty: (target, key) => {
                if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) this.dirty.add(Number(key));
                return Reflect.deleteProperty(target, key);
            },
        });
    }
    private freeze(value: any): void {
        if (!value || typeof value !== 'object' || this.frozen.has(value)) return;
        this.frozen.add(value);
        for (const child of Object.values(value)) this.freeze(child);
        Object.freeze(value);
    }
    private own(value: any, position: number) {
        if (!value || typeof value !== 'object' || typeof value.localId !== 'string' || typeof value.sent !== 'boolean')
            throw Error('hosted_storage_records_invalid');
        const row = { ...value }; let sent = row.sent;
        for (const key of Object.keys(row)) if (key !== 'sent') {
            this.freeze(row[key]); Object.defineProperty(row, key, { writable: false, configurable: false });
        }
        Object.defineProperty(row, 'sent', { enumerable: true, configurable: false,
            get: () => sent, set: value => {
                if (typeof value !== 'boolean') throw Error('hosted_storage_records_invalid');
                if (value !== sent) { sent = value; this.dirty.add(position); }
            } });
        return Object.seal(row);
    }
    stage() {
        const count = this.rows.length;
        if (count > maxRows('outputs')) throw Error('hosted_storage_records_invalid');
        const positions = new Set(this.dirty);
        for (let n = this.digests.length; n < count; n++) positions.add(n);
        const updates = new Map<number, EncodedRow>();
        let bytes = this.bytes, pending = this.pending, first = count < this.digests.length ? count : Infinity;
        for (let n = count; n < this.lengths.length; n++) {
            bytes -= this.lengths[n]; pending -= Number(this.pendingRows[n]);
        }
        for (const position of positions) if (position < count) {
            const value = JSON.stringify(this.rows[position]);
            if (value === undefined) throw Error('hosted_storage_records_invalid');
            const size = Buffer.byteLength(value);
            bytes += size - (this.lengths[position] ?? 0);
            const unsent = !this.rows[position].sent;
            pending += Number(unsent) - Number(this.pendingRows[position] ?? false);
            updates.set(position, { position, value, digest: digest(value), bytes: size, pending: unsent }); first = Math.min(first, position);
        }
        let tree = this.tree;
        const start = Number.isFinite(first) ? Math.floor(first / this.stride) * this.stride : undefined;
        const checkpoints: Hash[] = [];
        if (start !== undefined) {
            // Same v1 SHA-256(concatenated row digests), starting from a cached
            // prefix. An append/near-tail ACK hashes at most one history block.
            const hash = this.checkpoints[start / this.stride].copy();
            for (let n = start; n < count; n++) {
                if (n % this.stride === 0) checkpoints.push(hash.copy());
                const value = updates.get(n)?.digest ?? this.digests[n];
                if (!value) throw Error('hosted_storage_records_invalid');
                hash.update(value);
            }
            if (count % this.stride === 0) checkpoints.push(hash.copy());
            tree = hash.copy().digest('hex');
        }
        return { rows: [...updates.values()], count, bytes, pending, tree, committed: () => {
            // Advance only after COMMIT and file-identity checks succeed.
            for (const row of updates.values()) { this.digests[row.position] = row.digest; this.lengths[row.position] = row.bytes; this.pendingRows[row.position] = row.pending; }
            this.digests.length = this.lengths.length = this.pendingRows.length = count;
            if (start !== undefined) { this.checkpoints.length = start / this.stride; this.checkpoints.push(...checkpoints); }
            this.bytes = bytes; this.pending = pending; this.tree = tree; this.dirty.clear();
        } };
    }
}

function ownReceiptRows(rows: unknown): string[] {
    if (!Array.isArray(rows)) throw Error('hosted_storage_receipts_invalid');
    const owned = rows.slice() as string[];
    return new Proxy(owned, {
        set: (target, key, value) => {
            if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) {
                if (Number(key) < target.length || typeof value !== 'string') throw Error('hosted_storage_receipts_invalid');
            }
            if (key === 'length' && (typeof value !== 'number' || value < target.length)) throw Error('hosted_storage_receipts_invalid');
            return Reflect.set(target, key, value);
        },
        deleteProperty: () => { throw Error('hosted_storage_receipts_invalid'); },
    });
}
type ReceiptCache = { source: string[]; rows: ReceiptRow[]; ids: Set<string>; tree: string };

/** One writer per locked runtime. SQLite retains its v1 disk format, FULL sync
 * and atomic header/row/ACK transactions. Cold/JSON/lifecycle writes keep the
 * snapshot entry point; the live writer never re-encodes settled output bodies. */
export function createHostedStorageWriter(file: string, state: State) {
    if (Reflect.get(state, projection)) throw Error('hosted_storage_projection_read_only');
    if (basename(file) !== 'state.json') throw Error('hosted_storage_path_invalid');
    const directory = dirname(file), p = paths(directory);
    prepareHostedStorage(directory);
    let outputs: OutputEncoding | undefined, generation: number | undefined;
    let receiptSource: string[] | undefined, receiptCache: ReceiptCache | undefined, receiptCandidate: ReceiptCache | undefined;
    let previousRows = new Map<string, string>();
    let identity: { dev: number; ino: number } | undefined;
    return (retired: readonly HostedArchivedInput[] = [], archivedEvents: readonly HostedArchivedEvent[] = []) => {
        if (Reflect.get(state, projection)) throw Error('hosted_storage_projection_read_only');
        if (hostedStorageBackend(directory) !== 'sqlite') throw Error('hosted_storage_backend_changed');
        if (!outputs || outputs.rows !== state.outputs) {
            if (!Array.isArray(state.outputs)) throw Error('hosted_storage_records_invalid');
            outputs = new OutputEncoding(state.outputs); state.outputs = outputs.rows;
        }
        const hasReceipts = Object.hasOwn(state, 'outputReceipts');
        if (!hasReceipts) { receiptSource = undefined; receiptCache = undefined; }
        else if (receiptSource !== state.outputReceipts) {
            receiptSource = ownReceiptRows(state.outputReceipts); state.outputReceipts = receiptSource; receiptCache = undefined;
        }
        const coldEnabled = process.env.HAPPY_HOSTED_COLD_HISTORY !== '0' && !exists(join(directory, HOSTED_RETENTION_PAUSED)) && !json(p.marker, 4096).pending;
        const spillRequested = coldEnabled && state.outputReceipts?.length >= HOSTED_RECEIPT_CHECKPOINT;
        const coldNeeded = coldEnabled && (retired.length > 0 || archivedEvents.length > 0 || spillRequested);
        const preparedHistory = coldNeeded ? prepareHistory(directory, state.historyVersion === 1) : undefined;
        if (preparedHistory) state.historyVersion = 1;
        if (archivedEvents.length && !preparedHistory) throw Error('hosted_event_history_unavailable');
        const receiptsUnchanged = !spillRequested && Boolean(hasReceipts && receiptCache?.source === state.outputReceipts
            && receiptCache!.rows.length === state.outputReceipts.length);
        const encodedState: State = { ...state, outputs: [] };
        if (hasReceipts) encodedState.outputReceipts = receiptsUnchanged ? [] : state.outputReceipts;
        const output = outputs.stage(), encoded = encode(encodedState);
        receiptCandidate = undefined;
        if (hasReceipts && !receiptsUnchanged) receiptCandidate = {
            source: state.outputReceipts, rows: encoded.receiptRows, ids: new Set(encoded.receiptRows.map(row => row.localId)),
            tree: JSON.parse(encoded.trees).outputReceipts,
        };
        assertReceiptsDisjoint(receiptsUnchanged ? receiptCache!.ids : encoded.receiptRows, state.outputs);
        const counts = { ...JSON.parse(encoded.counts), outputs: output.count, pendingOutputs: output.pending }, trees = { ...JSON.parse(encoded.trees), outputs: output.tree };
        if (receiptsUnchanged) { counts.outputReceipts = receiptCache!.rows.length; trees.outputReceipts = receiptCache!.tree; }
        const logicalBytes = encoded.logicalBytes + output.bytes + Math.max(0, output.count - 1);
        if (logicalBytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_authority_state_too_large');
        const split = spillRequested ? encoded.receiptRows.length - 2048 : 0;
        const spilled = encoded.receiptRows.slice(0, split);
        const retained = split ? encoded.receiptRows.slice(split) : [];
        if (split) {
            counts.outputReceipts = retained.length;
            trees.outputReceipts = digest(retained.map(row => row.digest).join(''));
        }
        const countsJSON = JSON.stringify(counts), treesJSON = JSON.stringify(trees);
        const rows = [...encoded.rows.filter(row => previousRows.get(row.kind + ':' + row.position) !== row.digest),
            ...output.rows.map(row => ({ ...row, kind: 'outputs' as const }))];
        let result;
        if (json(p.marker, 4096).pending) {
            if (retired.length) throw Error('hosted_input_archive_requires_active_sqlite');
            result = saveHostedStorage(file, state);
        }
        else {
            const stat = regular(p.db, 512 * 1024 * 1024);
            if (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino)) throw Error('hosted_storage_file_changed');
            result = database(directory, p.db, false, db => {
                if (preparedHistory) attachHistory(db, preparedHistory, directory);
                db.exec('BEGIN IMMEDIATE');
                try {
                    const previous = metadata(db, directory);
                    if (generation !== undefined && previous.generation !== generation) throw Error('hosted_storage_revision_changed');
                    const version = previous.version === HOSTED_STORAGE_VERSION || encoded.receiptRows.length ? HOSTED_STORAGE_VERSION : 1;
                    writeReceipts(db, previous, encoded, version, receiptsUnchanged);
                    if (preparedHistory) {
                        writeHistory(db, { users: retired, events: archivedEvents }, spilled);
                        if (split) {
                            const append = db.prepare('INSERT INTO output_receipts(position,local_id,digest) VALUES(?,?,?)');
                            for (const [position, row] of retained.entries()) append.run(position, row.localId, row.digest);
                        }
                    } else writeInputArchive(db, retired);
                    const next = previous.generation + 1;
                    if (!Number.isSafeInteger(next)) throw Error('hosted_storage_revision_exhausted');
                    const upsert = db.prepare('INSERT INTO records(kind,position,value,digest) VALUES(?,?,?,?) ON CONFLICT(kind,position) DO UPDATE SET value=excluded.value,digest=excluded.digest WHERE records.digest<>excluded.digest');
                    let changedRecords = 0, deletedRecords = 0;
                    for (const row of rows) changedRecords += upsert.run(row.kind, row.position, row.value, row.digest).changes;
                    const oldCounts = JSON.parse(previous.counts);
                    for (const kind of groups) if ((oldCounts[kind] ?? 0) > (counts[kind] ?? 0))
                        deletedRecords += db.prepare('DELETE FROM records WHERE kind=? AND position>=?').run(kind, counts[kind] ?? 0).changes;
                    db.prepare('INSERT OR REPLACE INTO metadata VALUES(1,?,?,?,?,?,?,?,?)').run(version, directory, next, encoded.header,
                        digest(encoded.header + countsJSON + treesJSON), logicalBytes, countsJSON, treesJSON);
                    db.exec('COMMIT'); return { generation: next, changedRecords, deletedRecords, logicalBytes };
                } catch (error) { db.exec('ROLLBACK'); throw error; }
            });
        }
        const stat = regular(p.db, 512 * 1024 * 1024);
        output.committed(); generation = result.generation; identity = { dev: stat.dev, ino: stat.ino };
        if (split) {
            state.outputReceipts = receiptSource = ownReceiptRows(retained.map(row => row.localId));
            receiptCache = undefined;
        } else if (receiptCandidate) receiptCache = receiptCandidate;
        previousRows = new Map(encoded.rows.map(row => [row.kind + ':' + row.position, row.digest]));
        return result;
    };
}
function activate(directory: string, state: State) {
    const p = paths(directory);
    if (exists(p.temporary)) throw Error('hosted_storage_migration_temporary_exists');
    durable(p.temporary, '', true);
    const complete = { ...state, outputReceipts: state.outputReceipts ?? [] };
    const result = writeDatabase(directory, p.temporary, complete, true);
    assertStorageMatches(directory, p.temporary, complete);
    if (exists(p.db)) throw Error('hosted_storage_database_exists');
    renameSync(p.temporary, p.db); syncDirectory(directory);
    // A tiny refusal marker makes old binaries reject startup rather than create an empty thread.
    durable(p.json, sentinel); marker(directory, 'sqlite');
    return result;
}
function assertStorageMatches(directory: string, file: string, expected: State) {
    if (JSON.stringify(readDatabase(directory, file)) !== JSON.stringify(expected))
        throw Error('hosted_storage_migration_mismatch');
}

/** An uncommitted stage can be retried from the verified, durable JSON source. */
function resumeImportStage(directory: string, stage: string, expected: State) {
    let recovered: State;
    try { recovered = readDatabase(directory, stage); }
    catch (error) {
        const failure = error as Error & { errcode?: number };
        if (!['hosted_storage_metadata_invalid', 'hosted_storage_records_invalid'].includes(failure.message)
            && ![1, 11, 26, 776].includes(failure.errcode ?? 0)) throw error;
        const archive = stage + '.rejected-' + randomUUID();
        for (const suffix of ['-journal', '']) {
            if (!exists(stage + suffix)) continue;
            regular(stage + suffix, 512 * 1024 * 1024);
            renameSync(stage + suffix, archive + suffix);
        }
        syncDirectory(directory);
        return false;
    }
    if (JSON.stringify(recovered) !== JSON.stringify(expected)) throw Error('hosted_storage_migration_mismatch');
    return true;
}

function migrationSummary(state: State) {
    return { digest: digest(JSON.stringify(state)), epoch: state.epoch, afterSeq: state.afterSeq,
        inputs: state.inputs.length, outputs: state.outputs.length,
        pendingOutputs: state.outputs.filter((row: { sent: boolean }) => !row.sent).length,
        outputReceipts: state.outputReceipts?.length ?? 0, controls: state.controls?.length ?? 0 };
}

export function readHostedStorageImportSource(file: string) {
    const original = bytes(file);
    return { original, state: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original)) as State };
}

/** Caller holds the launch and runtime locks of a stopped, bound Dot. */
export function migrateHostedStorage(directory: string, validate: (state: State) => void) {
    const p = paths(directory), selected = exists(p.marker) ? json(p.marker, 4096) : null;
    if (selected && (selected.version !== 1 || selected.kind !== 'happy-dot-state' || selected.directory !== directory))
        throw Error('hosted_storage_marker_invalid');
    if (selected?.backend === 'sqlite') {
        if (selected.pending === true) {
            // The first activation may have committed a complete journal but
            // died before publishing its marker. Only promote a verified DB.
            if (exists(p.backup) || exists(p.db) && exists(p.temporary)) throw Error('hosted_storage_migration_incomplete');
            const file = exists(p.db) ? p.db : p.temporary;
            const state = readDatabase(directory, file);
            validate(state);
            if (file === p.temporary) { renameSync(file, p.db); syncDirectory(directory); }
            durable(p.json, sentinel); marker(directory, 'sqlite');
            return { migrated: true, backend: 'sqlite', snapshotAt: new Date().toISOString(),
                source: migrationSummary(state), target: migrationSummary(state) };
        }
        hostedStorageBackend(directory);
        const state = readDatabase(directory, p.db);
        validate(state);
        return { migrated: false, backend: 'sqlite', snapshotAt: new Date().toISOString(), target: migrationSummary(state) };
    }
    if (selected && (selected.backend !== 'json' || selected.pending !== undefined)
        || exists(p.db + '.pre-json') || !exists(p.backup) && [p.db, p.temporary].some(exists))
        throw Error('hosted_storage_migration_incomplete');
    const { original, state: source } = readHostedStorageImportSource(exists(p.backup) ? p.backup : p.json);
    validate(source);
    const complete = { ...source, outputReceipts: source.outputReceipts ?? [] };
    if (!exists(p.backup)) durable(p.backup, original);
    if (exists(p.json)) {
        const current = bytes(p.json);
        if (!current.equals(original) && current.toString('utf8') !== sentinel)
            throw Error('hosted_storage_migration_source_changed');
    }
    if (exists(p.db)) {
        if (exists(p.temporary)) throw Error('hosted_storage_migration_incomplete');
        assertStorageMatches(directory, p.db, complete);
        durable(p.json, sentinel); marker(directory, 'sqlite');
    } else if (exists(p.temporary) && resumeImportStage(directory, p.temporary, complete)) {
        renameSync(p.temporary, p.db); syncDirectory(directory);
        durable(p.json, sentinel); marker(directory, 'sqlite');
    } else {
        activate(directory, complete);
    }
    const target = readDatabase(directory, p.db);
    validate(target);
    return { migrated: true, backend: 'sqlite', snapshotAt: new Date().toISOString(),
        sourceBytesSHA256: createHash('sha256').update(original).digest('hex'),
        source: migrationSummary(complete), target: migrationSummary(target) };
}
export function removeHostedStorage(directory: string) {
    const selected = exists(paths(directory).marker) ? json(paths(directory).marker, 4096) : null;
    const retainSqlite = selected?.version === 1 && selected.directory === directory && selected.backend === 'sqlite';
    for (const name of ['storage.json', 'state.json', 'state.sqlite', 'state.sqlite-journal', 'state.sqlite-wal', 'state.sqlite-shm',
        'state.sqlite.migrating', 'state.sqlite.migrating-journal', 'state.json.pre-sqlite', 'state.sqlite.pre-json']) {
        if (name === 'storage.json' && retainSqlite) continue;
        const file = join(directory, name); if (exists(file)) { regular(file, 512 * 1024 * 1024); unlinkSync(file); }
    }
    if (retainSqlite) { durable(paths(directory).json, sentinel); marker(directory, 'sqlite', true); }
    syncDirectory(directory);
}
