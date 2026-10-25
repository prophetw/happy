import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTokenSpeedTracker } from '@/utils/tokenSpeed';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from '../utils/sessionProtocolMapper';
import recordedToolBeforeUsage from './fixtures/token-speed-tool-before-usage.json';

afterEach(() => vi.restoreAllMocks());

describe('Codex output speed envelopes', () => {
    it.each([0, 60000])('recovers a captured tool-before-usage turn with %i ms of extra tool time', (extraToolTime) => {
        const clock = vi.spyOn(performance, 'now');
        const state: CodexTurnState = { currentTurnId: null, tokenSpeedTracker: new CodexTokenSpeedTracker() };
        const envelopes = recordedToolBeforeUsage.flatMap(({ at, event }) => {
            clock.mockReturnValue(at + (at >= 4862 ? extraToolTime : 0));
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, state);
            state.currentTurnId = mapped.currentTurnId;
            return mapped.envelopes;
        });
        const finalUsage = envelopes.filter((envelope) => envelope.usage).at(-1)?.usage;
        expect(finalUsage?.output_tokens_per_second).toBeCloseTo(422 / 12.259);
        expect(finalUsage?.output_tokens_per_second_scope).toBe('model_request');
        expect(envelopes.some((envelope) => envelope.ev.t === 'turn-end')).toBe(true);
    });

    it('carries a model request sample through invisible usage envelopes without adding tool time', () => {
        const clock = vi.spyOn(performance, 'now');
        const state: CodexTurnState = { currentTurnId: null, tokenSpeedTracker: new CodexTokenSpeedTracker() };
        const send = (message: Record<string, unknown>, time: number) => {
            clock.mockReturnValue(time);
            const result = mapCodexMcpMessageToSessionEnvelopes(message, state);
            state.currentTurnId = result.currentTurnId;
            return result.envelopes;
        };
        send({ type: 'task_started' }, 1000);
        send({ type: 'agent_message', message: 'Checking the project' }, 2000);
        const sample = send({
            type: 'token_count',
            total: { inputTokens: 1200, outputTokens: 5100 },
            last: { inputTokens: 1200, outputTokens: 100 },
        }, 3000);
        expect(sample).toHaveLength(1);
        expect(sample[0].turn).toBeUndefined();
        expect(sample[0].ev).toEqual({ t: 'service', text: '' });
        expect(sample[0].usage?.output_tokens_per_second).toBe(50);
        expect(sample[0].usage?.output_tokens_per_second_scope).toBe('model_request');

        send({ type: 'exec_command_begin', call_id: 'slow', command: ['sleep', '60'] }, 3000);
        send({ type: 'exec_command_end', call_id: 'slow', exit_code: 0 }, 63000);
        const final = send({ type: 'task_complete' }, 64000);
        expect(final.some((envelope) => envelope.ev.t === 'turn-end')).toBe(true);
        expect(final.at(-1)?.usage?.output_tokens_per_second).toBe(50);
        expect(final.at(-1)?.usage?.output_tokens_per_second_scope).toBe('model_request');
        expect(final.at(-1)?.turn).toBeUndefined();
    });
});
