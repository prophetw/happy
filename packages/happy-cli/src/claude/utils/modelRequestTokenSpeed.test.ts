import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@/claude/sdk';
import { ClaudeModelRequestTokenSpeed } from './modelRequestTokenSpeed';

const stream = (event: Record<string, unknown>, parent: string | null = null) => ({
    type: 'stream_event', parent_tool_use_id: parent, event,
}) as unknown as SDKMessage;
const start = (id = 'response', model = 'k3.1-pro') => stream({
    type: 'message_start', message: { id, model, usage: { input_tokens: 1200, output_tokens: 0 } },
});
const delta = (output: unknown, stopReason: string | null = 'end_turn') => stream({
    type: 'message_delta', usage: { output_tokens: output }, delta: { stop_reason: stopReason },
});
const stop = () => stream({ type: 'message_stop' });

describe('ClaudeModelRequestTokenSpeed', () => {
    it('counts each timed request so a long turn can publish before its result', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start('one'), 2000);
        tracker.observe(delta(100), 2999);
        expect(tracker.completedSampleCount).toBe(0);
        tracker.observe(stop(), 3000);
        expect(tracker.completedSampleCount).toBe(1);
        expect(tracker.latestSample).toMatchObject({
            model: 'k3.1-pro',
            usage: { input_tokens: 1200, output_tokens: 100 },
        });
        expect(tracker.sampledTotals).toEqual({ tokens: 100, durationMs: 2000, requests: 1 });
        // A request without a boundary has no usable timing: its usage still
        // becomes the latest completed request but adds no speed sample.
        tracker.observe(start('untimed'), 4000);
        tracker.observe(delta(50), 4999);
        tracker.observe(stop(), 5000);
        expect(tracker.completedSampleCount).toBe(1);
        expect(tracker.latestSample?.usage.output_tokens).toBe(50);
        expect(tracker.tokensPerSecond).toBe(50);
    });

    it('includes time waiting for the first token after all tools complete', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 61000);
        tracker.observe(start(), 62000);
        tracker.observe(delta(100), 62999);
        tracker.observe(stop(), 63000);
        expect(tracker.tokensPerSecond).toBe(50);
        expect(tracker.usageForResponse('response')).toMatchObject({ input_tokens: 1200, output_tokens: 100 });
        expect(tracker.usageForResponse('another')).toBeUndefined();
    });

    it('weights complete request segments by tokens and duration without adding tools or user waiting', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start('one'), 2000);
        tracker.observe(delta(100), 2999);
        tracker.observe(stop(), 3000);
        tracker.boundary('interrupt', 4000);
        tracker.boundary('tool-batch-complete', 64000);
        tracker.observe(start('two'), 65000);
        tracker.observe(delta(300), 69999);
        tracker.observe(stop(), 70000);
        expect(tracker.tokensPerSecond).toBe(50);
    });

    it('does not reset the clock on a repeated batch callback or add repeated usage', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.boundary('tool-batch-complete', 1500);
        tracker.observe(start(), 2000);
        tracker.observe(delta(100), 2500);
        tracker.observe(delta(100), 2999);
        tracker.observe(stop(), 3000);
        expect(tracker.tokensPerSecond).toBe(50);
        tracker.boundary('tool-batch-complete', 10000);
        tracker.observe(start(), 11000);
        tracker.observe(delta(100), 11999);
        tracker.observe(stop(), 12000);
        expect(tracker.tokensPerSecond).toBe(50);
    });

    it('does not infer request start from first output or sample an incomplete response', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.observe(start(), 1000);
        tracker.observe(delta(100), 2000);
        tracker.observe(stop(), 3000);
        expect(tracker.tokensPerSecond).toBeUndefined();
        tracker.boundary('tool-batch-complete', 4000);
        tracker.observe(start('missing-final'), 5000);
        tracker.observe(delta(100, null), 6000);
        tracker.observe(stop(), 7000);
        expect(tracker.tokensPerSecond).toBeUndefined();
    });

    it('does not use a batch boundary while the previous model stream is still open', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.observe(start('previous'), 1000);
        tracker.boundary('tool-batch-complete', 2000);
        tracker.observe(delta(100), 2999);
        tracker.observe(stop(), 3000);
        tracker.observe(start('next'), 4000);
        tracker.observe(delta(100), 4999);
        tracker.observe(stop(), 5000);
        expect(tracker.tokensPerSecond).toBeUndefined();
    });

    it('skips a request with a permission wait and recovers after the next completed tool batch', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start('waiting'), 2000);
        tracker.boundary('interrupt', 3000);
        tracker.observe(delta(100), 63000);
        tracker.observe(stop(), 64000);
        expect(tracker.tokensPerSecond).toBeUndefined();
        tracker.boundary('tool-batch-complete', 65000);
        tracker.observe(start('recovered'), 66000);
        tracker.observe(delta(100), 66999);
        tracker.observe(stop(), 67000);
        expect(tracker.tokensPerSecond).toBe(50);
    });

    it.each(['api_retry', 'compact_boundary', 'model_refusal_fallback'])('skips a segment interrupted by %s', (subtype) => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start(), 2000);
        tracker.observe({ type: 'system', subtype } as SDKMessage, 3000);
        tracker.observe(delta(100), 3999);
        tracker.observe(stop(), 4000);
        expect(tracker.tokensPerSecond).toBeUndefined();
    });

    it.each([undefined, 0, -1, NaN, Infinity, 0.5, '100'])('rejects invalid final output counts (%s)', (output) => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start(), 2000);
        tracker.observe(delta(output), 2999);
        tracker.observe(stop(), 3000);
        expect(tracker.tokensPerSecond).toBeUndefined();
    });

    it('ignores child streams without consuming the main request boundary or mixing their model', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        for (const event of [start('child', 'child-model'), delta(9000), stop()]) {
            tracker.observe({ ...event, parent_tool_use_id: 'parent-tool' } as SDKMessage, 1500);
        }
        tracker.observe(start(), 2000);
        tracker.observe(delta(100), 2999);
        tracker.observe(stop(), 3000);
        expect(tracker.tokensPerSecond).toBe(50);
    });

    it('does not mix main-thread models or count an unfinished retry', () => {
        const tracker = new ClaudeModelRequestTokenSpeed();
        tracker.boundary('tool-batch-complete', 1000);
        tracker.observe(start('retry'), 2000);
        tracker.observe(start('new-attempt'), 3000);
        tracker.observe(delta(100), 3999);
        tracker.observe(stop(), 4000);
        expect(tracker.tokensPerSecond).toBeUndefined();
        tracker.boundary('tool-batch-complete', 5000);
        tracker.observe(start('model-switch', 'other-model'), 6000);
        tracker.observe(delta(100), 6999);
        tracker.observe(stop(), 7000);
        expect(tracker.tokensPerSecond).toBeUndefined();
    });
});
