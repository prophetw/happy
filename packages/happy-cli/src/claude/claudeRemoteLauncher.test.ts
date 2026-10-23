import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { claudeRemoteLauncher } from './claudeRemoteLauncher';
import { closeClaudeTurnWithStatus, mapClaudeLogMessageToSessionEnvelopes, type ClaudeSessionProtocolState } from './utils/sessionProtocolMapper';
import { CLAUDE_LOGIN_EXPIRED_MESSAGE } from './utils/providerAuth';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectPath } from './utils/path';

// Exercise the real outgoing queue, SDK converter and protocol mapper without
// a terminal, credential store, provider process, relay or push service.
vi.mock('./claudeRemote', () => ({ claudeRemote: vi.fn() }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/ui/messageFormatterInk', () => ({ formatClaudeMessageForInk: vi.fn() }));
vi.mock('@/utils/terminalStdinCleanup', () => ({ cleanupStdinAfterInk: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: () => 'fixture-branch' }));
vi.mock('./utils/permissionHandler', () => ({
    PermissionHandler: class {
        reset = vi.fn();
        setOnPermissionRequest = vi.fn();
        getResponseLookup = () => new Map();
        handleToolCall = vi.fn();
    },
}));

function fixture() {
    const handlers = new Map<string, () => Promise<void>>();
    const state: ClaudeSessionProtocolState = { currentTurnId: null };
    const envelopes: SessionEnvelope[] = [];
    const session = {
        sessionId: 'fixture-session', path: '/fixture/project', hookSettingsPath: '/fixture/settings.json',
        queue: { size: () => 0 },
        consumeOneTimeFlags: vi.fn(),
        api: { push: () => ({ sendSessionNotification: notification }) },
        client: {
            sessionId: 'fixture-happy-session',
            rpcHandlerManager: { registerHandler: (name: string, handler: () => Promise<void>) => handlers.set(name, handler) },
            getMetadata: () => ({}),
            sendSessionEvent: vi.fn(),
            sendClaudeSessionMessage: vi.fn((message) => {
                const mapped = mapClaudeLogMessageToSessionEnvelopes(message, state);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
            closeClaudeSessionTurn: vi.fn((status) => {
                const mapped = closeClaudeTurnWithStatus(state, status);
                state.currentTurnId = mapped.currentTurnId;
                envelopes.push(...mapped.envelopes);
            }),
        },
    };
    const notification = vi.fn();
    const stop = () => { void handlers.get('switch')!(); };
    return { session, state, envelopes, notification, stop };
}

describe('claudeRemoteLauncher provider auth', () => {
    beforeEach(() => { vi.mocked(claudeRemote).mockReset(); });

    it('flushes back-to-back auth output before closing the failed wire turn, without a done push', async () => {
        const { session, state, envelopes, notification, stop } = fixture();
        let eventsAtReady: string[] = [];
        let turnAtReady: string | null | undefined;
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            opts.onCompletionEvent?.(CLAUDE_LOGIN_EXPIRED_MESSAGE);
            opts.onMessage({
                type: 'assistant', error: 'authentication_failed', parent_tool_use_id: null,
                message: { role: 'assistant', content: [{ type: 'text', text: 'Provider login failed' }] },
            } as any);
            await opts.onReady('failed');
            // Verify before cleanup's final flush can hide incorrect ordering.
            eventsAtReady = envelopes.map(envelope => envelope.ev.t);
            turnAtReady = state.currentTurnId;
            stop();
        });
        await claudeRemoteLauncher(session as any);
        expect(eventsAtReady).toEqual(['turn-start', 'text', 'turn-end']);
        expect(envelopes.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'failed' });
        expect(turnAtReady).toBeNull();
        expect(notification).not.toHaveBeenCalled();
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(envelopes.filter(envelope => envelope.ev.t === 'turn-end')).toHaveLength(1);
    });

    it('shows untruncated host-login guidance for a thrown OAuth error and accepts a later invocation', async () => {
        const { session, notification, stop } = fixture();
        vi.mocked(claudeRemote)
            .mockRejectedValueOnce(new Error('Failed to authenticate: OAuth session expired and could not be refreshed\nhttps://fixture-secret@example.invalid'))
            .mockImplementationOnce(async () => { stop(); });
        await claudeRemoteLauncher(session as any);
        expect(session.client.closeClaudeSessionTurn).toHaveBeenCalledWith('failed');
        expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: CLAUDE_LOGIN_EXPIRED_MESSAGE });
        expect(JSON.stringify(session.client.sendSessionEvent.mock.calls)).not.toContain('fixture-secret');
        expect(notification).not.toHaveBeenCalled();
        expect(claudeRemote).toHaveBeenCalledTimes(2);
    });
});

