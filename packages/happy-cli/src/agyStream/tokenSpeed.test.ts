import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamJsonParser } from './streamJson';
import { AgyTokenSpeedTracker } from './tokenSpeed';
import recordedGemini from './__fixtures__/generation-gemini.json';

afterEach(() => vi.restoreAllMocks());

function streamTracker() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const tracker = new AgyTokenSpeedTracker();
  const parser = new StreamJsonParser({
    onStepUpdate: event => tracker.observeStep(event.step_update),
    onMessage: (message) => {
      if (message.type === 'token-count') tracker.update(message);
    },
  });
  const feed = (event: unknown) => parser.feed(JSON.stringify(event) + '\n');
  return {
    tracker,
    feed,
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

describe('AgyTokenSpeedTracker content generation', () => {
  it('replays captured native Gemini body timing with its real output/thinking breakdown', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    for (const { at, step } of recordedGemini) {
      setTime(at);
      feed({ event: 'step_update', step_update: step });
    }
    tracker.finishTurn();
    const duration = recordedGemini[1].at - recordedGemini[0].at;
    expect(tracker.generationUsage).toEqual({
      generation_tokens_per_second: 531 / duration * 1000,
      generation_tokens_per_second_sample: { tokens: 531, duration_ms: duration, requests: 1 },
      time_to_first_token_ms: recordedGemini[0].at,
    });
  });

  const response = (index: number, state: string, text: string, usage?: Record<string, number>) => ({
    event: 'step_update', step_update: { step_index: index, state, step_type: 'agent_response', text_delta: text,
      ...(usage ? { usage, duration_seconds: 10 } : {}) },
  });

  it('records the final chunk before its usage and subtracts separately reported thinking tokens', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    setTime(8000);
    feed(response(1, 'ACTIVE', 'First '));
    setTime(10000);
    feed(response(1, 'DONE', 'last', { input_tokens: 500, output_tokens: 120, thinking_tokens: 20 }));
    expect(tracker.generationUsage).toEqual({
      generation_tokens_per_second: 50,
      generation_tokens_per_second_sample: { tokens: 100, duration_ms: 2000, requests: 1 },
      time_to_first_token_ms: 8000,
    });
    expect(tracker.tokensPerSecond).toBe(12);
  });

  it('deduplicates completed snapshots, weights later responses, and ignores cumulative results', () => {
    const { tracker, feed, setTime, result } = streamTracker();
    tracker.startTurn();
    setTime(8000); feed(response(1, 'ACTIVE', 'First'));
    setTime(10000); feed(response(1, 'DONE', 'last', { output_tokens: 120, thinking_tokens: 20 }));
    setTime(11000); feed(response(1, 'DONE', '', { output_tokens: 120, thinking_tokens: 20 }));
    feed(response(1, 'DONE', ''));
    setTime(12000); feed(response(2, 'ACTIVE', 'Second'));
    setTime(14000); feed(response(2, 'DONE', 'last', { output_tokens: 230, thinking_tokens: 30 }));
    result(50000);
    tracker.finishTurn();
    expect(tracker.generationUsage).toEqual({
      generation_tokens_per_second: 75,
      generation_tokens_per_second_sample: { tokens: 300, duration_ms: 4000, requests: 2 },
      time_to_first_token_ms: 5000,
    });
  });

  it.each([0, 60000])('excludes %i ms of parallel tool execution from both metrics', extra => {
    const { tracker, feed, setTime } = streamTracker();
    const tool = (index: number, state: string) => feed({ event: 'step_update', step_update: { step_index: index, step_type: 'tool', state } });
    tracker.startTurn();
    setTime(1000); tool(1, 'ACTIVE'); tool(2, 'ACTIVE');
    setTime(1500); tool(1, 'DONE');
    setTime(2000 + extra); tool(2, 'DONE');
    setTime(2500 + extra); tool(2, 'DONE');
    setTime(10000 + extra); feed(response(3, 'ACTIVE', 'First'));
    setTime(12000 + extra); feed(response(3, 'DONE', 'last', { output_tokens: 120, thinking_tokens: 20 }));
    expect(tracker.generationUsage).toMatchObject({ generation_tokens_per_second: 50, time_to_first_token_ms: 8000 });
  });

  it('reports wait independently when output usage is unavailable or arrives in a single chunk', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    setTime(8000); feed(response(1, 'ACTIVE', 'First'));
    setTime(10000); feed(response(1, 'DONE', 'last'));
    expect(tracker.generationUsage).toEqual({ time_to_first_token_ms: 8000 });
    tracker.startTurn();
    setTime(18000); feed(response(2, 'DONE', 'One chunk', { output_tokens: 20, thinking_tokens: 0 }));
    expect(tracker.generationUsage).toEqual({ time_to_first_token_ms: 8000 });
  });

  it('invalidates an interrupted stream, preserves completed samples, and resets between turns', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    setTime(1000); feed(response(1, 'ACTIVE', 'First'));
    setTime(3000); feed(response(1, 'DONE', 'last', { output_tokens: 100, thinking_tokens: 0 }));
    setTime(4000); feed(response(2, 'ACTIVE', 'Interrupted'));
    tracker.interrupt();
    setTime(64000); feed(response(2, 'DONE', 'after wait', { output_tokens: 999 }));
    expect(tracker.generationUsage).toMatchObject({
      generation_tokens_per_second: 50,
      generation_tokens_per_second_sample: { tokens: 100, duration_ms: 2000, requests: 1 },
    });
    tracker.startTurn();
    expect(tracker.generationUsage).toEqual({});
    tracker.reset();
    expect(tracker.generationUsage).toEqual({});
  });

  it('recovers after a paired tool boundary even if an interrupted response never closes', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    setTime(1000); feed(response(1, 'ACTIVE', 'Interrupted'));
    tracker.interrupt();
    setTime(2000); feed({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE' } });
    setTime(62000); feed({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE' } });
    setTime(70000); feed(response(3, 'ACTIVE', 'First'));
    setTime(72000); feed(response(3, 'DONE', 'last', { output_tokens: 100, thinking_tokens: 0 }));
    expect(tracker.generationUsage).toMatchObject({ generation_tokens_per_second: 50, time_to_first_token_ms: 8000 });
  });

  it('keeps content speed without guessing a request start after unknown tool activity', () => {
    const { tracker, feed, setTime } = streamTracker();
    tracker.startTurn();
    setTime(1000); feed({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'WAITING' } });
    setTime(8000); feed(response(2, 'ACTIVE', 'First'));
    setTime(10000); feed(response(2, 'DONE', 'last', { output_tokens: 100, thinking_tokens: 0 }));
    expect(tracker.generationUsage).toEqual({
      generation_tokens_per_second: 50,
      generation_tokens_per_second_sample: { tokens: 100, duration_ms: 2000, requests: 1 },
    });
  });

  it('excludes a tool retry that reopens an already completed step', () => {
    const { tracker, feed, setTime } = streamTracker();
    const tool = (state: string) => feed({ event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state } });
    tracker.startTurn();
    setTime(1000); tool('ACTIVE');
    setTime(2000); tool('DONE');
    setTime(3000); tool('ACTIVE');
    setTime(63000); tool('DONE');
    setTime(71000); feed(response(2, 'ACTIVE', 'First'));
    setTime(73000); feed(response(2, 'DONE', 'last', { output_tokens: 100, thinking_tokens: 0 }));
    expect(tracker.generationUsage).toMatchObject({ generation_tokens_per_second: 50, time_to_first_token_ms: 8000 });
  });
});
