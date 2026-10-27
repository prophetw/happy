import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';
import type { SDKMessage } from './sdk';
import { SDKToLogConverter } from './utils/sdkToLogConverter';
import { mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import type { SessionEnvelope } from '@slopus/happy-wire';

// No provider process, credentials, transcript watcher, or real log files.
vi.mock('@/lib', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('./utils/path', () => ({ getProjectPath: () => '/fixture/claude-project' }));
vi.mock('@/modules/watcher/awaitFileExist', () => ({ awaitFileExist: async () => true }));

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    const authAssistant = {
        type: 'assistant',
        error: 'authentication_failed',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: expired }] },
    };

    async function runMessages(sdkMessages: unknown[]) {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() { yield* sdkMessages; },
        } as any);
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        const onMessage = vi.fn();
        const onSDKMetadata = vi.fn();
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'Original prompt', mode })
            .mockResolvedValue(null);
        await claudeRemote({
            sessionId: null,
            path: '/fixture/project',
            allowedTools: [],
            hookSettingsPath: '/fixture/settings.json',
            nextMessage, onReady, onCompletionEvent, onMessage, onSDKMetadata,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            onSessionFound: vi.fn(),
        });
        return { onReady, onCompletionEvent, onMessage, nextMessage, onSDKMetadata };
    }

    it('reports the actual SDK model in session metadata', async () => {
        const callbacks = await runMessages([
            { type: 'system', subtype: 'init', model: 'gateway-model', tools: [], slash_commands: [] },
            { type: 'result', subtype: 'success', is_error: false, result: 'Done' },
        ]);
        expect(callbacks.onSDKMetadata).toHaveBeenCalledWith(expect.objectContaining({ currentModelCode: 'gateway-model' }));
    });

    it('forwards stream content and lifecycle to the timing callback without logging partial content', async () => {
        const lifecycle = ['message_start', 'message_delta', 'message_stop'].map(type => ({
            type: 'stream_event', event: { type }, parent_tool_use_id: null,
        }));
        const events = [
            lifecycle[0],
            { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } },
            lifecycle[1], lifecycle[2],
        ];
        const callbacks = await runMessages(events);
        expect(callbacks.onMessage.mock.calls.map(([message]) => message)).toEqual(events);
        const { logger } = await import('@/lib');
        expect(vi.mocked(logger.debugLargeJson).mock.calls.some(([label]) => String(label).includes('stream_event'))).toBe(false);
    });

    it('carries real remote content forwarding into generation/wait snapshots without duplicate chat rows', async () => {
        const converter = new SDKToLogConverter({ cwd: '/fixture/project', sessionId: 'fixture' });
        const state: ClaudeSessionProtocolState = { currentTurnId: null };
        const envelopes: SessionEnvelope[] = [];
        const clock = vi.spyOn(performance, 'now');
        const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', parent_tool_use_id: null, event });
        const messages = [
            { at: 1000, message: stream({ type: 'message_start', message: { id: 'reply', model: 'k3.1-pro', usage: { input_tokens: 1200, output_tokens: 0 } } }) },
            { at: 8000, message: stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) },
            { at: 8000, message: stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First ' } }) },
            { at: 10000, message: stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'last' } }) },
            { at: 10010, message: { type: 'assistant', parent_tool_use_id: null, message: {
                id: 'reply', model: 'k3.1-pro', content: [{ type: 'text', text: 'First last' }], usage: { input_tokens: 1200, output_tokens: 0 },
            } } },
            { at: 10999, message: stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } }) },
            { at: 11000, message: stream({ type: 'message_stop' }) },
            { at: 12000, message: { type: 'result', subtype: 'success', is_error: false, num_turns: 1,
                duration_ms: 12000, duration_api_ms: 11000, usage: { input_tokens: 1200, output_tokens: 100 } } },
        ];
        vi.mocked(query).mockImplementation(({ options }) => ({
            async *[Symbol.asyncIterator]() {
                clock.mockReturnValue(0);
                options!.onTokenSpeedBoundary!('prompt-submit');
                for (const { at, message } of messages) {
                    clock.mockReturnValue(at);
                    yield message;
                }
            },
        } as any));
        try {
            await claudeRemote({
                sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
                nextMessage: vi.fn().mockResolvedValueOnce({ message: 'Original prompt', mode }).mockResolvedValue(null),
                onReady: vi.fn(), onCompletionEvent: vi.fn(), onSDKMetadata: vi.fn(),
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }), isAborted: () => false,
                onSessionFound: vi.fn(),
                onTokenSpeedBoundary: event => converter.observeTokenSpeedBoundary(event),
                onMessage: message => {
                    const log = converter.convert(message as SDKMessage);
                    if (!log) return;
                    const mapped = mapClaudeLogMessageToSessionEnvelopes(log, state);
                    state.currentTurnId = mapped.currentTurnId;
                    envelopes.push(...mapped.envelopes);
                },
            });
            const usage = envelopes.filter(e => e.usage).at(-1)?.usage;
            expect(usage?.generation_tokens_per_second).toBe(50);
            expect(usage?.time_to_first_token_ms).toBe(8000);
            expect(usage?.generation_tokens_per_second_sample).toEqual({ tokens: 100, duration_ms: 2000, requests: 1 });
            expect(envelopes.filter(e => e.ev.t === 'text').map(e => e.ev)).toEqual([{ t: 'text', text: 'First last' }]);
        } finally {
            clock.mockRestore();
        }
    });

    it('explains host OAuth expiry once and closes the turn as failed', async () => {
        const callbacks = await runMessages([
            authAssistant,
            { type: 'result', subtype: 'success', is_error: true, result: expired },
        ]);
        expect(callbacks.onCompletionEvent).toHaveBeenCalledOnce();
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('host'));
        expect(callbacks.onReady).toHaveBeenCalledWith('failed');
        expect(query).toHaveBeenCalledOnce();
    });

    it('recognizes the result-only SDK error surface', async () => {
        const callbacks = await runMessages([
            { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [expired] },
        ]);
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
        expect(callbacks.onReady).toHaveBeenCalledWith('failed');
    });

    it('allows a later user retry in the same session without replaying the failed prompt', async () => {
        const received: unknown[] = [];
        vi.mocked(query).mockImplementation(({ prompt }) => ({
            async *[Symbol.asyncIterator]() {
                const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                received.push((await input.next()).value);
                yield authAssistant;
                yield { type: 'result', subtype: 'success', is_error: true, result: expired };
                // Models the host login being fixed before the user sends a new prompt.
                received.push((await input.next()).value);
                yield { ...authAssistant, error: undefined, message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] } };
                yield { type: 'result', subtype: 'success', is_error: false, result: 'Recovered' };
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'Original prompt', mode })
            .mockResolvedValueOnce({ message: 'User retry after login', mode })
            .mockResolvedValue(null);
        await claudeRemote({
            sessionId: 'fixture-session', path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage, onReady, onCompletionEvent,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        });
        expect(received).toEqual([
            expect.objectContaining({ message: { role: 'user', content: 'Original prompt' } }),
            expect.objectContaining({ message: { role: 'user', content: 'User retry after login' } }),
        ]);
        expect(onReady.mock.calls).toEqual([['failed'], []]);
        expect(onCompletionEvent).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ resume: 'fixture-session' }) }));
    });

    it('does not interpret ordinary assistant text or a successful result as an auth failure', async () => {
        const callbacks = await runMessages([
            { ...authAssistant, error: undefined },
            { type: 'result', subtype: 'success', is_error: false, result: expired },
        ]);
        expect(callbacks.onCompletionEvent).not.toHaveBeenCalled();
        expect(callbacks.onReady).toHaveBeenCalledWith();
    });

    it.each(['/clear', 'Ordinary prompt'])('awaits the async ready callback for %s', async prompt => {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' }; },
        } as any);
        const failure = new Error('Fixture ready callback failed');
        const nextMessage = vi.fn().mockResolvedValueOnce({ message: prompt, mode }).mockResolvedValue(null);
        await expect(claudeRemote({
            sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage,
            onReady: async () => { throw failure; },
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        })).rejects.toBe(failure);
        expect(nextMessage).toHaveBeenCalledOnce();
    });

    it('does not report successful compaction after a provider auth failure', async () => {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() {
                yield authAssistant;
                yield { type: 'result', subtype: 'success', is_error: true, result: expired };
            },
        } as any);
        const onCompletionEvent = vi.fn();
        await claudeRemote({
            sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage: vi.fn().mockResolvedValueOnce({ message: '/compact', mode }).mockResolvedValue(null),
            onReady: vi.fn(), onCompletionEvent,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        });
        expect(onCompletionEvent).not.toHaveBeenCalledWith('Compaction completed');
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });
});
