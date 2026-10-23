import { describe, expect, it } from 'vitest';
import { AgyTokenSpeedTracker } from './tokenSpeed';

describe('AgyTokenSpeedTracker', () => {
  it('uses the provider turn duration and does not sum step or repeated summaries', () => {
    let now = 1000;
    const tracker = new AgyTokenSpeedTracker(() => now);
    tracker.startTurn();
    now = 11000;
    tracker.update({ output_tokens: 200 });
    expect(tracker.tokensPerSecond).toBeUndefined();
    const summary = { agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 };
    tracker.update(summary);
    tracker.update(summary);
    expect(tracker.tokensPerSecond).toBe(50);
    now += 1000;
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
    tracker.update({ ...summary, output_tokens: 9999 });
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it('uses monotonic full-turn elapsed time for SDK usage, then freezes it', () => {
    let now = 1000;
    const tracker = new AgyTokenSpeedTracker(() => now);
    tracker.startTurn();
    now = 3000;
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 100 });
    expect(tracker.tokensPerSecond).toBe(50);
    now = 5000;
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(25);
    now = 15000;
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(25);
    tracker.startTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it.each([undefined, 0, -1, NaN, Infinity, '100'])('hides invalid output counts (%s)', (output_tokens) => {
    const tracker = new AgyTokenSpeedTracker(() => 1000);
    tracker.startTurn();
    tracker.update({ agy_usage_scope: 'turn', output_tokens, duration_seconds: 2 });
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('ignores historical summaries and clears speed on reset', () => {
    const tracker = new AgyTokenSpeedTracker(() => 1000);
    const summary = { agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 };
    tracker.update(summary);
    expect(tracker.tokensPerSecond).toBeUndefined();
    tracker.startTurn();
    tracker.update(summary);
    expect(tracker.tokensPerSecond).toBe(50);
    tracker.reset();
    tracker.update(summary);
    expect(tracker.tokensPerSecond).toBeUndefined();
  });
});
