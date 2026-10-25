import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@/claude/sdk';
import { SDKToLogConverter } from './sdkToLogConverter';
import { mapClaudeLogMessageToSessionEnvelopes } from './sessionProtocolMapper';
import { RawJSONLinesSchema } from '../types';
import kimiTokenSpeed from './__fixtures__/kimi-token-speed.json';

function snapshot(apiDurationMs: unknown, withWindow = true, numTurns = 1, outputTokens = 1000,
    beforeResult?: (converter: SDKToLogConverter) => void) {
    const converter = new SDKToLogConverter({ cwd: process.cwd(), sessionId: 'speed-test', gitBranch: 'main' });
    converter.convert({
        type: 'assistant',
        message: {
            id: 'response', model: 'test-model', content: [{ type: 'text', text: 'Done' }],
            usage: { input_tokens: 1200, output_tokens: outputTokens },
        },
    } as unknown as SDKMessage);
    beforeResult?.(converter);
    return converter.convert({
        type: 'result', subtype: 'success', duration_ms: 80000, duration_api_ms: apiDurationMs, num_turns: numTurns,
        usage: { input_tokens: 1200, output_tokens: 1000 },
        modelUsage: withWindow ? { 'test-model': { contextWindow: 200000 } } : {},
    } as unknown as SDKMessage) as any;
}

describe('Claude output speed snapshot', () => {
    it.each(['result', 'reconnect'])('clears recorded Kimi samples on %s without losing the context window', (boundary) => {
        const converter = new SDKToLogConverter({ cwd: process.cwd(), sessionId: 'speed-test', gitBranch: 'main' });
        const clock = vi.spyOn(performance, 'now');
        try {
            for (const { at, event } of kimiTokenSpeed) {
                if (boundary === 'reconnect' && event.type === 'result') continue;
                clock.mockReturnValue(at);
                if (event.type === 'boundary') {
                    converter.observeTokenSpeedBoundary(event.subtype === 'PostToolBatch' ? 'tool-batch-complete' : 'interrupt');
                } else {
                    const output = converter.convert(event as unknown as SDKMessage) as any;
                    if (event.type === 'result') expect(output.usage.output_tokens_per_second).toBeCloseTo(29 / 3.383);
                }
            }
            if (boundary === 'reconnect') converter.convert({
                type: 'system', subtype: 'init', session_id: 'speed-test',
            } as SDKMessage);
            converter.convert({
                type: 'assistant', message: { id: 'next-reply', model: 'k3.1-pro', content: [{ type: 'text', text: 'Next' }],
                    usage: { input_tokens: 1200, output_tokens: 50 } },
            } as unknown as SDKMessage);
            const next = converter.convert({
                type: 'result', subtype: 'success', is_error: false, num_turns: 2,
                duration_api_ms: 10000, usage: { input_tokens: 2400, output_tokens: 100 },
                modelUsage: { 'k3.1-pro': { contextWindow: 1000000 } },
            } as unknown as SDKMessage) as any;
            expect(next.usage).toMatchObject({ input_tokens: 1200, output_tokens: 50, context_window: 1000000 });
            expect(next.usage).not.toHaveProperty('output_tokens_per_second');
        } finally {
            clock.mockRestore();
        }
    });

    it('uses the single request API duration rather than the total elapsed time', () => {
        const result = snapshot(20000);
        expect(result.usage).toMatchObject({
            input_tokens: 1200, output_tokens: 1000, context_window: 200000, output_tokens_per_second: 50,
            output_tokens_per_second_scope: 'model_request',
        });
    });

    it('reports speed even when the model context window is unknown', () => {
        const result = snapshot(20000, false);
        expect(result?.usage.output_tokens_per_second).toBe(50);
        const mapped = mapClaudeLogMessageToSessionEnvelopes(RawJSONLinesSchema.parse(result), { currentTurnId: null });
        expect(mapped.envelopes).toHaveLength(1);
        expect(mapped.envelopes[0].usage?.output_tokens_per_second).toBe(50);
        expect(mapped.envelopes[0].usage?.output_tokens_per_second_scope).toBe('model_request');
        expect(mapped.envelopes[0].ev).toEqual({ t: 'service', text: '' });
    });

    it('does not clear main-thread measurements when a subagent initializes', () => {
        const result = snapshot(20000, true, 1, 1000, converter => converter.convert({
            type: 'system', subtype: 'init', session_id: 'child-session', parent_tool_use_id: 'child-tool',
        } as unknown as SDKMessage));
        expect(result.usage.output_tokens_per_second).toBe(50);
    });

    it.each([undefined, 0, -1, NaN, Infinity, '20000'])('hides speed when API duration is unavailable or invalid: %s', (duration) => {
        expect(snapshot(duration)?.usage).not.toHaveProperty('output_tokens_per_second');
    });

    it.each([undefined, 0, 2])('does not mix multiple or unknown API request scopes: %s', (turns) => {
        expect(snapshot(20000, true, turns ?? 0)?.usage).not.toHaveProperty('output_tokens_per_second');
    });

    it('does not divide cumulative output by a single response duration', () => {
        expect(snapshot(20000, true, 1, 50)?.usage).not.toHaveProperty('output_tokens_per_second');
    });

    it.each(['api_retry', 'compact_boundary'])('does not fall back to API duration after %s', (subtype) => {
        const result = snapshot(20000, true, 1, 1000, converter => converter.convert({
            type: 'system', subtype,
        } as unknown as SDKMessage));
        expect(result?.usage).not.toHaveProperty('output_tokens_per_second');
    });

    it.each([null, 'parent-tool'])('hides additional main or sidechain response scopes (%s)', (parent) => {
        const result = snapshot(20000, true, 1, 1000, (converter) => converter.convert({
            type: 'assistant', parent_tool_use_id: parent,
            message: { id: 'other', model: 'test-model', content: [{ type: 'text', text: 'Other response' }],
                usage: { input_tokens: 1200, output_tokens: 1000 } },
        } as unknown as SDKMessage));
        expect(result?.usage).not.toHaveProperty('output_tokens_per_second');
    });
});
