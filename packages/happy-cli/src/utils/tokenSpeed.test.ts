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
    it('separates content generation from first-token wait and usage delivery, then weights later responses', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message_delta', delta: '' }, 1000);
        tracker.observe({ type: 'agent_reasoning_delta', delta: 'Thinking' }, 8000);
        tracker.observe({ type: 'agent_message_delta', delta: 'Done' }, 10000);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 10010);
        tracker.observe(usage(100), 11000);
        expect(tracker.generationUsage).toEqual({
            generation_tokens_per_second: 50,
            generation_tokens_per_second_sample: { tokens: 100, duration_ms: 2000, requests: 1 },
            time_to_first_token_ms: 8000,
        });
        tracker.observe({ type: 'agent_message_delta', delta: 'Next' }, 12000);
        tracker.observe({ type: 'agent_message_delta', delta: 'Done' }, 14000);
        tracker.observe({ type: 'agent_message', message: 'Next done' }, 14010);
        tracker.observe(usage(300, 200), 15000);
        tracker.observe(usage(300, 200), 20000);
        expect(tracker.generationUsage).toEqual({
            generation_tokens_per_second: 75,
            generation_tokens_per_second_sample: { tokens: 300, duration_ms: 4000, requests: 2 },
            time_to_first_token_ms: 4500,
        });
    });

    it.each([0, 60000])('excludes %i ms of tool time from both generation metrics', (extra) => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'exec_command_begin', call_id: 'tool' }, 1000);
        tracker.observe(usage(10), 1100);
        tracker.observe({ type: 'exec_command_end', call_id: 'tool' }, 2000 + extra);
        tracker.observe({ type: 'token_speed_output_delta', kind: 'text' }, 10000 + extra);
        tracker.observe({ type: 'token_speed_output_delta', kind: 'text' }, 12000 + extra);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 12010 + extra);
        tracker.observe(usage(110, 100), 13000 + extra);
        expect(tracker.generationUsage).toMatchObject({ generation_tokens_per_second: 50, time_to_first_token_ms: 8000 });
    });

    it('reports wait alone for one chunk and never guesses generation from completed text', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', message: 'Unstreamed' }, 1000);
        tracker.observe(usage(10), 1100);
        expect(tracker.generationUsage).toEqual({});
        tracker.observe({ type: 'task_started' }, 2000);
        tracker.observe({ type: 'agent_message_delta', delta: 'One chunk' }, 3000);
        tracker.observe({ type: 'agent_message', message: 'One chunk' }, 3100);
        tracker.observe(usage(20, 10), 3200);
        expect(tracker.generationUsage).toEqual({ time_to_first_token_ms: 1000 });
    });

    it('keeps visible first-token wait but hides a rate when reasoning tokens were not streamed', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message_delta', delta: 'First' }, 8000);
        tracker.observe({ type: 'agent_message_delta', delta: 'Last' }, 10000);
        tracker.observe({ type: 'agent_message', message: 'First last' }, 10100);
        tracker.observe({ type: 'token_count', total: { outputTokens: 100 }, last: { outputTokens: 100, reasoningOutputTokens: 80 } }, 11000);
        expect(tracker.generationUsage).toEqual({ time_to_first_token_ms: 8000 });
    });

    it('samples the first uninterrupted model response without historical tokens', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 1000);
        tracker.observe({ type: 'agent_message', message: 'Working' }, 2500);
        expect(tracker.observe(usage(5100, 100), 3000)?.tokensPerSecond).toBe(50);
        expect(tracker.observe(usage(5300, 200), 7000)?.tokensPerSecond).toBe(50);
    });

    it('does not let repeated usage notifications lengthen a measured request', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 900);
        tracker.observe(usage(100), 1000);
        expect(tracker.observe(usage(100), 2000)?.tokensPerSecond).toBe(100);
    });

    it.each(['exec_command', 'mcp_tool_call', 'patch_apply', 'collab_agent', 'token_speed_tool'])
    ('recovers after %s runs before usage and excludes its minute of execution', (tool) => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: `${tool}_begin`, call_id: 'slow' }, 1000);
        expect(tracker.observe(usage(100), 2000)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: `${tool}_end`, call_id: 'slow' }, 61000);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 62000);
        expect(tracker.observe(usage(200, 100), 63000)?.tokensPerSecond).toBe(50);
    });

    it('waits for every parallel tool and ignores duplicate usage at the recovery boundary', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'exec_command_begin', call_id: 'one' }, 1000);
        tracker.observe({ type: 'exec_command_begin', call_id: 'two' }, 1000);
        tracker.observe(usage(100), 2000);
        tracker.observe({ type: 'exec_command_end', call_id: 'one' }, 3000);
        tracker.observe({ type: 'exec_command_end', call_id: 'two' }, 61000);
        tracker.observe(usage(100), 61500);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 62000);
        expect(tracker.observe(usage(200, 100), 63000)?.tokensPerSecond).toBe(50);
    });

    it('does not guess a start when a new tool begins after the usage checkpoint', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'exec_command_begin', call_id: 'one' }, 1000);
        tracker.observe(usage(100), 2000);
        tracker.observe({ type: 'exec_command_begin', call_id: 'two' }, 3000);
        tracker.observe({ type: 'exec_command_end', call_id: 'two' }, 4000);
        tracker.observe({ type: 'exec_command_end', call_id: 'one' }, 61000);
        tracker.observe({ type: 'agent_message', message: 'Ambiguous request' }, 62000);
        expect(tracker.observe(usage(200, 100), 63000)?.tokensPerSecond).toBeUndefined();
    });

    it.each(['exec_approval_request', 'request_user_input', 'context_compacted', 'stream_error', 'unknown_future_event'])
    ('does not resume across %s even after a tool checkpoint', (type) => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'exec_command_begin', call_id: 'slow' }, 1000);
        tracker.observe(usage(100), 2000);
        tracker.observe({ type }, 3000);
        tracker.observe({ type: 'exec_command_end', call_id: 'slow' }, 61000);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 62000);
        expect(tracker.observe(usage(200, 100), 63000)?.tokensPerSecond).toBeUndefined();
    });

    it('keeps the sampled speed when a tool takes another minute and usage arrives late', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 1000);
        tracker.observe({ type: 'agent_message', message: 'Running a command' }, 10000);
        expect(tracker.observe(usage(1000), 21000)?.tokensPerSecond).toBe(50);
        tracker.observe({ type: 'exec_command_begin', call_id: 'slow' }, 21000);
        tracker.observe({ type: 'exec_command_end', call_id: 'slow' }, 81000);
        expect(tracker.observe({ type: 'task_complete' }, 81000)?.tokensPerSecond).toBe(50);
        expect(tracker.observe(usage(1200, 200), 90000)?.tokensPerSecond).toBe(50);
    });

    it('resets the sample for the next turn and uses its own request duration', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', message: 'First' }, 900);
        tracker.observe(usage(100), 1000);
        tracker.observe({ type: 'task_complete' }, 2000);
        tracker.observe({ type: 'task_started' }, 10000);
        tracker.observe({ type: 'agent_message', message: 'Second' }, 12000);
        expect(tracker.observe(usage(400, 300), 13000)?.tokensPerSecond).toBe(100);
    });

    it.each(['exec_command_begin', 'mcp_tool_call_begin', 'patch_apply_begin', 'collab_agent_begin',
        'exec_approval_request', 'request_user_input', 'context_compacted', 'stream_error', 'unknown_future_event'])
    ('skips a request when %s interrupts its timing before usage', (type) => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', message: 'Working' }, 1000);
        tracker.observe({ type }, 2000);
        expect(tracker.observe(usage(100), 62000)?.tokensPerSecond).toBeUndefined();
        expect(tracker.observe({ type: 'task_complete' }, 63000)?.tokensPerSecond).toBeUndefined();
    });

    it('treats a pre-output usage snapshot as history rather than a completed response', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        expect(tracker.observe(usage(5000, 100), 100)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: 'agent_message', message: 'Fresh output' }, 1500);
        expect(tracker.observe(usage(5100, 100), 2000)?.tokensPerSecond).toBe(50);
    });

    it('hides a missing request boundary, multiple unobserved requests, and counter resets', () => {
        const tracker = new CodexTokenSpeedTracker();
        expect(tracker.observe(usage(100), 1000)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: 'task_started' }, 2000);
        tracker.observe({ type: 'agent_message', message: 'Reset' }, 2500);
        expect(tracker.observe(usage(50), 3000)?.tokensPerSecond).toBeUndefined();
        expect(tracker.observe(usage(100), 4000)?.tokensPerSecond).toBeUndefined();
        tracker.observe({ type: 'task_started' }, 5000);
        tracker.observe({ type: 'agent_message', message: 'Recovered' }, 5500);
        expect(tracker.observe(usage(200, 100), 6000)?.tokensPerSecond).toBe(100);

        const unknown = new CodexTokenSpeedTracker();
        unknown.observe({ type: 'task_started' }, 0);
        unknown.observe({ type: 'agent_message', message: 'Unknown counts' }, 500);
        expect(unknown.observe({ type: 'token_count', total: { outputTokens: 100 } }, 1000)?.tokensPerSecond).toBeUndefined();
        expect(unknown.observe(usage(200, 100), 2000)?.tokensPerSecond).toBeUndefined();

        const missed = new CodexTokenSpeedTracker();
        missed.observe(usage(1000), 0);
        missed.observe({ type: 'task_started' }, 1000);
        missed.observe({ type: 'agent_message', message: 'Two requests' }, 2000);
        expect(missed.observe(usage(1300, 100), 3000)?.tokensPerSecond).toBeUndefined();
    });

    it('does not create a sample from usage received after the turn has ended', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', message: 'Done' }, 1000);
        tracker.observe({ type: 'task_complete' }, 2000);
        expect(tracker.observe(usage(100), 10000)?.tokensPerSecond).toBeUndefined();
    });

    it('skips multiple completed responses before the first usage instead of guessing their scope', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        tracker.observe({ type: 'agent_message', item_id: 'one', message: 'First' }, 1000);
        tracker.observe({ type: 'agent_message', item_id: 'two', message: 'Second' }, 2000);
        expect(tracker.observe(usage(5300, 200), 3000)?.tokensPerSecond).toBeUndefined();
    });

    it('ignores missing cumulative output counts rather than adding per-response counts', () => {
        const tracker = new CodexTokenSpeedTracker();
        tracker.observe({ type: 'task_started' }, 0);
        expect(tracker.observe({ type: 'token_count', last: { outputTokens: 100 } }, 1000)).toBeUndefined();
        expect(tracker.observe({ type: 'turn_aborted' }, 2000)).toBeUndefined();
    });
});
