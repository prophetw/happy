import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamJsonParser } from './streamJson';
import { AgyTokenSpeedTracker } from './tokenSpeed';

afterEach(() => vi.restoreAllMocks());

function streamTracker() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const tracker = new AgyTokenSpeedTracker();
  const parser = new StreamJsonParser({
    onMessage: (message) => {
      if (message.type === 'token-count') tracker.update(message);
    },
  });
  const feed = (event: unknown) => parser.feed(JSON.stringify(event) + '\n');
  return {
    tracker,
    setTime: (time: number) => { now = time; },
    step: (index: number, output: number, duration?: unknown, state = 'DONE', type = 'agent_response') => feed({
      event: 'step_update',
      step_update: { step_index: index, state, step_type: type, duration_seconds: duration, usage: { output_tokens: output } },
    }),
    result: (output: number) => feed({
      event: 'result', result: { status: 'SUCCESS', duration_seconds: 2000, usage: { output_tokens: output } },
    }),
  };
}

describe('AgyTokenSpeedTracker request samples', () => {
  it('measures a completed response step and ignores a minute of tool work', () => {
    const { tracker, setTime, step, result } = streamTracker();
    tracker.startTurn();
    setTime(20000);
    step(1, 1000, 20);
    expect(tracker.tokensPerSecond).toBe(50);
    setTime(80000);
    step(2, 1000, 60, 'DONE', 'tool');
    result(50000);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
  });

  it('weights only measured response steps and deduplicates repeated step snapshots', () => {
    const { tracker, step, result } = streamTracker();
    tracker.startTurn();
    step(1, 100, 2);
    step(1, 100, 2);
    step(2, 900);
    step(3, 600, 3);
    step(4, 10000, 10, 'DONE', 'reasoning');
    result(12000);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(140);
  });

  it('accepts only complete response steps and uses their latest snapshot', () => {
    const { tracker, step } = streamTracker();
    tracker.startTurn();
    step(1, 20, 1, 'ACTIVE');
    expect(tracker.tokensPerSecond).toBeUndefined();
    step(1, 100, 2);
    expect(tracker.tokensPerSecond).toBe(50);
    step(1, 120, 2);
    expect(tracker.tokensPerSecond).toBe(60);
    tracker.finishTurn();
    step(1, 9999, 2);
    expect(tracker.tokensPerSecond).toBe(60);
  });

  it.each([undefined, null, 0, -1, '2'])('hides missing or invalid step duration: %s', (duration) => {
    const { tracker, step, result } = streamTracker();
    tracker.startTurn();
    step(1, 100, duration);
    result(100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('removes a sample when its replacement snapshot has invalid timing', () => {
    const { tracker, step } = streamTracker();
    tracker.startTurn();
    step(1, 100, 2);
    expect(tracker.tokensPerSecond).toBe(50);
    step(1, 100, 0);
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('does not use a session or SDK turn duration as a model request duration', () => {
    const { tracker, setTime, result } = streamTracker();
    tracker.startTurn();
    setTime(2000);
    result(1000);
    tracker.update({ agy_usage_scope: 'turn', output_tokens: 100, duration_seconds: 2 });
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });

  it('starts fresh for resumed turns and resets without cumulative baselines', () => {
    const { tracker, step, result } = streamTracker();
    result(5000);
    tracker.startTurn();
    step(10, 100, 2);
    result(5100);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(50);
    tracker.startTurn();
    expect(tracker.tokensPerSecond).toBeUndefined();
    step(11, 80, 2);
    tracker.finishTurn();
    expect(tracker.tokensPerSecond).toBe(40);
    tracker.reset();
    expect(tracker.tokensPerSecond).toBeUndefined();
  });
});
