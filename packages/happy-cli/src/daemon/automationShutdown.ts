/** Managed worker shutdown: remote failures never skip safe local ownership cleanup. */
export async function cleanupAutomationDaemon(steps: {
    stopWorker: () => Promise<void>;
    closeCredentials?: () => Promise<void>;
    announce: () => Promise<void>;
    disconnect: () => void;
    stopControl: () => Promise<void>;
    clearState: () => Promise<void>;
    releaseLock: () => Promise<void>;
    stopCaffeinate: () => Promise<void>;
}, report: (phase: string, outcome: 'completed' | 'unconfirmed') => void, budgetMs = 2000) {
    const notice = (phase: string, outcome: 'completed' | 'unconfirmed') => { try { report(phase, outcome); } catch { /* Never let logging strand ownership. */ } };
    const attempt = async (phase: string, operation: () => Promise<void> | void, budget = budgetMs) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('SHUTDOWN_DEADLINE')), budget); })]);
            notice(phase, 'completed'); return true;
        } catch { notice(phase, 'unconfirmed'); return false; }
        finally { if (timer) clearTimeout(timer); }
    };
    await attempt('worker-drain', steps.stopWorker, budgetMs * 3);
    await attempt('credential-close', () => steps.closeCredentials?.());
    await attempt('relay-announcement', steps.announce);
    const disconnected = await attempt('relay-disconnect', steps.disconnect);
    const stopped = await attempt('control-close', steps.stopControl);
    // Unknown listeners/ownership must retain the lock. Never invent a clean restart.
    const cleared = disconnected && stopped && await attempt('state-clear', steps.clearState);
    const released = cleared && await attempt('owner-release', steps.releaseLock);
    await attempt('sleep-prevention-stop', steps.stopCaffeinate);
    return { localOwnershipReleased: released };
}
