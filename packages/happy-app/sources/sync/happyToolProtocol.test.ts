import { describe, expect, it } from 'vitest';
import { normalizeRawMessage, RawRecordSchema } from './typesRaw';
import { createReducer, reducer } from './reducer/reducer';
import { createEnvelope } from '@slopus/happy-wire';
import { getTerminalToolResult } from '@/utils/toolResult';

function message(id: string, ev: Record<string, unknown>) {
    const normalized = normalizeRawMessage(id, null, 1, RawRecordSchema.parse({
        role: 'session',
        content: { id, time: 1, role: 'agent', turn: 'turn-1', ev },
    }));
    expect(normalized).not.toBeNull();
    return normalized!;
}

describe('Happy Agent tool wire → rendered message contract', () => {
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
