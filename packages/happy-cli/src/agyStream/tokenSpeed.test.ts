import { describe, expect, it } from 'vitest';
import { StreamJsonParser } from './streamJson';
import { AgyTokenSpeedTracker } from './tokenSpeed';

function streamTracker() {
  let now = 0;
  const tracker = new AgyTokenSpeedTracker(() => now);
  const parser = new StreamJsonParser({
    onMessage: (message) => {
      if (message.type === 'token-count') tracker.update(message);
    },
  });
  const feed = (event: unknown) => parser.feed(JSON.stringify(event) + '\n');
  return {
    tracker,
    setTime: (time: number) => { now = time; },
    step: (index: number, output: number, state = 'DONE') => feed({
      event: 'step_update',
      step_update: { step_index: index, state, step_type: 'agent_response', usage: { output_tokens: output } },
    }),
    result: (output: number, duration = 2000) => feed({
      event: 'result',
      result: { status: 'SUCCESS', duration_seconds: duration, usage: { output_tokens: output } },
    }),
  };
}

describe('AgyTokenSpeedTracker', () => {
  it('uses local turn time even when cumulative duration looks realistic', () => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(100, 2);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);

    tracker.startTurn();
    setTime(4000);
    step(2, 100);
    result(200, 4);
    result(200, 4);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it('excludes idle time and conversation age from subsequent turns', () => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(100);
    tracker.finishTurn();

    setTime(100000);
    tracker.startTurn();
    setTime(108000);
    step(2, 424);
    setTime(139000);
    step(3, 3035);
    result(3559, 2067.26);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeCloseTo(3459 / 39);
  });

  it('reconstructs a resumed turn from unique step snapshots, including updated counts', () => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(11, 20, 'ACTIVE');
    step(11, 20, 'ACTIVE');
    step(11, 40);
    step(11, 40);
    step(12, 60);
    result(1100);
    result(1100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);

    setTime(10000);
    tracker.startTurn();
    setTime(12000);
    result(1150);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(25);
  });

  it('hides an unknown resume baseline and uses that result as the next baseline', () => {
    const { tracker, setTime, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    result(1100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();

    tracker.startTurn();
    setTime(4000);
    result(1200);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it.each([true, false])('invalidates the baseline after a missing result (next turn has steps: %s)', (hasSteps) => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(100);
    tracker.finishTurn();

    tracker.startTurn();
    setTime(4000);
    step(2, 50);
    step(2, 50);
    // A cancelled/crashed process can exit without a final result.
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(25);

    tracker.startTurn();
    setTime(6000);
    if (hasSteps) step(3, 100);
    result(250);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(hasSteps ? 50 : undefined);

    tracker.startTurn();
    setTime(8000);
    result(350);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it.each([0, 20])('hides a counter reset to %s and establishes a fresh baseline', (resetTotal) => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(100);
    tracker.finishTurn();

    tracker.startTurn();
    setTime(4000);
    step(2, resetTotal);
    result(resetTotal);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();

    tracker.startTurn();
    setTime(6000);
    result(resetTotal + 100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it('includes trailing work in local timing, freezes completion, and ignores late usage', () => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(100, 1);
    expect(tracker.tokensPerSecond).toBe(50);
    setTime(4000);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(25);
    setTime(10000);
    tracker.finishTurn();
    result(9999);
    expect(tracker.tokensPerSecond).toBe(25);
    tracker.startTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it.each([undefined, null, -1, NaN, Infinity, '100', 1.5, Number.MAX_SAFE_INTEGER + 1])('hides invalid counts (%s)', (output_tokens) => {
    let now = 0;
    const tracker = new AgyTokenSpeedTracker(() => now);
    tracker.startTurn();
    now = 2000;
    tracker.update({ agy_usage_scope: 'turn', output_tokens });
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('does not invent a duration when no local time has elapsed', () => {
    const tracker = new AgyTokenSpeedTracker(() => 0);
    tracker.startTurn();
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 });
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('ignores historical summaries and clears the cumulative baseline on reset', () => {
    const { tracker, setTime, step, result } = streamTracker();
    result(1000);
    tracker.startTurn();
    setTime(2000);
    step(1, 100);
    result(1100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
    tracker.reset();
    expect(tracker.tokensPerSecond).toBeUndefined();
    tracker.startTurn();
    setTime(4000);
    result(1200);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });
});
