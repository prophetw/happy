import { describe, expect, it } from 'vitest';
import { CodexTokenSpeedTracker, outputTokensPerSecond } from './tokenSpeed';

const usage = (total: number, last = total) => ({
    type: 'token_count',
    total: { outputTokens: total },
    last: { outputTokens: last },
});

describe('outputTokensPerSecond', () => {
    it('converts milliseconds to seconds', () => {
        expect(outputTokensPerSecond(1000, 20000)).toBe(50);
    });

    it.each([undefined, null, 0, -1, NaN, Infinity, '100'])('ignores invalid output or duration: %s', (value) => {
        expect(outputTokensPerSecond(value, 1000)).toBeUndefined();
        expect(outputTokensPerSecond(1000, value)).toBeUndefined();
    });
});

describe('CodexTokenSpeedTracker', () => {
    it('excludes historical tokens when the first sample comes from a resumed thread', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 1000);
        expect(tracker.observe(usage(5100, 100), 3000)?.tokensPerSecond).toBe(50);
        expect(tracker.observe(usage(5300, 200), 7000)?.tokensPerSecond).toBe(50);
    });

    it('does not count repeated cumulative notifications twice', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe(usage(100), 1000);
        expect(tracker.observe(usage(100), 2000)?.tokensPerSecond).toBe(50);
    });

    it('includes trailing tool time, freezes on completion, and accepts late usage', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 1000);
        tracker.observe(usage(100), 2000);
        expect(tracker.observe({ type: 'task_complete' }, 5000)?.tokensPerSecond).toBe(25);
        expect(tracker.observe(usage(200), 9000)?.tokensPerSecond).toBe(50);
        expect(tracker.observe({ type: 'task_complete' }, 10000)?.tokensPerSecond).toBe(50);
    });

    it('uses the previous total as the next turn baseline', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe(usage(100), 1000);
        tracker.observe({ type: 'task_complete' }, 2000);
        tracker.observe({ type: 'task_started' }, 10000);
        expect(tracker.observe(usage(400, 300), 13000)?.tokensPerSecond).toBe(100);
    });

    it('hides unknown timing, unknown baselines, and counter resets', () => {
        const tracker = new CodexTokenSpeedTracker();
        expect(tracker.observe(usage(100), 1000)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: 'task_started' }, 2000);
        expect(tracker.observe(usage(50), 3000)?.tokensPerSecond).toBeUndefined();
        expect(tracker.observe(usage(100), 4000)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: 'task_started' }, 5000);
        expect(tracker.observe(usage(200), 6000)?.tokensPerSecond).toBe(100);

        const unknown = new CodexTokenSpeedTracker();
        unknown.observe({ type: 'task_started' }, 0);
        expect(unknown.observe({ type: 'token_count', total: { outputTokens: 100 } }, 1000)?.tokensPerSecond).toBeUndefined();
        expect(unknown.observe(usage(200, 100), 2000)?.tokensPerSecond).toBeUndefined();
    });

    it('ignores missing cumulative output counts rather than adding per-response counts', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        expect(tracker.observe({ type: 'token_count', last: { outputTokens: 100 } }, 1000)).toBeUndefined();
        expect(tracker.observe({ type: 'turn_aborted' }, 2000)).toBeUndefined();
    });
});
