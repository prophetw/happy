import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markSessionStopped, persistSession, readPersistedSession, readPersistedSessions, type PersistedSession } from './persistence';

const config = vi.hoisted(() => ({ sessionsFile: '', logsDir: '/tmp', isDaemonProcess: false }));
const clock = vi.hoisted(() => ({ uptime: vi.fn(() => 365 * 24 * 60 * 60) }));
vi.mock('@/configuration', () => ({ configuration: config }));
vi.mock('node:fs', async original => {
    const actual = await original<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) };
});
vi.mock('node:os', async original => {
    const actual = await original<typeof import('node:os')>();
    return { ...actual, uptime: clock.uptime, default: { ...actual, uptime: clock.uptime } };
});
let root: string;
const DAY = 86400000;
function record(overrides: Partial<PersistedSession> = {}): PersistedSession {
    return { encryptionKey: 'fixture-key', encryptionVariant: 'dataKey', seq: 1, metadataVersion: 1, agentStateVersion: 1,
        metadata: { hostPid: 12345, path: '/fixture/project' } as PersistedSession['metadata'], savedAt: Date.now(), ...overrides };
}
const write = (sessions: Record<string, unknown>, filename = config.sessionsFile) => writeFileSync(filename, JSON.stringify({ sessions }));
const reads = () => vi.mocked(readFileSync).mock.calls.filter(([filename]) => typeof filename === 'number' || filename === config.sessionsFile).length;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'happy-session-lookup-')); config.sessionsFile = join(root, 'sessions.json');
    vi.clearAllMocks(); clock.uptime.mockReturnValue(365 * 24 * 60 * 60);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('absent'), { code: 'ESRCH' }); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('parses one file generation once and probes only the requested session', () => {
    write(Object.fromEntries(Array.from({ length: 263 }, (_, i) => ['session-' + i, record()])));
    for (let i = 0; i < 20; i++) expect(readPersistedSession('session-100')?.encryptionKey).toBe('fixture-key');
    expect(reads()).toBe(1);
    expect(process.kill).toHaveBeenCalledTimes(20);
    expect(clock.uptime).toHaveBeenCalledTimes(20);
});

it('computes boot time once for a full registry read', () => {
    write(Object.fromEntries(Array.from({ length: 263 }, (_, i) => ['session-' + i, record()])));
    expect(Object.keys(readPersistedSessions())).toHaveLength(263);
    expect(clock.uptime).toHaveBeenCalledTimes(1);
});

it('invalidates after an atomic replacement even if size and mtime are unchanged', () => {
    const before = record({ encryptionKey: 'first-key' }), after = { ...before, encryptionKey: 'other-key', metadata: { ...before.metadata, hostPid: 54321 } };
    write({ s1: before }); expect(readPersistedSession('s1')).toEqual(before);
    const stamp = statSync(config.sessionsFile), replacement = join(root, 'replacement'); write({ s1: after }, replacement);
    utimesSync(replacement, stamp.atime, stamp.mtime); renameSync(replacement, config.sessionsFile);
    expect(readPersistedSession('s1')).toEqual(after); expect(reads()).toBe(2);
});

it('detects an in-place rewrite with restored mtime', () => {
    const before = record({ encryptionKey: 'first-key' }), after = { ...before, encryptionKey: 'other-key' };
    write({ s1: before }); readPersistedSession('s1'); const stamp = statSync(config.sessionsFile);
    write({ s1: after }); utimesSync(config.sessionsFile, stamp.atime, stamp.mtime);
    expect(readPersistedSession('s1')).toEqual(after);
});

it('does not return a mixed generation when the file changes during a cache load', () => {
    const before = record(), after = record({ encryptionKey: 'replaced' }); write({ s1: before });
    const actual = vi.mocked(readFileSync).getMockImplementation()!;
    vi.mocked(readFileSync).mockImplementationOnce(((...args: Parameters<typeof readFileSync>) => {
        const replacement = join(root, 'replacement'); write({ s1: after }, replacement); renameSync(replacement, config.sessionsFile);
        return actual(...args);
    }) as typeof readFileSync);
    expect(readPersistedSession('s1')).toBeUndefined();
    expect(readPersistedSession('s1')).toEqual(after);
});

it('never serves cached keys after missing, corrupt, or unreadable state', () => {
    write({ s1: record() }); expect(readPersistedSession('s1')).toBeDefined();
    unlinkSync(config.sessionsFile); expect(readPersistedSession('s1')).toBeUndefined();
    writeFileSync(config.sessionsFile, '{broken'); expect(readPersistedSession('s1')).toBeUndefined();
    write({ s1: record({ encryptionKey: 'new-value' }) }); expect(readPersistedSession('s1')?.encryptionKey).toBe('new-value');
    chmodSync(config.sessionsFile, 0); expect(readPersistedSession('s1')).toBeUndefined();
    chmodSync(config.sessionsFile, 0o600); expect(readPersistedSession('s1')?.encryptionKey).toBe('new-value');
});

it('rechecks retention as time passes without rereading unchanged bytes', () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    write({ s1: record({ savedAt: now - 60 * DAY, lastAliveAt: now }) });
    expect(readPersistedSession('s1')).toBeDefined();
    vi.mocked(Date.now).mockReturnValue(now + 14 * DAY);
    expect(readPersistedSession('s1')).toBeUndefined(); expect(reads()).toBe(1);
});

it('rechecks a live PID on every lookup and expires its key only when absence is confirmed', () => {
    write({ s1: record({ savedAt: Date.now() - 60 * DAY }) });
    vi.mocked(process.kill).mockReturnValue(true); expect(readPersistedSession('s1')).toBeDefined();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); });
    expect(readPersistedSession('s1')).toBeUndefined(); expect(reads()).toBe(1);
});

it.each(['EPERM', 'EACCES'])('retains an old key when liveness remains unknown (%s)', code => {
    write({ s1: record({ savedAt: Date.now() - 60 * DAY }) });
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('unverified'), { code }); });
    expect(readPersistedSession('s1')).toBeDefined();
});

it('never treats a pre-boot saved PID as its current owner', () => {
    write({ s1: record({ savedAt: Date.now() - 30 * DAY, lastAliveAt: Date.now() - 30 * DAY }) });
    clock.uptime.mockReturnValue(60); vi.mocked(process.kill).mockReturnValue(true);
    expect(readPersistedSession('s1')).toBeUndefined(); expect(process.kill).not.toHaveBeenCalled();
});

it('returns detached values so a caller cannot mutate the cached key or identity', () => {
    const saved = record(); write({ s1: saved }); const first = readPersistedSession('s1')!;
    first.encryptionKey = 'changed'; first.metadata.hostPid = 99999;
    expect(readPersistedSession('s1')).toEqual(saved);
});

it('observes same-process persist and stop writes immediately while retaining other live keys', () => {
    const old = record({ savedAt: Date.now() - 60 * DAY }); write({ s1: old });
    vi.mocked(process.kill).mockReturnValue(true); expect(readPersistedSession('s1')).toEqual(old);
    persistSession('s2', record({ encryptionKey: 'second' }));
    expect(readPersistedSession('s1')).toEqual(old); expect(readPersistedSession('s2')?.encryptionKey).toBe('second');
    markSessionStopped('s1'); vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); });
    expect(readPersistedSession('s1')?.lastAliveAt).toBeGreaterThan(Date.now() - 5000);
});

it('does not resolve inherited property names or salvage a globally corrupt registry', () => {
    write({ s1: record() }); expect(readPersistedSession('toString')).toBeUndefined();
    write({ s1: record(), broken: null }); expect(readPersistedSession('s1')).toBeUndefined();
});
