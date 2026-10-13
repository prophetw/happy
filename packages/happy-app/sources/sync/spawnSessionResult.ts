/**
 * Spawn-session RPC result shapes, and the one place a machine's raw answer
 * is normalized into them.
 *
 * Kept free of sync-engine imports on purpose: ops.ts sits on the socket and
 * storage stack, so its tests mock the whole module — while this
 * normalization is pure and must stay loadable without that machinery.
 */

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'pending'; clientRequestId: string; retryAfterMs: number }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

/**
 * The machine RPC answer, with its refusal always under `errorMessage`.
 *
 * Earlier Happy Agent daemons answered a refused catalog spawn with `message`
 * instead, which this read as an alert with nothing in it. Nothing here parses
 * the payload otherwise, so the one field the flow reads is settled here.
 */
export function normalizeSpawnSessionResult(result: unknown): SpawnSessionResult {
    if (typeof result !== 'object' || result === null) {
        return { type: 'error', errorMessage: 'The machine answered with something Happy could not read.' };
    }
    const answer = result as Record<string, unknown> & { type?: unknown };
    if (typeof answer.type !== 'string') {
        // The daemon's RpcHandlerManager answers any handler throw — the
        // webhook-timeout refusal included — as a bare `{ error }` envelope.
        // That is a refusal with a readable message, not an unreadable
        // answer: surfacing the message spares the user a "could not read"
        // alert about a failure that actually says what happened.
        if (typeof answer.error === 'string' && answer.error.length > 0) {
            return { type: 'error', errorMessage: answer.error };
        }
        return { type: 'error', errorMessage: 'The machine answered with something Happy could not read.' };
    }
    if (answer.type !== 'error') return answer as SpawnSessionResult;
    const errorMessage = [answer.errorMessage, answer.message].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
    );
    return { type: 'error', errorMessage: errorMessage ?? 'Failed to spawn session' };
}
