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

  it('correctly calculates per-turn token speed across multi-turn sessions with cumulative counts', () => {
    let now = 1000;
    const tracker = new AgyTokenSpeedTracker(() => now);

    // Turn 1: 100 tokens produced in 2s
    tracker.startTurn();
    now = 3000;
    tracker.update({ output_tokens: 100 });
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 });
    expect(tracker.tokensPerSecond).toBe(50); // 100 / 2
    tracker.finishTurn();

    // User pauses for 30s before Turn 2
    now = 33000;

    // Turn 2: produces 150 tokens in 3s (cumulative total 250)
    tracker.startTurn();
    now = 36000;
    tracker.update({ output_tokens: 150 });
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 250, duration_seconds: 3 });
    expect(tracker.tokensPerSecond).toBe(50); // (250 - 100) / 3 = 150 / 3 = 50, NOT 250 / 3
    tracker.finishTurn();
  });

  it('rejects cumulative conversation uptime duration and falls back to turn elapsed time', () => {
    let now = 10000;
    const tracker = new AgyTokenSpeedTracker(() => now);

    // Session has been alive for 34.5 minutes (2067s).
    // The current turn took 39 seconds (10000ms -> 49000ms).
    // It produced 3459 tokens (delta between 15718 and baseline 12259).
    // Prior baseline is 12259.
    tracker.startTurn();
    now = 12000;
    tracker.update({ output_tokens: 12259 });
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 12259, duration_seconds: 2000 });
    tracker.finishTurn();

    // Now the active turn:
    now = 100000;
    tracker.startTurn();
    // Step 1: 424 tokens
    now = 108000;
    tracker.update({ output_tokens: 424 });
    // Step 2: 3035 tokens
    now = 139000; // elapsed = 39s
    tracker.update({ output_tokens: 3035 });

    // Result arrives with cumulative trajectory uptime (2067.26s) and total (15718)
    tracker.update({
      agy_usage_scope: 'turn',
      output_tokens: 15718,
      duration_seconds: 2067.26,
    });
    tracker.finishTurn();

    // Should use 39s turn elapsed time, NOT 2067s conversation age!
    // 3459 tokens / 39s ≈ 88.69 tok/s
    expect(tracker.tokensPerSecond).toBeCloseTo(3459 / 39, 1);
  });

  it('reconstructs baseline on resumed sessions using in-turn step outputs', () => {
    let now = 1000;
    const tracker = new AgyTokenSpeedTracker(() => now);

    // Resumed session without prior local baseline:
    tracker.startTurn();
    // Turn produces 4 tokens in step
    now = 2000;
    tracker.update({ output_tokens: 4 });
    // agy reports cumulative total 97 for the conversation
    now = 3000; // elapsed = 2s
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 97 });
    tracker.finishTurn();

    // 4 tokens / 2s = 2 tok/s, baseline established as 97 - 4 = 93
    expect(tracker.tokensPerSecond).toBe(2);

    // Next turn produces 10 tokens
    now = 10000;
    tracker.startTurn();
    now = 12000; // elapsed = 2s
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 107 });
    tracker.finishTurn();

    // (107 - 97) / 2 = 10 / 2 = 5 tok/s
    expect(tracker.tokensPerSecond).toBe(5);
  });
});
