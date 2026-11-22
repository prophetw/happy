import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { createEnvelope } from '@slopus/happy-wire';
import { getTerminalToolResult } from '@/utils/toolResult';
import { mapClaudeLogMessageToSessionEnvelopes } from '../../../happy-cli/src/claude/utils/sessionProtocolMapper';
import { RawJSONLinesSchema } from '../../../happy-cli/src/claude/types';

function message(id: string, ev: Record<string, unknown>) {
    const normalized = normalizeRawMessage(id, null, 1, RawRecordSchema.parse({
        role: 'session',
        content: { id, time: 1, role: 'agent', turn: 'turn-1', ev },
    }));
    expect(normalized).not.toBeNull();
    return normalized!;
}

describe('Happy Agent tool wire → rendered message contract', () => {
    it('applies CodeBuddy argument and terminal snapshots to the original row, including late output', () => {
        const state = createReducer();
        const start = (call: string) => message(`start-${call}`, {
            t: 'tool-call-start', call, name: 'Bash', title: 'Bash', description: '', args: {},
        });
        const first = reducer(state, [start('a'), start('b')]).messages;
        const firstId = first.find(row => row.kind === 'tool-call' && row.tool.callId === 'a')?.id;
        expect(firstId).toBeTruthy();

        const update = (id: string, call: string, fields: Record<string, unknown>) => message(id, {
            t: 'tool-call-update', call, ...fields,
        });
        const end = (id: string, call: string, isError: boolean) => message(id, { t: 'tool-call-end', call, isError });
        const args = { command: "printf 'first\\n'\nprintf 'second\\n'", cwd: '/work' };
        const running = reducer(state, [update('args-a', 'a', { args, terminal: { stdout: 'first\n' } })]).messages;
        expect(running[0]).toMatchObject({ id: firstId, tool: { input: args, state: 'running', terminal: { stdout: 'first\n' } } });

        const late = update('late-a', 'a', { terminal: { stdout: 'first\nsecond\n', exitCode: 0 } });
        const results = reducer(state, [end('end-a', 'a', false), update('failed-b', 'b', {
            terminal: { stderr: 'second call failed', exitCode: 1 },
        }), end('end-b', 'b', true), late]).messages;
        expect(results).toHaveLength(2);
        expect(results.find(row => row.id === firstId)).toMatchObject({
            tool: { callId: 'a', input: args, state: 'completed', terminal: { stdout: 'first\nsecond\n', exitCode: 0 } },
        });
        expect(results.find(row => row.id !== firstId)).toMatchObject({
            tool: { callId: 'b', state: 'error', terminal: { stderr: 'second call failed', exitCode: 1 } },
        });
        expect(reducer(state, [late]).messages).toHaveLength(0);
    });

    it.each([
        ['hello\nworld\n', false, 'hello\nworld\n'],
        [[{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], false, 'first\nsecond'],
        ['permission denied', true, 'permission denied'],
        ['', false, ''],
    ] as const)('preserves Claude Bash output from the provider through the detail view parser: %j', (content, isError, output) => {
        const started = mapClaudeLogMessageToSessionEnvelopes(RawJSONLinesSchema.parse({
            type: 'assistant', uuid: 'claude-start',
            message: {
                content: [{ type: 'tool_use', id: 'claude-bash', name: 'Bash', input: { command: 'echo hello' } }],
            },
        }), { currentTurnId: null });
        const ended = mapClaudeLogMessageToSessionEnvelopes(RawJSONLinesSchema.parse({
            type: 'user', uuid: 'claude-end',
            message: {
                content: [{ type: 'tool_result', tool_use_id: 'claude-bash', content, is_error: isError }],
            },
        }), { currentTurnId: started.currentTurnId });
        const messages = [...started.envelopes, ...ended.envelopes].map(envelope => {
            return normalizeRawMessage(envelope.id, null, envelope.time, RawRecordSchema.parse({
                role: 'session', content: envelope,
            }));
        }).filter(normalized => normalized !== null);
        const result = reducer(createReducer(), messages);
        const tool = result.messages.find(m => m.kind === 'tool-call');
        expect(tool?.kind).toBe('tool-call');
        if (tool?.kind !== 'tool-call') throw new Error('Missing Claude Bash tool call');
        expect(tool.tool).toMatchObject({
            name: 'Bash', callId: 'claude-bash', input: { command: 'echo hello' },
            state: isError ? 'error' : 'completed', result: output,
        });
        expect(getTerminalToolResult(tool.tool)).toEqual({
            stdout: isError ? null : output,
            stderr: null,
            error: isError ? output : null,
        });
    });

    it('preserves a wire title when a legacy tool update omits it', () => {
        const state = createReducer();
        reducer(state, [message('start', {
            t: 'tool-call-start', call: 'call-1', name: 'CodexBash', title: 'Terminal',
            description: 'Running CodexBash', args: { command: 'echo hello' },
        })]);
        const legacy = normalizeRawMessage('legacy-update', null, 2, RawRecordSchema.parse({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant', uuid: 'legacy-uuid',
                    message: {
                        role: 'assistant', model: 'claude',
                        content: [{ type: 'tool_use', id: 'call-1', name: 'CodexBash', input: { command: 'echo hello' } }],
                    },
                },
            },
        }));
        expect(legacy).not.toBeNull();
        const result = reducer(state, [legacy!]);
        const tool = result.messages.find(m => m.kind === 'tool-call');
        expect(tool?.kind === 'tool-call' && tool.tool.title).toBe('Terminal');
    });

    it.each([
        [{ result: 'hello\nworld' }, 'completed', 'hello\nworld'],
        [{ result: 'permission denied', isError: true }, 'error', 'permission denied'],
        [{ isError: true }, 'error', null],
        [{}, 'completed', null],
        [{ result: '', isError: false }, 'completed', ''],
    ] as const)('preserves title, result, and state: %j', (end, expectedState, expectedResult) => {
        const state = createReducer();
        const start = message('start', {
            t: 'tool-call-start', call: 'call-1', name: 'CodexBash', title: 'Terminal',
            description: 'Running CodexBash', args: { command: 'echo hello' },
        });
        const result = reducer(state, [start, message('end', { t: 'tool-call-end', call: 'call-1', ...end })]);
        const tool = result.messages.find(m => m.kind === 'tool-call');
        expect(tool?.kind === 'tool-call' && tool.tool).toMatchObject({
            callId: 'call-1', name: 'CodexBash', title: 'Terminal',
            input: { command: 'echo hello' }, state: expectedState, result: expectedResult,
        });
    });

    it.each([
        ['hello\nworld', false, 'completed'],
        ['permission denied', true, 'error'],
        ['', false, 'completed'],
    ] as const)('renders a validated Codex wire outcome: %j', (output, isError, expectedState) => {
        const start = message('start', {
            t: 'tool-call-start', call: 'call-1', name: 'CodexBash', title: 'Run command',
            description: 'Run command', args: { command: 'echo hello' },
        });
        const envelope = createEnvelope('agent', {
            t: 'tool-call-end', call: 'call-1', result: output, isError,
        }, { id: 'end', turn: 'turn-1', time: 2 });
        const end = normalizeRawMessage('end', null, 2, RawRecordSchema.parse({ role: 'session', content: envelope }));
        expect(end).not.toBeNull();
        const result = reducer(createReducer(), [start, end!]);
        const tool = result.messages.find(m => m.kind === 'tool-call');
        expect(tool?.kind).toBe('tool-call');
        if (tool?.kind !== 'tool-call') throw new Error('Missing command tool call');
        expect(tool.tool).toMatchObject({ result: output, state: expectedState });
        expect(getTerminalToolResult(tool.tool)).toEqual({
            stdout: isError ? null : output,
            stderr: null,
            error: isError ? output : null,
        });
    });
});
