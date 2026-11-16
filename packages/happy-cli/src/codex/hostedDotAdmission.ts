/** Local-owner admission fence. Separate from the business journal/storage backend.
 * Pause drains native turns; it never discards inputs, aborts tools or stops business agents.
 * Expired leases stay closed until an explicit CAS resume. Legacy producers never ACK.
 */
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const HOSTED_DOT_ADMISSION_VERSION = 1;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Identity = z.strictObject({ pid: integer.positive(), start: z.string().regex(/^\d+$/), boot: z.string().uuid() });
const Binding = z.strictObject({ directory: z.string().startsWith('/'), dotId: z.string().uuid(), sessionId: z.string().min(1), epoch: integer });
export type AdmissionBinding = z.infer<typeof Binding>;
const Operation = z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/), action: z.enum(['pause', 'resume']), leaseUntil: integer, expectedRevision: integer });
const Intent = z.strictObject({ version: z.literal(1), binding: Binding, revision: integer.positive(), operation: Operation, history: z.array(Operation).max(64) });
const Status = z.strictObject({ version: z.literal(1), binding: Binding, owner: Identity, revision: integer, operationId: z.string().nullable(),
    phase: z.enum(['open', 'draining', 'paused', 'stopped']), expired: z.boolean(), at: integer });
type IntentValue = z.infer<typeof Intent>;
function pathCheck(path: string) {
    if (resolve(path) !== path) throw Error('hosted_admission_path_invalid');
    let p = parse(path).root;
    for (const part of path.slice(p.length).split('/').filter(Boolean)) {
        p = join(p, part); if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error('hosted_admission_symlink');
    }
}
function read(file: string) {
    pathCheck(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const s = fstatSync(fd, { bigint: true });
        if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid!()) || (s.mode & 0o077n) || s.size > 65536n) throw Error('hosted_admission_file_invalid');
        const bytes = readFileSync(fd), end = fstatSync(fd, { bigint: true }), named = lstatSync(file, { bigint: true });
        if (s.dev !== named.dev || s.ino !== named.ino || s.size !== BigInt(bytes.length) || s.mtimeNs !== end.mtimeNs || s.ctimeNs !== end.ctimeNs || s.ctimeNs !== named.ctimeNs) throw Error('hosted_admission_file_changed');
        return JSON.parse(bytes.toString('utf8'));
    } finally { closeSync(fd); }
}
function present(file: string) { pathCheck(file); return lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
function write(file: string, value: unknown) {
    pathCheck(file); if (present(file)) read(file);
    const tmp = file + '.' + randomUUID() + '.tmp', fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    const parent = openSync(resolve(file, '..'), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
function check(raw: AdmissionBinding) {
    const b = Binding.parse(raw); pathCheck(b.directory);
    const dir = lstatSync(b.directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)) throw Error('hosted_admission_directory_invalid');
    const config = read(join(b.directory, 'config.json'));
    if (config.directory !== b.directory || config.dotId !== b.dotId || config.sessionId !== b.sessionId) throw Error('hosted_admission_binding_changed');
    return b;
}
function intent(b: AdmissionBinding): IntentValue | null {
    const file = join(b.directory, 'admission-intent.json');
    if (!present(file)) return null;
    const value = Intent.parse(read(file));
    if (!same(value.binding, b)) throw Error('hosted_admission_binding_changed');
    return value;
}
function alive(owner: z.infer<typeof Identity>) {
    try {
        const s = readFileSync(`/proc/${owner.pid}/stat`, 'utf8').split(') ').pop()!.split(' ');
        return !['Z', 'X'].includes(s[0]) && s[19] === owner.start && readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === owner.boot;
    } catch { return false; }
}
function lock(directory: string, name: string) {
    const file = join(directory, name); pathCheck(file);
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) { closeSync(fd); throw Error('hosted_admission_lock_invalid'); }
    if (spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] }).status !== 0) { closeSync(fd); throw Error('hosted_admission_busy'); }
    return () => closeSync(fd);
}
/** No remote/model endpoint. Caller must be the same OS owner of the private runtime. */
export function readHostedAdmission(raw: AdmissionBinding) {
    const b = check(raw), desired = intent(b), file = join(b.directory, 'admission-status.json');
    const status = present(file) ? Status.parse(read(file)) : null;
    if (status && !same(status.binding, b)) throw Error('hosted_admission_binding_changed');
    return { version: 1 as const, desired, status, supported: Boolean(status && status.phase !== 'stopped' && alive(status.owner)),
        acknowledged: Boolean(status && status.phase !== 'stopped' && alive(status.owner) && status.revision === (desired?.revision ?? 0)),
        expired: Boolean(desired?.operation.action === 'pause' && desired.operation.leaseUntil < Date.now()) };
}
/** CAS command. A stopped runtime can be boot-held explicitly; a legacy live runtime is refused. */
export function requestHostedAdmission(raw: AdmissionBinding & { operation: z.infer<typeof Operation>; bootstrapStopped?: boolean }) {
    const b = check({ directory: raw.directory, dotId: raw.dotId, sessionId: raw.sessionId, epoch: raw.epoch }), op = Operation.parse(raw.operation), release = lock(b.directory, 'admission.lock');
    let releaseRuntime: (() => void) | undefined;
    try {
        const current = intent(b);
        const replay = current?.history.find(x => x.id === op.id);
        if (replay) { if (!same(replay, op)) throw Error('hosted_admission_operation_conflict'); return readHostedAdmission(b); }
        if ((current?.revision ?? 0) !== op.expectedRevision) throw Error('hosted_admission_revision_conflict');
        // Reserve the last receipt for an explicit resume; expiry never reopens admission.
        if ((current?.history.length ?? 0) >= (op.action === 'pause' ? 63 : 64)) throw Error('hosted_admission_history_full');
        if (op.action === 'pause' && (op.leaseUntil <= Date.now() || op.leaseUntil > Date.now() + 3600000)) throw Error('hosted_admission_lease_invalid');
        if (raw.bootstrapStopped) {
            if (op.action !== 'pause') throw Error('hosted_admission_bootstrap_invalid');
            releaseRuntime = lock(b.directory, 'runtime.lock');
        } else if (!readHostedAdmission(b).supported) throw Error('hosted_admission_legacy_or_offline');
        write(join(b.directory, 'admission-intent.json'), { version: 1, binding: b, revision: op.expectedRevision + 1, operation: op, history: [...(current?.history ?? []), op] });
        return readHostedAdmission(b);
    } finally { releaseRuntime?.(); release(); }
}
/** Called only while holding the native runtime lock. Checks immediately before every dispatch. */
export function createHostedAdmission(raw: AdmissionBinding, owner: z.infer<typeof Identity>) {
    const b = check(raw); Identity.parse(owner);
    let last = '', lastAt = 0;
    const tick = (active: boolean, stopped = false) => {
        const desired = intent(b), holding = desired?.operation.action === 'pause';
        const value = { version: 1, binding: b, owner, revision: desired?.revision ?? 0, operationId: desired?.operation.id ?? null,
            phase: stopped ? 'stopped' : holding ? active ? 'draining' : 'paused' : 'open',
            expired: Boolean(holding && desired!.operation.leaseUntil < Date.now()), at: Date.now() };
        const key = JSON.stringify({ ...value, at: 0 });
        if (key !== last || Date.now() - lastAt >= 1000) { write(join(b.directory, 'admission-status.json'), value); last = key; lastAt = Date.now(); }
        return !holding;
    };
    return { permits: tick, stopped: () => tick(false, true) };
}
