import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@/claude/sdk';
import { SDKToLogConverter } from './sdkToLogConverter';
import { mapClaudeLogMessageToSessionEnvelopes } from './sessionProtocolMapper';
import { RawJSONLinesSchema } from '../types';

function snapshot(durationMs: number, withWindow = true) {
    const converter = new SDKToLogConverter({ cwd: process.cwd(), sessionId: 'speed-test', gitBranch: 'main' });
    converter.convert({
        type: 'assistant',
        message: {
            id: 'response', model: 'test-model', content: [{ type: 'text', text: 'Done' }],
            usage: { input_tokens: 1200, output_tokens: 50 },
        },
    } as unknown as SDKMessage);
    return converter.convert({
        type: 'result', subtype: 'success', duration_ms: durationMs,
        usage: { input_tokens: 20000, output_tokens: 1000 },
        modelUsage: withWindow ? { 'test-model': { contextWindow: 200000 } } : {},
    } as unknown as SDKMessage) as any;
}

describe('Claude output speed snapshot', () => {
    it('matches cumulative output with its reported duration without replacing context counts', () => {
        const result = snapshot(20000);
        expect(result.usage).toMatchObject({
            input_tokens: 1200, output_tokens: 50, context_window: 200000, output_tokens_per_second: 50,
        });
    });

    it('reports speed even when the model context window is unknown', () => {
        const result = snapshot(20000, false);
        expect(result?.usage.output_tokens_per_second).toBe(50);
        const mapped = mapClaudeLogMessageToSessionEnvelopes(RawJSONLinesSchema.parse(result), { currentTurnId: null });
        expect(mapped.envelopes).toHaveLength(1);
        expect(mapped.envelopes[0].usage?.output_tokens_per_second).toBe(50);
        expect(mapped.envelopes[0].ev).toEqual({ t: 'service', text: '' });
    });

    it('keeps context usage without a speed when duration is invalid', () => {
        expect(snapshot(0)?.usage).not.toHaveProperty('output_tokens_per_second');
    });
});
