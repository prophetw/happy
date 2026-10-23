import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTokenSpeedTracker } from '@/utils/tokenSpeed';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from '../utils/sessionProtocolMapper';

afterEach(() => vi.restoreAllMocks());

describe('Codex output speed envelopes', () => {
    it('carries speed through invisible usage envelopes and measures final tool time', () => {
        const clock = vi.spyOn(performance, 'now');
        const state: CodexTurnState = { currentTurnId: null, tokenSpeedTracker: new CodexTokenSpeedTracker() };
        const send = (message: Record<string, unknown>, time: number) => {
            clock.mockReturnValue(time);
            const result = mapCodexMcpMessageToSessionEnvelopes(message, state);
            state.currentTurnId = result.currentTurnId;
            return result.envelopes;
        };
        send({ type: 'task_started' }, 1000);
        const sample = send({
            type: 'token_count',
            total: { inputTokens: 1200, outputTokens: 5100 },
            last: { inputTokens: 1200, outputTokens: 100 },
        }, 3000);
        expect(sample).toHaveLength(1);
        expect(sample[0].turn).toBeUndefined();
        expect(sample[0].ev).toEqual({ t: 'service', text: '' });
        expect(sample[0].usage?.output_tokens_per_second).toBe(50);

        const final = send({ type: 'task_complete' }, 5000);
        expect(final.some((envelope) => envelope.ev.t === 'turn-end')).toBe(true);
        expect(final.at(-1)?.usage?.output_tokens_per_second).toBe(25);
        expect(final.at(-1)?.turn).toBeUndefined();
    });
});
