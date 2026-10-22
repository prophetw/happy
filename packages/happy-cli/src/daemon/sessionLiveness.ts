import type { PersistedSession } from '@/persistence';

// Adapted from chphch's PR #1715. Only ESRCH proves absence: permission errors
// must not permit a second owner, and a saved PID is never authority to kill.
export function isPidAlive(pid: number | undefined, kill: (pid: number, signal: 0) => void = process.kill): boolean {
    if (!Number.isSafeInteger(pid) || pid! <= 0) return false;
    try {
        kill(pid!, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

export function machineBootTimeMs(uptimeSeconds: number, nowMs: number): number {
    return nowMs - uptimeSeconds * 1000;
}

/** Only a previous boot or an absent valid PID proves a saved session stopped. */
export function isPersistedSessionStopped(session: PersistedSession, bootTimeMs: number): boolean {
    if (!Number.isFinite(session.savedAt) || session.savedAt <= 0 || !Number.isFinite(bootTimeMs)) return false;
    if (session.savedAt < bootTimeMs) return true;
    const pid = session.metadata?.hostPid;
    return Number.isSafeInteger(pid) && pid! > 0 && !isPidAlive(pid);
}

/** A live saved PID is a possible conflict, not verified session ownership. */
export function hasPersistedProcessConflict(session: PersistedSession | undefined, bootTimeMs: number): boolean {
    if (!session || session.savedAt < bootTimeMs) return false;
    return isPidAlive(session.metadata?.hostPid);
}
