/** Fixture-only stand-in for systemd's bounded restart policy. This never installs a service. */
export function fixtureManagedPair({ dc, stopPair: stopAction, policy, delay, signal, onEvent = () => {}, restartDelayMs = 250 }) {
    let stopping = false, starts = 0, stoppingPair;
    let wakeStop;
    const stopped = new Promise(resolve => { wakeStop = resolve; });
    const stopPair = () => {
        if (!stoppingPair) stoppingPair = stopAction().finally(() => { stoppingPair = undefined; });
        return stoppingPair;
    };
    const completed = (async () => {
        while (!stopping && !signal.aborted) {
            starts++;
            onEvent('pair_start', { attempt: starts });
            try {
                // Execute the unit's exact foreground action. Compose owns group teardown.
                const result = await dc(policy.up, { allowFailure: true, timeout: 300000 });
                onEvent('pair_exit', { attempt: starts, code: result.code });
            } catch (error) {
                if (signal.aborted) return { reason: 'stopped', starts };
                throw error;
            } finally {
                // Like ExecStopPost, cleanup also runs when startup fails or the CLI is interrupted.
                await stopPair();
            }
            if (stopping || signal.aborted) return { reason: 'stopped', starts };
            // Fixtures run within a single 300s window; the actual limiter belongs to systemd.
            if (starts >= policy.maxStarts) {
                onEvent('pair_limit', { attempts: starts });
                return { reason: 'restart-limit', starts };
            }
            try { await Promise.race([delay(restartDelayMs), stopped]); }
            catch (error) { if (!signal.aborted) throw error; }
        }
        return { reason: 'stopped', starts };
    })();
    // The caller awaits completion for terminal evidence and again during cleanup.
    completed.catch(() => {});
    return {
        completed,
        get starts() { return starts; },
        async stop() {
            stopping = true; wakeStop();
            await stopPair();
            return completed;
        },
    };
}
