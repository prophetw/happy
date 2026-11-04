import { lstat, open } from 'node:fs/promises';
import type { Credentials } from '@/persistence';
/** No login callback exists in this production path. Missing data always rejects. */
export async function existingAutomationAuth(machineID: string | undefined, deps: {
    credentials: () => Promise<Credentials | null>; settings: () => Promise<{ machineId?: string }>;
}) {
    const credentials = await deps.credentials(), settings = await deps.settings();
    if (!machineID || !credentials || credentials.encryption.type !== 'dataKey' || settings.machineId !== machineID) throw new Error('AUTOMATION_EXISTING_AUTH_REQUIRED');
    return { credentials, machineId: machineID };
}
/** A managed worker must keep its explicit configuration across bundle replacement. */
export function bundleReplacementAction(existingOnly: boolean) { return existingOnly ? 'supervisor' : 'legacy-handoff'; }

/** Check metadata only; malformed/unreadable state is presence, not permission to replace a daemon. */
export async function assertNoAutomationDaemonState(path: string) {
    try { await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('AUTOMATION_DAEMON_STATE_UNVERIFIED'); }
    throw new Error('AUTOMATION_DAEMON_ALREADY_PRESENT');
}

/** Dedicated managed entry never steals an unreadable/stale/EPERM lock. */
export async function acquireAutomationDaemonLock(path: string) {
    try { const fd = await open(path, 'wx', 0o600); await fd.writeFile(String(process.pid)); await fd.sync(); return fd; }
    catch { throw new Error('AUTOMATION_DAEMON_LOCK_UNAVAILABLE'); }
}

async function ownedAutomationLock(path: string, handle: Awaited<ReturnType<typeof open>>, pid: number) {
    const { constants } = await import('node:fs');
    const held = await handle.stat();
    const observed = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const current = await observed.stat();
        if (!current.isFile() || current.nlink !== 1 || current.uid !== process.getuid?.() || current.ino !== held.ino || current.dev !== held.dev || (await observed.readFile('utf8')).trim() !== String(pid)) throw Error('mismatch');
        return current;
    } finally { await observed.close(); }
}
/** Managed ownership cleanup never calls legacy clearDaemonState, which also unlinks locks. */
export async function clearOwnedAutomationState(statePath: string, lockPath: string, handle: Awaited<ReturnType<typeof open>>, pid = process.pid) {
    const { constants } = await import('node:fs'); const { unlink } = await import('node:fs/promises');
    await ownedAutomationLock(lockPath, handle, pid);
    const file = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const held = await file.stat(), value = JSON.parse(await file.readFile('utf8')), current = await lstat(statePath);
        if (!held.isFile() || held.nlink !== 1 || held.uid !== process.getuid?.() || value.pid !== pid || current.ino !== held.ino || current.dev !== held.dev) throw Error('AUTOMATION_STATE_OWNERSHIP_CHANGED');
        await ownedAutomationLock(lockPath, handle, pid); await unlink(statePath);
    } finally { await file.close(); }
}
export async function releaseOwnedAutomationLock(statePath: string, lockPath: string, handle: Awaited<ReturnType<typeof open>>, pid = process.pid) {
    const { unlink } = await import('node:fs/promises');
    await assertNoAutomationDaemonState(statePath); await ownedAutomationLock(lockPath, handle, pid);
    await unlink(lockPath); await handle.close();
}
