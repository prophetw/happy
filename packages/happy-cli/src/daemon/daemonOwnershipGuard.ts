import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises';
import { readLinuxProcess } from 'happy-agent/automation';

type ManagedOwner = { pid: number; bootID: string; startTicks: string; namespace: string; dev: number; ino: number };
const unavailable = () => Error('AUTOMATION_DAEMON_LOCK_UNAVAILABLE');

/** Never unlink the guard inode. All same-home managed admissions and cooperating ordinary
 * lock mutations serialize here. Ordinary-only homes retain their existing platform behaviour. */
export async function withDaemonOwnershipGuard<T>(lock: string, managed: boolean, action: (guard?: FileHandle) => Promise<T>) {
    let guard: FileHandle;
    try {
        guard = await open(lock + '.guard', constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
            | (managed ? constants.O_CREAT : 0), 0o600);
    } catch (error) {
        if (!managed && (error as NodeJS.ErrnoException).code === 'ENOENT') return action();
        throw unavailable();
    }
    try {
        const stat = await guard.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 4096
            || spawnSync('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore','ignore','ignore',guard.fd] }).status !== 0)
            throw unavailable();
        if (!managed) {
            const current = await lstat(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
            if (current && stat.size) {
                const marker = JSON.parse(await guard.readFile('utf8')) as ManagedOwner;
                if (marker.dev === current.dev && marker.ino === current.ino) throw unavailable();
            }
        }
        return await action(guard);
    } finally { await guard.close(); }
}

export async function recordManagedOwner(guard: FileHandle, handle: FileHandle) {
    const identity = readLinuxProcess(process.pid), inode = await handle.stat();
    if (!identity) throw unavailable();
    const record: ManagedOwner = { pid: process.pid, bootID: identity.bootID, startTicks: identity.startTicks,
        namespace: await readlink('/proc/self/ns/pid'), dev: inode.dev, ino: inode.ino };
    await guard.truncate(0);
    await guard.write(JSON.stringify(record), 0, 'utf8');
    await guard.sync();
}

/** Only ESRCH in the original boot and PID namespace certifies exit. A reused numeric
 * PID, EPERM, unreadable procfs or a legacy PID-only lock is held for manual inspection. */
export async function deadManagedOwner(guard: FileHandle, handle: FileHandle) {
    const marker = JSON.parse(await guard.readFile('utf8')) as ManagedOwner, observed = await handle.stat();
    const current = readLinuxProcess(process.pid);
    if (!current || marker.bootID !== current.bootID || marker.namespace !== await readlink('/proc/self/ns/pid')
        || !/^\d+$/.test(marker.startTicks) || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
        || observed.dev !== marker.dev || observed.ino !== marker.ino || observed.size > 32
        || !observed.isFile() || observed.uid !== current.uid || observed.nlink !== 1
        || (await handle.readFile('utf8')).trim() !== String(marker.pid)) throw unavailable();
    try { process.kill(marker.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return marker.pid; }
    throw unavailable();
}
