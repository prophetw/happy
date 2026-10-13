import { describe, expect, it } from 'vitest';
import { normalizeSpawnSessionResult } from './spawnSessionResult';

const UNREADABLE = { type: 'error', errorMessage: 'The machine answered with something Happy could not read.' };

describe('normalizeSpawnSessionResult', () => {
    it('passes a success answer through', () => {
        expect(normalizeSpawnSessionResult({ type: 'success', sessionId: 's-1' }))
            .toEqual({ type: 'success', sessionId: 's-1' });
    });

    it('passes a pending answer through', () => {
        expect(normalizeSpawnSessionResult({ type: 'pending', clientRequestId: 'c-1', retryAfterMs: 500 }))
            .toEqual({ type: 'pending', clientRequestId: 'c-1', retryAfterMs: 500 });
    });

    it('keeps the refusal message of a typed error answer', () => {
        expect(normalizeSpawnSessionResult({ type: 'error', errorMessage: 'Directory is required' }))
            .toEqual({ type: 'error', errorMessage: 'Directory is required' });
    });

    it('reads the legacy `message` field on a typed error answer', () => {
        expect(normalizeSpawnSessionResult({ type: 'error', message: 'Refused' }))
            .toEqual({ type: 'error', errorMessage: 'Refused' });
    });

    // The daemon's RpcHandlerManager wraps any spawn-handler throw — the
    // webhook-timeout refusal included — in a bare `{ error }` envelope.
    // Before this was understood, the app told the user the machine answered
    // with something unreadable while the session was still starting.
    it('reads a bare `{ error }` envelope as a refusal with that message', () => {
        expect(normalizeSpawnSessionResult({ error: 'Session webhook timeout for PID 3732986' }))
            .toEqual({ type: 'error', errorMessage: 'Session webhook timeout for PID 3732986' });
    });

    it('still reports genuinely unreadable answers as such', () => {
        expect(normalizeSpawnSessionResult(null)).toEqual(UNREADABLE);
        expect(normalizeSpawnSessionResult(undefined)).toEqual(UNREADABLE);
        expect(normalizeSpawnSessionResult('success')).toEqual(UNREADABLE);
        expect(normalizeSpawnSessionResult({})).toEqual(UNREADABLE);
        expect(normalizeSpawnSessionResult({ error: '' })).toEqual(UNREADABLE);
    });

    it('falls back to a generic message when a typed error carries none', () => {
        expect(normalizeSpawnSessionResult({ type: 'error' }))
            .toEqual({ type: 'error', errorMessage: 'Failed to spawn session' });
    });
});
