export type CodexTurnOutcome = {
    status: 'completed' | 'failed' | 'cancelled';
    errorCode?: string;
};

/** Preserve provider error types without putting error messages in attention metadata. */
export function getCodexTurnOutcome(message: Record<string, unknown>): CodexTurnOutcome {
    const error = message.error;
    const reason = message.reason;
    if (message.status === 'failed' || (error !== undefined && error !== null)
        || (message.type === 'turn_aborted' && typeof reason === 'string' && /(fail|error)/i.test(reason))) {
        const info = error && typeof error === 'object' && 'codexErrorInfo' in error ? error.codexErrorInfo : undefined;
        const code = typeof info === 'string' ? info
            : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
        return { status: 'failed', errorCode: code && /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(code) ? code : 'unknown' };
    }
    if (message.type === 'turn_aborted' || ['cancelled', 'canceled', 'aborted', 'interrupted'].includes(String(message.status))) {
        return { status: 'cancelled' };
    }
    return { status: 'completed' };
}
