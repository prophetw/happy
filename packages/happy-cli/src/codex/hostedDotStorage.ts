/** Happy-owned storage. JSON remains readable until an explicit, cold migration. */
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const nativeRequire = createRequire(import.meta.url);
export const HOSTED_STORAGE_VERSION = 1 as const;
export const HOSTED_STORAGE_LIMIT = 32 * 1024 * 1024;
const groups = ['inputs', 'outputs', 'controls'] as const;
type Group = typeof groups[number];
const maxRows = (kind: Group) => kind === 'inputs' ? 10000 : kind === 'outputs' ? 50000 : HOSTED_STORAGE_LIMIT;
type State = Record<string, any>;
const projection = Symbol('hosted-storage-read-only-projection');
// Lazy loading keeps JSON-only and older-Node consumers independent of node:sqlite.
type Database = { exec(sql: string): void; close(): void; prepare(sql: string): { get(...args: any[]): any; all(...args: any[]): any[]; run(...args: any[]): any } };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sentinel = JSON.stringify({ version: 0, storage: 'sqlite', error: 'hosted_sqlite_reader_required' });
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
    regular(file, limit);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) throw Error('hosted_storage_file_invalid');
        const result = Buffer.alloc(Number(before.size) + 1); let used = 0, n: number;
        while (used < result.length && (n = readSync(fd, result, used, result.length - used, null))) used += n;
        const after = fstatSync(fd, { bigint: true }), path = lstatSync(file, { bigint: true });
        if (used !== Number(before.size) || [after, path].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size
            || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs || s.nlink !== 1n)) throw Error('hosted_storage_file_changed');
        return result.subarray(0, used);
    } finally { closeSync(fd); }
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
        if ([p.db, p.backup, p.temporary].some(exists)) throw Error('hosted_storage_migration_incomplete');
        return 'json';
    }
    const value = json(p.marker, 4096);
    if (value?.version !== 1 || value.kind !== 'happy-dot-state' || value.directory !== directory || !['json', 'sqlite'].includes(value.backend)) throw Error('hosted_storage_marker_invalid');
    if (value.pending !== undefined && (value.pending !== true || value.backend !== 'sqlite' || exists(p.backup))) throw Error('hosted_storage_marker_invalid');
    if (value.backend === 'sqlite' && bytes(p.json, 4096).toString('utf8') !== sentinel) throw Error('hosted_storage_legacy_writer');
    return value.backend;
}
function database<T>(directory: string, file: string, readonly: boolean, action: (db: Database) => T): T {
    regular(file, 512 * 1024 * 1024);
    for (const suffix of ['-journal', '-wal', '-shm']) if (exists(file + suffix)) regular(file + suffix, 512 * 1024 * 1024);
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
    if (!row || row.version !== 1 || row.directory !== directory || !Number.isSafeInteger(row.generation) || row.generation < 1
        || !Number.isSafeInteger(row.logical_bytes) || row.logical_bytes > HOSTED_STORAGE_LIMIT || row.logical_bytes < 2
        || typeof row.header !== 'string' || digest(row.header + row.counts + row.trees) !== row.digest
        || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw Error('hosted_storage_metadata_invalid');
    return row;
}
function readDatabase(directory: string, file: string, selected: readonly Group[] = groups): State {
    return database(directory, file, true, db => {
        db.exec('BEGIN');
        try {
            const meta = metadata(db, directory), result = JSON.parse(meta.header);
            for (const kind of selected) {
                if (!Object.hasOwn(result, kind)) continue;
                const size = db.prepare('SELECT count(*) AS count, coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM records WHERE kind=?').get(kind);
                const counts = JSON.parse(meta.counts), trees = JSON.parse(meta.trees);
                if (size.count !== counts[kind] || size.count > maxRows(kind) || size.bytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_storage_records_invalid');
                const rows = db.prepare('SELECT position,value,digest FROM records WHERE kind=? ORDER BY position').all(kind);
                if (digest(rows.map(row => row.digest).join('')) !== trees[kind]) throw Error('hosted_storage_records_invalid');
                result[kind] = rows.map((row, position) => {
                    if (position !== row.position || typeof row.value !== 'string' || digest(row.value) !== row.digest) throw Error('hosted_storage_records_invalid');
                    return JSON.parse(row.value);
                });
            }
            return result;
        } finally { db.exec('ROLLBACK'); }
    });
}
/** Small projections deliberately skip output bodies. Always uses a fresh read transaction. */
export function readHostedStorage(file: string, selected: readonly Group[] = groups): State | null {
    const directory = dirname(file);
    if (basename(file) === 'state.json' && hostedStorageBackend(directory) === 'sqlite') {
        if (json(paths(directory).marker, 4096).pending) return null;
        const value = readDatabase(directory, paths(directory).db, selected);
        if (groups.some(kind => !selected.includes(kind))) Object.defineProperty(value, projection, { value: true, enumerable: true });
        return value;
    }
    if (!exists(file)) return null;
    const value = json(file);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('hosted_storage_state_invalid');
    return value;
}
/** With the runtime lock held, staged files indicate an interrupted activation. */
export function assertHostedStorageReadyForStart(file: string) {
    if (basename(file) !== 'state.json') return;
    const directory = dirname(file), p = paths(directory);
    if (hostedStorageBackend(directory) === 'sqlite' && json(p.marker, 4096).pending && [p.db, p.temporary].some(exists)) throw Error('hosted_storage_migration_incomplete');
}
function encode(state: State) {
    const header = { ...state }, rows: { kind: Group; position: number; value: string; digest: string }[] = [];
    let extraBytes = 0;
    const counts: Record<string, number> = {}, trees: Record<string, string> = {};
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
        trees[kind] = digest(rows.filter(row => row.kind === kind).map(row => row.digest).join(''));
    }
    const value = JSON.stringify(header), logicalBytes = Buffer.byteLength(value) + extraBytes;
    if (logicalBytes > HOSTED_STORAGE_LIMIT) throw Error('hosted_authority_state_too_large');
    return { header: value, rows, logicalBytes, counts: JSON.stringify(counts), trees: JSON.stringify(trees) };
}
function writeDatabase(directory: string, file: string, state: State, initial = false) {
    const encoded = encode(state);
    return database(directory, file, false, db => {
        if (initial) db.exec(`PRAGMA journal_mode=DELETE;
            CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, directory TEXT NOT NULL, generation INTEGER NOT NULL, header TEXT NOT NULL, digest TEXT NOT NULL, logical_bytes INTEGER NOT NULL, counts TEXT NOT NULL, trees TEXT NOT NULL);
            CREATE TABLE records (kind TEXT NOT NULL CHECK(kind IN ('inputs','outputs','controls')), position INTEGER NOT NULL CHECK(position>=0), value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind,position)) WITHOUT ROWID;`);
        db.exec('BEGIN IMMEDIATE');
        try {
            const previous = initial ? null : metadata(db, directory);
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
            db.prepare('INSERT OR REPLACE INTO metadata VALUES(1,1,?,?,?,?,?,?,?)').run(directory, generation, encoded.header, digest(encoded.header + encoded.counts + encoded.trees), encoded.logicalBytes, encoded.counts, encoded.trees);
            db.exec('COMMIT'); return { generation, changedRecords, deletedRecords, logicalBytes: encoded.logicalBytes };
        } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
}
/** JSON roots retain compatibility until an explicit, cold conversion. */
export function saveHostedStorage(file: string, state: State) {
    if (Reflect.get(state, projection)) throw Error('hosted_storage_projection_read_only');
    const directory = dirname(file), p = paths(directory);
    if (basename(file) === 'state.json') {
        if (hostedStorageBackend(directory) === 'sqlite') return json(p.marker, 4096).pending ? activate(directory, state) : writeDatabase(directory, p.db, state);
    }
    const value = JSON.stringify(state);
    if (Buffer.byteLength(value) > HOSTED_STORAGE_LIMIT) throw Error('hosted_authority_state_too_large');
    durable(file, value); return { generation: 0, changedRecords: 0, deletedRecords: 0, logicalBytes: Buffer.byteLength(value) };
}
function activate(directory: string, state: State) {
    const p = paths(directory);
    if (exists(p.temporary)) throw Error('hosted_storage_migration_temporary_exists');
    durable(p.temporary, '', true);
    const result = writeDatabase(directory, p.temporary, state, true);
    if (JSON.stringify(readDatabase(directory, p.temporary)) !== JSON.stringify(state)) throw Error('hosted_storage_migration_mismatch');
    if (exists(p.db)) throw Error('hosted_storage_database_exists');
    renameSync(p.temporary, p.db); syncDirectory(directory);
    // A tiny refusal marker makes old binaries reject startup rather than create an empty thread.
    durable(p.json, sentinel); marker(directory, 'sqlite');
    return result;
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