describe('claudeRemoteLauncher context usage', () => {
    beforeEach(() => { vi.mocked(claudeRemote).mockReset(); });

    it('delivers the cc-switch context snapshot through the real queue before completing the turn', async () => {
        const { session, envelopes, stop } = fixture();
        let eventsAtReady: string[] = [];
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            opts.onMessage({ type: 'system', subtype: 'thinking_tokens' } as any);
            opts.onMessage({
                type: 'assistant', parent_tool_use_id: null,
                message: {
                    role: 'assistant', model: 'k3', content: [{ type: 'text', text: 'done' }],
                    usage: { input_tokens: 40_528, output_tokens: 0 },
                },
            } as any);
            opts.onMessage({
                type: 'result', subtype: 'success',
                modelUsage: { 'ccs-claude-kimi--k3[1m]': { contextWindow: 1_000_000 } },
            } as any);
            await opts.onReady();
            eventsAtReady = envelopes.map(envelope => envelope.ev.t);
            stop();
        });

        await claudeRemoteLauncher(session as any);

        expect(envelopes.filter(envelope => envelope.ev.t === 'service')).toHaveLength(1);
        expect(envelopes.find(envelope => envelope.ev.t === 'service')).toMatchObject({
            usage: { input_tokens: 40_528, output_tokens: 0, context_window: 1_000_000 },
        });
        expect(eventsAtReady).toEqual(['turn-start', 'text', 'service', 'turn-end']);
        expect(session.client.sendClaudeSessionMessage.mock.calls.some(([message]) => message.subtype === 'thinking_tokens')).toBe(false);
        expect(envelopes.filter(envelope => envelope.ev.t === 'text')).toHaveLength(1);
    });

    it('waits for Ali DeepSeek final transcript counts before sending its context snapshot', async () => {
        const { session, envelopes, stop } = fixture();
        const directory = mkdtempSync(join(tmpdir(), 'happy-launcher-usage-'));
        vi.stubEnv('CLAUDE_CONFIG_DIR', directory);
        const nativeId = '11111111-2222-4333-8444-555555555555';
        session.sessionId = nativeId;
        const project = getProjectPath(session.path);
        mkdirSync(project, { recursive: true });
        let write: ReturnType<typeof setTimeout> | undefined;
        let usageAtReady: unknown;
        vi.mocked(claudeRemote).mockImplementation(async opts => {
            const message = {
                id: 'msg-ali', role: 'assistant', model: 'deepseek-v4.1-flash-1017',
                content: [{ type: 'text', text: 'done' }],
                usage: { input_tokens: 0, output_tokens: 0 },
            };
            opts.onMessage({ type: 'assistant', parent_tool_use_id: null, message } as any);
            write = setTimeout(() => writeFileSync(join(project, `${nativeId}.jsonl`), JSON.stringify({
                type: 'assistant', sessionId: nativeId, isSidechain: false,
                message: { ...message, usage: { input_tokens: 395, cache_read_input_tokens: 37_888, output_tokens: 10 } },
            }) + '\n'), 20);
            opts.onMessage({
                type: 'result', session_id: nativeId,
                modelUsage: { 'ccs-claude-ali--deepseek-v4.1-flash-1017[1m]': { contextWindow: 1_000_000 } },
            } as any);
            await opts.onReady();
            usageAtReady = envelopes.find(envelope => envelope.ev.t === 'service')?.usage;
            stop();
        });
        try {
            await claudeRemoteLauncher(session as any);
            expect(usageAtReady).toMatchObject({
                input_tokens: 395, cache_read_input_tokens: 37_888, output_tokens: 10, context_window: 1_000_000,
            });
            expect(envelopes.map(envelope => envelope.ev.t)).toEqual(['turn-start', 'text', 'service', 'turn-end']);
        } finally {
            clearTimeout(write);
            vi.unstubAllEnvs();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
