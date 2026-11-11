/** Versioned local lifecycle boundary. The private on-disk protocol belongs to Happy. */
import { type BigIntStats, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { HostedDotConfig, HostedAuthorityMetadata, HOSTED_STATE_MAX_BYTES, hash, HostedDotJournal, savePrivate } from './hostedDotState';

export const HOSTED_DOT_LIFECYCLE_VERSION = 1 as const;
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Binding = z.strictObject({ directory: z.string().startsWith('/'), dotId: z.string().uuid(), sessionId: z.string().min(1) });
export type HostedDotBinding = z.infer<typeof Binding>;
const Identity = HostedAuthorityMetadata.shape.producer;
const Clear = Binding.extend({ requestId: z.string().min(1).max(200), epoch: integer.positive(), codexHome: z.string().startsWith('/') });
type ClearRequest = z.infer<typeof Clear>;
const settingsSchema = HostedDotConfig.pick({ model: true, effort: true });
const recoverable = new Set(['hosted_start_or_recovery_failed', 'hosted_mcp_refresh_failed']);
const uncertain = new Set(['dispatching', 'accepted', 'unknown']);
const backoff = [0, 30_000, 120_000, 600_000, 1_800_000];
function safePath(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) throw Error('hosted_lifecycle_path_invalid');
    let current = parse(path).root;
    for (const piece of path.slice(current.length).split('/').filter(Boolean)) {
        current = join(current, piece);
        try { if (lstatSync(current).isSymbolicLink()) throw Error('hosted_lifecycle_symlink'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
}
function present(file: string) { safePath(file); return lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
function stampEqual(a: BigIntStats, b: BigIntStats) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function read(file: string, maxBytes = HOSTED_STATE_MAX_BYTES): any {
    safePath(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd, { bigint: true });
        if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(maxBytes)) throw Error('hosted_lifecycle_file_invalid');
        const bytes = Buffer.alloc(Number(stat.size) + 1); let size = 0, n: number;
        while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
        if (BigInt(size) !== stat.size || !stampEqual(stat, fstatSync(fd, { bigint: true })) || !stampEqual(stat, lstatSync(file, { bigint: true }))) throw Error('hosted_lifecycle_file_changed');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    } finally { closeSync(fd); }
}
function syncDirectory(path: string) {
    safePath(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
function write(file: string, value: unknown) {
    safePath(file);
    if (present(file) && (!lstatSync(file).isFile() || lstatSync(file).nlink !== 1)) throw Error('hosted_lifecycle_file_invalid');
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > HOSTED_STATE_MAX_BYTES) throw Error('hosted_lifecycle_file_invalid');
    savePrivate(file, value); syncDirectory(dirname(file));
}
function lock(file: string, wait = 1000) {
    safePath(file);
    const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) { closeSync(fd); throw Error('hosted_lifecycle_lock_invalid'); }
    const r = spawnSync('flock', ['--exclusive', '--timeout', String(wait / 1000), '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: wait + 5000 });
    if (r.error || r.status !== 0) { closeSync(fd); throw Error('hosted_lifecycle_lock_busy'); }
    return () => closeSync(fd);
}
function identity(pid: number) {
    if (process.platform !== 'linux') throw Error('hosted_lifecycle_platform_unsupported');
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (['Z', 'X'].includes(fields[0])) return null;
        return Identity.parse({ pid, start: fields[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
    } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error; }
}
function alive(owner: z.infer<typeof Identity> | null) { return owner !== null && hash(identity(owner.pid)) === hash(owner); }
function binding(raw: HostedDotBinding) { const b = Binding.parse(raw); safePath(b.directory); return b; }
function configFor(b: HostedDotBinding) {
    const file = join(b.directory, 'config.json');
    if (!present(file)) return null;
    const config = HostedDotConfig.parse(read(file));
    if (config.directory !== b.directory || config.dotId !== b.dotId || config.sessionId !== b.sessionId) throw Error('hosted_lifecycle_binding_changed');
    return config;
}
function journalFor(b: HostedDotBinding, config: HostedDotConfig | null) {
    const file = join(b.directory, 'state.json');
    if (!present(file)) return null;
    if (!config) throw Error('hosted_lifecycle_binding_missing');
    const state = HostedDotJournal.parse(read(file));
    if (state.binding !== hash(config)) {
        const { effort, ...legacy } = config;
        if (state.binding !== hash(legacy)) throw Error('hosted_lifecycle_binding_changed');
        state.binding = hash(config);
    }
    if (state.epoch < floor(b.directory)) throw Error('hosted_epoch_stale');
    return state;
}
function floor(dir: string) { const file = join(dir, 'reset-epoch.json'); return present(file) ? z.strictObject({ epoch: integer }).parse(read(file)).epoch : 0; }
export function statusHostedDot(raw: HostedDotBinding) {
    const b = binding(raw), config = configFor(b), state = journalFor(b, config), file = join(b.directory, 'owner.json');
    const owner = present(file) ? Identity.parse(read(file)) : state?.authority?.producer ?? null;
    const running = alive(owner);
    if (state?.authority && alive(state.authority.producer) && hash(state.authority.producer) !== hash(owner)) throw Error('hosted_lifecycle_owner_changed');
    if (running && !config) throw Error('hosted_lifecycle_binding_missing');
    // A new owner cannot inherit its predecessor's running authority.
    const staleProducer = running && state?.authority && hash(state.authority.producer) !== hash(owner);
    return { version: 1 as const, dotId: b.dotId, sessionId: b.sessionId, running, owner,
        status: staleProducer || running && !state ? 'starting' as const : state?.status ?? 'not_started' as const,
        threadId: state?.threadId ?? null, epoch: state?.epoch ?? floor(b.directory), error: state?.error ?? null,
        clearPending: present(join(b.directory, 'lifecycle-clear.json')),
        controls: state?.controls ?? [], pendingInputs: state?.inputs.filter(row => ['queued', ...uncertain].includes(row.status)).length ?? 0 };
}
/** For configuration switches. Caller holds the shared launch lock until commit. */
export function assertHostedDotStopped(raw: HostedDotBinding) {
    const b = binding(raw), status = statusHostedDot(b);
    if (status.running) throw Error('dot_runtime_stop_hosted_first');
    if (status.clearPending) throw Error('dot_runtime_clear_pending');
    const release = lock(join(b.directory, 'runtime.lock'), 0); release();
}
function unfenced(b: HostedDotBinding) {
    if (present(join(b.directory, 'lifecycle-clear.json'))) throw Error('hosted_lifecycle_clear_pending');
    const control = join(b.directory, 'control.json');
    if (present(control) && read(control).action === 'delete') throw Error('hosted_lifecycle_deleted');
}
function recoverLocked(b: HostedDotBinding) {
    unfenced(b);
    const status = statusHostedDot(b);
    if (status.running) return { recovered: false, reason: 'running' };
    const release = lock(join(b.directory, 'runtime.lock'), 0);
    try {
        const config = configFor(b), state = journalFor(b, config);
        if (!state || state.status !== 'blocked' || !recoverable.has(state.error ?? '') || state.bootstrap?.stage === 'injecting' || state.inputs.some(row => uncertain.has(row.status))) return { recovered: false, reason: 'not_safe' };
        const file = join(b.directory, 'recovery.json');
        const prior = present(file) ? z.strictObject({ attempts: integer.positive(), lastAttemptAt: integer }).parse(read(file)) : { attempts: 0, lastAttemptAt: 0 };
        if (prior.attempts && Date.now() - prior.lastAttemptAt < backoff[Math.min(prior.attempts, backoff.length - 1)]) return { recovered: false, reason: 'backoff' };
        // Account the attempt first. A crash may delay recovery, never erase backoff.
        write(file, { attempts: prior.attempts + 1, lastAttemptAt: Date.now() });
        write(join(b.directory, 'state.json'), { ...state, status: 'starting', error: null });
        return { recovered: true };
    } finally { release(); }
}
export function recoverHostedDot(raw: HostedDotBinding) {
    const b = binding(raw); mkdirSync(b.directory, { recursive: true, mode: 0o700 });
    const release = lock(join(b.directory, 'launch.lock')); try { return recoverLocked(b); } finally { release(); }
}
export function startHostedDot(raw: { config: HostedDotConfig; entrypoint: string; settings?: z.infer<typeof settingsSchema>; authFile?: string }) {
    const config = HostedDotConfig.parse(raw.config), b = binding({ directory: config.directory, dotId: config.dotId, sessionId: config.sessionId });
    safePath(raw.entrypoint); if (!lstatSync(raw.entrypoint).isFile()) throw Error('hosted_lifecycle_entrypoint_invalid');
    mkdirSync(b.directory, { recursive: true, mode: 0o700 });
    const release = lock(join(b.directory, 'launch.lock'));
    try {
        unfenced(b);
        const old = configFor(b);
        if (old && hash(old) !== hash(config)) throw Error('hosted_lifecycle_configuration_changed');
        let status = statusHostedDot(b);
        const pendingControl = join(b.directory, 'control.json');
        if (present(pendingControl) && !status.controls.includes(read(pendingControl).id)) throw Error('hosted_lifecycle_control_pending');
        if (status.status === 'blocked' && !recoverLocked(b).recovered) throw Error('hosted_lifecycle_recovery_blocked');
        if (raw.settings) write(join(b.directory, 'settings.json'), settingsSchema.parse(raw.settings));
        if (status.running) {
            const recovery = join(b.directory, 'recovery.json');
            if (status.status !== 'blocked' && present(recovery)) rmSync(recovery);
            return status;
        }
        if (journalFor(b, configFor(b))?.bootstrap?.stage === 'injecting') throw Error('hosted_bootstrap_unconfirmed');
        const runtimeRelease = lock(join(b.directory, 'runtime.lock'), 0);
        try {
            safePath(config.codexHome); mkdirSync(config.codexHome, { recursive: true, mode: 0o700 });
            if (raw.authFile && !present(join(config.codexHome, 'auth.json'))) write(join(config.codexHome, 'auth.json'), read(raw.authFile, 1024 * 1024));
            write(join(b.directory, 'settings.json'), settingsSchema.parse(raw.settings ?? { model: config.model, effort: config.effort }));
            write(join(b.directory, 'config.json'), config);
        } finally { runtimeRelease(); }
        const logPath = join(b.directory, 'runtime.log'); safePath(logPath);
        const log = openSync(logPath, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        if (!fstatSync(log).isFile() || fstatSync(log).nlink !== 1) { closeSync(log); throw Error('hosted_lifecycle_log_invalid'); }
        let child;
        try { child = spawn(process.execPath, [raw.entrypoint, join(b.directory, 'config.json')], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, HAPPY_HOME_DIR: config.happyHome } }); }
        finally { closeSync(log); }
        child.on('error', () => { try { write(join(b.directory, 'launch-error.json'), { error: 'hosted_lifecycle_launch_failed' }); } catch {} }); child.unref();
        const owner = child.pid ? identity(child.pid) : null;
        if (!owner) throw Error('hosted_lifecycle_launch_unconfirmed');
        write(join(b.directory, 'owner.json'), owner);
        return statusHostedDot(b);
    } finally { release(); }
}
export async function stopHostedDot(raw: HostedDotBinding & { requestId: string; action?: 'stop' | 'delete'; timeoutMs?: number }) {
    const b = binding({ directory: raw.directory, dotId: raw.dotId, sessionId: raw.sessionId });
    const requestId = z.string().min(1).max(200).parse(raw.requestId), action = z.enum(['stop', 'delete']).parse(raw.action ?? 'stop');
    const timeoutMs = z.number().int().min(1).max(60_000).parse(raw.timeoutMs ?? 15000);
    mkdirSync(b.directory, { recursive: true, mode: 0o700 });
    const release = lock(join(b.directory, 'control.lock'));
    try {
        const releaseLaunch = lock(join(b.directory, 'launch.lock'));
        try {
            const status = statusHostedDot(b), file = join(b.directory, 'control.json');
            if (present(file)) {
                const prior = z.strictObject({ id: z.string(), action: z.enum(['stop', 'delete']) }).parse(read(file));
                if (prior.id === requestId && prior.action !== action) throw Error('hosted_lifecycle_request_conflict');
                if (prior.id !== requestId && !status.controls.includes(prior.id)) throw Error('hosted_lifecycle_control_pending');
            }
            write(file, { id: requestId, action });
        } finally { releaseLaunch(); }
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const status = statusHostedDot(b);
            if (!status.running) {
                // A producer may exit before consuming the control (including an
                // already-stopped producer). Complete only this stop while both
                // launch and runtime are fenced; do not manufacture input/turn
                // outcomes or clear a blocked journal to make restart succeed.
                const releaseLaunch = lock(join(b.directory, 'launch.lock'));
                try {
                    const quiescent = lock(join(b.directory, 'runtime.lock'), 0);
                    try {
                        if (!statusHostedDot(b).running) {
                            const file = join(b.directory, 'control.json');
                            const control = z.strictObject({ id: z.string(), action: z.enum(['stop', 'delete']) }).parse(read(file));
                            if (control.id !== requestId || control.action !== action) throw Error('hosted_lifecycle_request_conflict');
                            if (action === 'stop') {
                                const state = journalFor(b, configFor(b));
                                if (state && !state.controls.includes(requestId)) {
                                    write(join(b.directory, 'state.json'), { ...state, controls: [...state.controls, requestId] });
                                } else if (!state) {
                                    // Before first launch there is no journal in
                                    // which to acknowledge a stop. No producer can
                                    // run under these locks; remove only this stop.
                                    rmSync(file); syncDirectory(b.directory);
                                }
                            }
                            // Delete remains a durable fence, never restartable.
                            return;
                        }
                    } finally { quiescent(); }
                } finally { releaseLaunch(); }
            }
            if (Date.now() >= deadline) throw Error('hosted_lifecycle_stop_unconfirmed');
            await new Promise(done => setTimeout(done, 50));
        }
    } finally { release(); }
}
function clearRequest(raw: ClearRequest) { const c = Clear.parse(raw); binding({ directory: c.directory, dotId: c.dotId, sessionId: c.sessionId }); safePath(c.codexHome); return c; }
function matching(file: string, c: ClearRequest) { if (hash(Clear.parse(read(file))) !== hash(c)) throw Error('hosted_lifecycle_request_conflict'); }
export async function prepareHostedDotClear(raw: ClearRequest) {
    const c = clearRequest(raw), b = { directory: c.directory, dotId: c.dotId, sessionId: c.sessionId };
    mkdirSync(c.directory, { recursive: true, mode: 0o700 });
    const release = lock(join(c.directory, 'launch.lock'));
    try {
        const file = join(c.directory, 'lifecycle-clear.json'), receipt = join(c.directory, 'lifecycle-clear-receipt.json');
        if (present(receipt) && read(receipt).requestId === c.requestId) { matching(receipt, c); return; }
        if (present(file)) matching(file, c);
        else {
            const config = configFor(b), status = statusHostedDot(b);
            if (config && config.codexHome !== c.codexHome) throw Error('hosted_lifecycle_home_changed');
            if (c.epoch !== status.epoch + 1) throw Error('hosted_lifecycle_epoch_changed');
            write(file, c);
        }
    } finally { release(); }
    // The persistent fence survives failed stop/Relay rotation and prevents restart.
    if (statusHostedDot(b).running) await stopHostedDot({ ...b, requestId: c.requestId, action: 'stop' });
    const quiescent = lock(join(c.directory, 'runtime.lock'), 0); quiescent();
}
/** Completes only local clearing. Caller must first finish its external session rotation. */
export function clearHostedDot(raw: ClearRequest) {
    const c = clearRequest(raw), release = lock(join(c.directory, 'launch.lock'));
    try {
        const receipt = join(c.directory, 'lifecycle-clear-receipt.json'), intent = join(c.directory, 'lifecycle-clear.json');
        if (present(receipt) && read(receipt).requestId === c.requestId) { matching(receipt, c); if (present(intent)) { matching(intent, c); rmSync(intent); } return; }
        if (!present(intent)) throw Error('hosted_lifecycle_clear_not_prepared'); matching(intent, c);
        const b = { directory: c.directory, dotId: c.dotId, sessionId: c.sessionId }, config = configFor(b);
        if (config && config.codexHome !== c.codexHome) throw Error('hosted_lifecycle_home_changed');
        const ownerFile = join(c.directory, 'owner.json');
        if (present(ownerFile) && alive(Identity.parse(read(ownerFile)))) throw Error('hosted_lifecycle_stop_unconfirmed');
        const releaseRuntime = lock(join(c.directory, 'runtime.lock'), 0);
        try {
            if (floor(c.directory) > c.epoch) throw Error('hosted_lifecycle_epoch_changed');
            write(join(c.directory, 'reset-epoch.json'), { epoch: c.epoch });
            for (const name of ['state.json', 'config.json', 'control.json', 'task-gateway.json', 'events', 'recovery.json', 'bootstrap.json', 'owner.json']) {
                const path = join(c.directory, name); safePath(path); rmSync(path, { recursive: true, force: true });
            }
            for (const name of ['sessions', 'archived_sessions']) { const path = join(c.codexHome, name); safePath(path); rmSync(path, { recursive: true, force: true }); }
            if (present(c.codexHome)) syncDirectory(c.codexHome);
            write(receipt, c); rmSync(intent); syncDirectory(c.directory);
        } finally { releaseRuntime(); }
    } finally { release(); }
}

