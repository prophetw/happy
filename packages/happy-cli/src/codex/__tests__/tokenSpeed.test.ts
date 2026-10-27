import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexTokenSpeedTracker } from '@/utils/tokenSpeed';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from '../utils/sessionProtocolMapper';
import recordedToolBeforeUsage from './fixtures/token-speed-tool-before-usage.json';
import recordedHiddenReasoning from './fixtures/token-speed-hidden-reasoning.json';

afterEach(() => vi.restoreAllMocks());

describe('Codex output speed envelopes', () => {
    it('replays a real text-only stream using reported output minus hidden reasoning without changing context usage', () => {
        const clock = vi.spyOn(performance, 'now');
        const state: CodexTurnState = { currentTurnId: null, tokenSpeedTracker: new CodexTokenSpeedTracker() };
        // Keep the captured request boundary, first/last content timestamps and
        // counts; intermediate chunks and private message text are omitted.
        const envelopes = recordedHiddenReasoning.flatMap(({ at, event }) => {
            clock.mockReturnValue(at);
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, state);
            state.currentTurnId = mapped.currentTurnId;
            return mapped.envelopes;
        });
        const usage = envelopes.filter(envelope => envelope.usage).at(-1)?.usage;
        expect(usage?.generation_tokens_per_second).toBeCloseTo(2341 / 22.691);
        expect(usage?.generation_tokens_per_second_sample).toEqual({ tokens: 2341, duration_ms: 22691, requests: 1 });
        expect(usage?.time_to_first_token_ms).toBe(28886);
        expect(usage?.output_tokens).toBe(3893);
        expect(usage?.input_tokens).toBe(182986);
    });

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
        expect(finalUsage?.output_tokens_per_second_sample)
            .toEqual({ tokens: 422, duration_ms: 12259, requests: 1 });
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
        expect(sample[0].usage?.output_tokens_per_second_sample)
            .toEqual({ tokens: 100, duration_ms: 2000, requests: 1 });

        send({ type: 'exec_command_begin', call_id: 'slow', command: ['sleep', '60'] }, 3000);
        send({ type: 'exec_command_end', call_id: 'slow', exit_code: 0 }, 63000);
        const final = send({ type: 'task_complete' }, 64000);
        expect(final.some((envelope) => envelope.ev.t === 'turn-end')).toBe(true);
        expect(final.at(-1)?.usage?.output_tokens_per_second).toBe(50);
        expect(final.at(-1)?.usage?.output_tokens_per_second_scope).toBe('model_request');
        expect(final.at(-1)?.turn).toBeUndefined();
    });
});
