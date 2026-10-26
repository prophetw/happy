import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from './utils/sessionProtocolMapper';
import { CodexTokenSpeedTracker } from '@/utils/tokenSpeed';

const {
    mockExecSync,
    mockInitializeSandbox,
    mockWrapForMcpTransport,
    mockSandboxCleanup,
    mockSpawn,
} = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockInitializeSandbox: vi.fn(),
    mockWrapForMcpTransport: vi.fn(),
    mockSandboxCleanup: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('cross-spawn', () => ({
    spawn: mockSpawn,
}));

vi.mock('@/sandbox/manager', () => ({
    initializeSandbox: mockInitializeSandbox,
    wrapForMcpTransport: mockWrapForMcpTransport,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('../package.json', () => ({
    default: { version: '0.0.1-test' },
}));

type MockRpcMessage = {
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
};

function pushJsonLine(stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }, payload: unknown) {
    stdout.push(JSON.stringify(payload) + '\n');
}

// Mock child process with stdin/stdout/stderr
function createMockProcess(opts?: {
    pid?: number;
    initializeDelayMs?: number;
    onRequest?: (msg: MockRpcMessage, stdout: NodeJS.ReadableStream & { push: (chunk: string) => void }) => void;
}) {
    const { Readable, Writable } = require('stream');
    const initializeDelayMs = opts?.initializeDelayMs ?? 5;
    const stdin = new Writable({ write: (_: any, __: any, cb: () => void) => cb() });
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const proc = Object.assign(new (require('events').EventEmitter)(), {
        stdin,
        stdout,
        stderr,
        pid: opts?.pid ?? 12345,
        kill: vi.fn(),
    });
    // Send initialize response immediately when stdin is written to
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (data: any, ...args: any[]) => {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
            if (msg.method === 'initialize' && msg.id != null) {
                // Send response on next tick
                setTimeout(() => {
                    pushJsonLine(stdout, { id: msg.id, result: { userAgent: 'test' } });
                }, initializeDelayMs);
            }
            opts?.onRequest?.(msg, stdout);
        } catch {}
        return origWrite(data, ...args);
    };
    return proc;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sandboxConfig: SandboxConfig = {
    enabled: true,
    workspaceRoot: '~/projects',
    sessionIsolation: 'workspace',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: true,
};

describe('CodexAppServerClient sandbox integration', () => {
    const originalRustLog = process.env.RUST_LOG;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.RUST_LOG = originalRustLog;
        mockExecSync.mockReturnValue('codex-cli 0.153.0');
        mockInitializeSandbox.mockResolvedValue(mockSandboxCleanup);
        mockWrapForMcpTransport.mockResolvedValue({ command: 'sh', args: ['-c', 'wrapped codex app-server'] });
        mockSpawn.mockImplementation(() => createMockProcess());
    });

    afterAll(() => {
        process.env.RUST_LOG = originalRustLog;
    });

    it('reports goal action support for Codex versions with goal action requests', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecSync.mockReturnValue('codex-cli 0.140.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(true);

        mockExecSync.mockReturnValue('codex-cli 0.130.0');
        expect(new CodexAppServerClient().supportsGoalActions()).toBe(false);
    });

    it('requires Codex 0.153.0 or newer', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');

        mockExecSync.mockReturnValue('codex-cli 0.152.9');
        await expect(new CodexAppServerClient().connect()).rejects.toThrow(
            'Codex CLI 0.153.0 or newer is required',
        );
        expect(mockSpawn).not.toHaveBeenCalled();

        mockExecSync.mockReturnValue('codex-cli 0.153.0');
        const client = new CodexAppServerClient();
        await client.connect();
        expect(mockSpawn).toHaveBeenCalled();
        await client.disconnect();
    });

    it('wraps transport when sandbox is enabled', async () => {
        // Dynamic import to ensure mocks are applied
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockInitializeSandbox).toHaveBeenCalledWith(sandboxConfig, process.cwd());
        expect(mockWrapForMcpTransport).toHaveBeenCalledWith('codex', ['app-server', '--listen', 'stdio://']);
        expect(mockSpawn).toHaveBeenCalledWith(
            'sh',
            ['-c', 'wrapped codex app-server'],
            expect.objectContaining({
                env: expect.objectContaining({
                    CODEX_SANDBOX: 'seatbelt',
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(true);

        await client.disconnect();
    });

    it('falls back to non-sandbox transport when sandbox initialization fails', async () => {
        mockInitializeSandbox.mockRejectedValue(new Error('sandbox init failed'));
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockWrapForMcpTransport).not.toHaveBeenCalled();
        expect(mockSpawn).toHaveBeenCalledWith(
            'codex',
            ['app-server', '--listen', 'stdio://'],
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: expect.stringContaining('codex_core::rollout::list=off'),
                }),
            }),
        );
        expect(client.sandboxEnabled).toBe(false);

        await client.disconnect();
    });

    it('resets sandbox on disconnect', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();
        await client.disconnect();

        expect(mockSandboxCleanup).toHaveBeenCalledTimes(1);
        expect(client.sandboxEnabled).toBe(false);
    });

    it('appends rollout log filter to existing RUST_LOG', async () => {
        process.env.RUST_LOG = 'info,codex_core=warn';
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient(sandboxConfig);

        await client.connect();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                env: expect.objectContaining({
                    RUST_LOG: 'info,codex_core=warn,codex_core::rollout::list=off',
                }),
            }),
        );

        await client.disconnect();
    });

    it('ignores stale process exit during reconnect initialize', async () => {
        const proc1 = createMockProcess({ pid: 1001, initializeDelayMs: 5 });
        const proc2 = createMockProcess({ pid: 1002, initializeDelayMs: 50 });
        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.disconnect();

        const reconnect = client.connect();
        setTimeout(() => {
            proc1.emit('exit', 0, null);
        }, 10);

        await expect(reconnect).resolves.toBeUndefined();
        await client.disconnect();
    });

    it.each(['mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration'])
    ('reports execution boundaries for an otherwise unmapped native %s', async (type) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));
        for (const method of ['item/started', 'item/completed']) {
            (client as any).handleNotification(method, {
                threadId: 'thread-main', item: { type, id: 'tool-1' },
            });
        }
        expect(events).toEqual([
            { type: 'token_speed_tool_begin', call_id: 'thread-main:tool-1' },
            { type: 'token_speed_tool_end', call_id: 'thread-main:tool-1' },
        ]);
    });

    it.each(['imageView', 'sleep', 'contextCompaction'])
    ('recovers a model speed sample after native %s instead of disabling the turn', async (type) => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const clock = vi.spyOn(performance, 'now');
        const state: CodexTurnState = { currentTurnId: null, tokenSpeedTracker: new CodexTokenSpeedTracker() };
        const envelopes: ReturnType<typeof mapCodexMcpMessageToSessionEnvelopes>['envelopes'] = [];
        client.setEventHandler(event => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, state);
            state.currentTurnId = mapped.currentTurnId;
            envelopes.push(...mapped.envelopes);
        });
        const notify = (at: number, method: string, data: Record<string, unknown>) => {
            clock.mockReturnValue(at);
            (client as any).handleNotification(method, { threadId: 'thread-main', turnId: 'turn-main', ...data });
        };
        try {
            notify(0, 'turn/started', { turn: { id: 'turn-main' } });
            notify(1000, 'item/completed', { item: { type: 'agentMessage', id: 'comment', text: 'Working' } });
            notify(2000, 'item/started', { item: { type, id: 'activity-1' } });
            notify(62000, 'item/completed', { item: { type, id: 'activity-1' } });
            notify(62100, 'thread/tokenUsage/updated', { tokenUsage: {
                total: { inputTokens: 1200, outputTokens: 150 }, last: { inputTokens: 1200, outputTokens: 150 },
            } });
            notify(63100, 'item/completed', { item: { type: 'agentMessage', id: 'final', text: 'Done' } });
            notify(64100, 'thread/tokenUsage/updated', { tokenUsage: {
                total: { inputTokens: 2400, outputTokens: 250 }, last: { inputTokens: 1200, outputTokens: 100 },
            } });
            notify(64200, 'turn/completed', { turn: { id: 'turn-main', status: 'completed' } });
            const usage = envelopes.filter(envelope => envelope.usage).at(-1)?.usage;
            expect(usage?.output_tokens_per_second).toBe(50);
            expect(usage?.output_tokens_per_second_scope).toBe('model_request');
            expect(envelopes.some(envelope => envelope.ev.t === 'turn-end')).toBe(true);
        } finally {
            clock.mockRestore();
        }
    });

    it('invalidates timing for unknown native items while allowing text lifecycle events', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((event) => events.push(event));
        for (const type of ['agentMessage', 'reasoning', 'userMessage', 'futureActivity']) {
            (client as any).handleNotification('item/started', { item: { type, id: type } });
        }
        expect(events).toEqual([
            { type: 'token_speed_unknown_activity' },
        ]);
    });

    it.each([
        ['silent work', 'completion'],
        ['silent work', 'Stop'],
        ['silent work', 'process exit'],
        ['approval wait', 'completion'],
        ['approval wait', 'Stop'],
        ['approval wait', 'process exit'],
    ])('keeps %s pending past ten minutes until %s', async (work, ending) => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 0,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start') {
                    pushJsonLine(stdout, { id: msg.id, result: {
                        thread: { id: 'thread-long', path: '/tmp/thread-long' },
                        model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                        approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }, reasoningEffort: null,
                    } });
                }
                if (msg.method === 'turn/start') {
                    pushJsonLine(stdout, { id: msg.id, result: { turn: { id: 'turn-long' } } });
                    if (work === 'approval wait') {
                        pushJsonLine(stdout, { id: 99, method: 'item/commandExecution/requestApproval', params: {
                            threadId: 'thread-long', turnId: 'turn-long', itemId: 'command-long', command: 'pwd',
                        } });
                    }
                }
                if (msg.method === 'turn/interrupt') {
                    pushJsonLine(stdout, { id: msg.id, result: {} });
                    pushJsonLine(stdout, { method: 'turn/completed', params: {
                        threadId: 'thread-long', turn: { id: 'turn-long', status: 'interrupted' },
                    } });
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let approve!: (decision: 'approved') => void;
        const approval = new Promise<'approved'>((resolve) => { approve = resolve; });
        const approvalHandler = vi.fn(() => approval);
        const onSettled = vi.fn();
        const events = vi.fn();
        client.setApprovalHandler(approvalHandler);
        client.setEventHandler(events);
        try {
            await client.connect();
            await client.startThread({ cwd: '/tmp/project', approvalPolicy: 'on-request', sandbox: 'read-only' });
            vi.useFakeTimers();
            const pendingTurn = client.sendTurnAndWait('take your time').then(onSettled);
            await vi.advanceTimersByTimeAsync(600_001);

            expect(client.turnId).toBe('turn-long');
            expect(approvalHandler).toHaveBeenCalledTimes(work === 'approval wait' ? 1 : 0);
            expect(requests.some((msg) => msg.id === 99)).toBe(false);
            expect(onSettled).not.toHaveBeenCalled();
            expect(events).not.toHaveBeenCalled();
            expect(requests.some((msg) => msg.method === 'turn/interrupt')).toBe(false);
            expect(proc.kill).not.toHaveBeenCalled();
            expect(mockSpawn).toHaveBeenCalledTimes(1);

            approve('approved');
            await vi.advanceTimersByTimeAsync(0);
            if (ending === 'completion') {
                pushJsonLine(proc.stdout, { method: 'turn/completed', params: {
                    threadId: 'thread-long', turn: { id: 'turn-long', status: 'completed' },
                } });
            } else if (ending === 'Stop') {
                const stopped = client.abortTurnWithFallback();
                await vi.advanceTimersByTimeAsync(25);
                await expect(stopped).resolves.toEqual({
                    hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false,
                });
                expect(requests.filter((msg) => msg.method === 'turn/interrupt')).toHaveLength(1);
            } else {
                proc.emit('exit', 1, null);
                expect(events).toHaveBeenCalledWith(expect.objectContaining({
                    type: 'turn_aborted', status: 'failed',
                    error: expect.objectContaining({ codexErrorInfo: 'transportError' }),
                }));
            }
            await pendingTurn;
            expect(onSettled).toHaveBeenCalledExactlyOnceWith({ aborted: ending !== 'completion' });
        } finally {
            approve('approved');
            await client.disconnect();
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('reconnects and resumes the same thread after forced restart timeout', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];
        type CapturedEvent = { type: string; [key: string]: unknown };

        const proc1 = createMockProcess({
            pid: 2001,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-1' } },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: { abortReason: 'interrupted' } });
                    }, 0);
                }
            },
        });

        const proc2 = createMockProcess({
            pid: 2002,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-1', path: '/tmp/thread-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-2' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_complete', turn_id: 'turn-2' } },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: CapturedEvent[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as CapturedEvent);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang forever');
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));

        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 1,
            forceRestartOnTimeout: true,
        });

        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(events).toContainEqual(expect.objectContaining({
            type: 'turn_aborted',
            reason: 'interrupted',
            turn_id: 'turn-1',
            forced_restart: true,
        }));

        const resumeRequest = secondProcessRequests.find((msg) => msg.method === 'thread/resume');
        expect(resumeRequest?.params).toEqual(expect.objectContaining({
            threadId: 'thread-1',
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
            persistExtendedHistory: true,
        }));
        expect(client.threadId).toBe('thread-1');

        await expect(client.sendTurnAndWait('follow up after reconnect')).resolves.toEqual({ aborted: false });

        await client.disconnect();
    });

    it('force-restarts promptly when turn interrupt RPC does not respond', async () => {
        const firstProcessRequests: MockRpcMessage[] = [];
        const secondProcessRequests: MockRpcMessage[] = [];

        const proc1 = createMockProcess({
            pid: 2101,
            onRequest: (msg, stdout) => {
                firstProcessRequests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-stuck-interrupt', path: '/tmp/thread-stuck-interrupt' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, { id: msg.id, result: {} });
                        pushJsonLine(stdout, {
                            method: 'codex/event',
                            params: { msg: { type: 'task_started', turn_id: 'turn-stuck-interrupt' } },
                        });
                    }, 0);
                }

                // Deliberately do not respond to turn/interrupt. This used to
                // block abortTurnWithFallback until the generic 30s RPC timeout.
            },
        });

        const proc2 = createMockProcess({
            pid: 2102,
            onRequest: (msg, stdout) => {
                secondProcessRequests.push(msg);

                if (msg.method === 'thread/resume' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-stuck-interrupt', path: '/tmp/thread-stuck-interrupt' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn
            .mockImplementationOnce(() => proc1)
            .mockImplementationOnce(() => proc2);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        const pendingTurn = client.sendTurnAndWait('hang on interrupt');
        await waitFor(() => firstProcessRequests.some((msg) => msg.method === 'turn/start'));
        await waitFor(() => client.turnId === 'turn-stuck-interrupt');

        const startedAt = Date.now();
        const abortResult = await client.abortTurnWithFallback({
            gracePeriodMs: 20,
            forceRestartOnTimeout: true,
        });

        expect(Date.now() - startedAt).toBeLessThan(1000);
        await expect(pendingTurn).resolves.toEqual({ aborted: true });
        expect(firstProcessRequests.some((msg) => msg.method === 'turn/interrupt')).toBe(true);
        expect(abortResult).toEqual({
            hadActiveTurn: true,
            aborted: true,
            forcedRestart: true,
            resumedThread: true,
        });
        expect(secondProcessRequests.some((msg) => msg.method === 'thread/resume')).toBe(true);

        await client.disconnect();
    });

    it('forks, reads, and rolls back Codex threads through app-server RPC', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2501,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/fork' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    path: '/tmp/thread-forked',
                                    forkedFromId: 'thread-source',
                                    turns: [],
                                },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/read' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/rollback' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: {
                                    id: 'thread-forked',
                                    turns: [
                                        { id: 'turn-1', items: [{ type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'hello' }] }] },
                                    ],
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/inject_items' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {},
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        const forked = await client.forkThread({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });
        const read = await client.readThread({ threadId: forked.threadId, includeTurns: true });
        const rolledBack = await client.rollbackThread({ threadId: forked.threadId, numTurns: 2 });
        const injected = await client.injectItems({
            threadId: forked.threadId,
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        expect(forked.threadId).toBe('thread-forked');
        expect(read.thread.turns).toHaveLength(1);
        expect(rolledBack.thread.turns).toHaveLength(1);
        expect(injected).toEqual({});
        expect(requests.find((msg) => msg.method === 'thread/fork')?.params).toEqual(expect.objectContaining({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        }));
        expect(requests.find((msg) => msg.method === 'thread/read')?.params).toEqual({
            threadId: 'thread-forked',
            includeTurns: true,
        });
        expect(requests.find((msg) => msg.method === 'thread/rollback')?.params).toEqual({
            threadId: 'thread-forked',
            numTurns: 2,
        });
        expect(requests.find((msg) => msg.method === 'thread/inject_items')?.params).toEqual({
            threadId: 'thread-forked',
            items: [{
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello' }],
            }],
        });

        await client.disconnect();
    });

    it('lists stored Codex threads through app-server without starting a conversation', async () => {
        const requests: MockRpcMessage[] = [];
        const response = {
            data: [{ id: 'native-thread', cwd: '/repo', preview: 'hello', createdAt: 1, updatedAt: 2 }],
            nextCursor: 'next-page',
        };
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/list' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: response });
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        const params = { limit: 100, sortKey: 'updated_at' as const, sourceKinds: ['cli', 'vscode', 'appServer'] as Array<'cli' | 'vscode' | 'appServer'>, archived: false, cwd: '/repo' };
        expect(await client.listThreads(params)).toEqual(response);
        expect(requests.find((msg) => msg.method === 'thread/list')?.params).toEqual(params);
        expect(requests.some((msg) => msg.method === 'thread/start' || msg.method === 'thread/resume')).toBe(false);
        await client.disconnect();
    });

    it('clears active thread state so the next prompt starts a fresh thread', async () => {
        const requests: MockRpcMessage[] = [];
        let nextThreadNumber = 1;
        const proc = createMockProcess({
            pid: 2601,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    const threadId = `thread-${nextThreadNumber++}`;
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: threadId, path: `/tmp/${threadId}` },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'readOnly' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-1');
        expect(client.hasActiveThread()).toBe(true);

        client.clearThreadState();

        expect(client.threadId).toBeNull();
        expect(client.turnId).toBeNull();
        expect(client.hasActiveThread()).toBe(false);

        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'read-only',
        });

        expect(client.threadId).toBe('thread-2');
        expect(requests.filter((msg) => msg.method === 'thread/start')).toHaveLength(2);

        await client.disconnect();
    });

    it('sends extra localImage input items and omits empty text for image-only turns', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2801,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-images', path: '/tmp/thread-images' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-images',
                                turn: { id: 'turn-images', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('', {
            extraInputItems: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-images',
            input: [{ type: 'localImage', path: '/tmp/happy-image.png' }],
        });

        await client.disconnect();
    });

    it('keeps text-only turn input unchanged when no extra input items are supplied', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 2802,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-text', path: '/tmp/thread-text' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-text',
                                turn: { id: 'turn-text', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
        await client.sendTurnAndWait('hello');

        expect(requests.find((msg) => msg.method === 'turn/start')?.params).toMatchObject({
            threadId: 'thread-text',
            input: [{ type: 'text', text: 'hello' }],
        });

        await client.disconnect();
    });

    it('maps raw item notifications into legacy events and deduplicates turn completion', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3001,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-1', path: '/tmp/thread-raw-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'active', activeFlags: [] } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    status: 'inProgress',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'interrupted',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'commandExecution',
                                    id: 'call-1',
                                    command: '/bin/zsh -lc pwd',
                                    cwd: '/tmp/project',
                                    aggregatedOutput: '/tmp/project\n',
                                    exitCode: 0,
                                    durationMs: 1,
                                    status: 'completed',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'collabAgentToolCall',
                                    id: 'collab-1',
                                    tool: 'spawnAgent',
                                    status: 'inProgress',
                                    senderThreadId: 'thread-raw-1',
                                    receiverThreadIds: ['thread-child-1'],
                                    prompt: 'Inspect auth flow',
                                    model: 'gpt-test',
                                    reasoningEffort: 'medium',
                                    agentsStates: {},
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'collabAgentToolCall',
                                    id: 'collab-1',
                                    tool: 'spawnAgent',
                                    status: 'completed',
                                    senderThreadId: 'thread-raw-1',
                                    receiverThreadIds: ['thread-child-1'],
                                    prompt: 'Inspect auth flow',
                                    model: 'gpt-test',
                                    reasoningEffort: 'medium',
                                    agentsStates: {
                                        'thread-child-1': { status: 'completed', message: 'done' },
                                    },
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'subAgentActivity',
                                    id: 'activity-1',
                                    kind: 'started',
                                    agentThreadId: 'thread-child-1',
                                    agentPath: 'Auth explorer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turnId: 'turn-raw-1',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-1',
                                    text: 'done',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/status/changed',
                            params: { threadId: 'thread-raw-1', status: { type: 'idle' } },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-1',
                                turn: { id: 'turn-raw-1', items: [], status: 'completed', error: null },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('run pwd')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-1' }),
            expect.objectContaining({ type: 'exec_command_begin', callId: 'thread-raw-1:call-1' }),
            expect.objectContaining({ type: 'exec_command_end', callId: 'thread-raw-1:call-1', output: '/tmp/project\n' }),
            expect.objectContaining({
                type: 'collab_agent_begin',
                callId: 'collab-1',
                tool: 'spawnAgent',
                receiverThreadIds: ['thread-child-1'],
                prompt: 'Inspect auth flow',
            }),
            expect.objectContaining({
                type: 'collab_agent_end',
                callId: 'collab-1',
                status: 'completed',
                receiverThreadIds: ['thread-child-1'],
            }),
            expect.objectContaining({
                type: 'subagent_activity',
                item_id: 'activity-1',
                kind: 'started',
                agentThreadId: 'thread-child-1',
                agentPath: 'Auth explorer',
            }),
            expect.objectContaining({
                type: 'subagent_activity',
                item_id: 'activity-1',
                kind: 'interrupted',
                agentThreadId: 'thread-child-1',
                agentPath: 'Auth explorer',
            }),
            expect.objectContaining({ type: 'agent_message', message: 'done' }),
        ]));
        expect(events.filter((event) => event.type === 'subagent_activity')).toHaveLength(2);
        expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1);

        await client.disconnect();
    });

    it.each([
        { protocol: 'raw', method: 'thread/tokenUsage/updated', params: {
            threadId: 'thread-child', turnId: 'turn-child', tokenUsage: { total: { outputTokens: 9000 }, last: { outputTokens: 900 } },
        } },
        { protocol: 'raw', method: 'thread/tokenUsage/updated', params: {
            threadId: 'thread-main', turnId: 'turn-old', tokenUsage: { total: { outputTokens: 9000 }, last: { outputTokens: 900 } },
        } },
        { protocol: 'legacy', method: 'codex/event/token_count', params: {
            conversationId: 'thread-child', msg: { type: 'token_count', total: { outputTokens: 9000 } },
        } },
        { protocol: 'legacy', method: 'codex/event/token_count', params: {
            conversationId: 'thread-main', msg: { type: 'token_count', turn_id: 'turn-old', total: { outputTokens: 9000 } },
        } },
        { protocol: 'raw', method: 'thread/status/changed', params: { threadId: 'thread-child', status: { type: 'idle' } } },
        { protocol: 'raw', method: 'turn/started', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'inProgress' } } },
        { protocol: 'raw', method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } } },
        { protocol: 'raw', method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'interrupted' } } },
        { protocol: 'raw', method: 'item/completed', params: {
            threadId: 'thread-child', turnId: 'turn-main',
            item: { type: 'agentMessage', id: 'child-answer', text: 'Child finished', phase: 'final_answer' },
        } },
        { protocol: 'legacy', method: 'codex/event/task_started', params: { conversationId: 'thread-child', msg: { type: 'task_started', turn_id: 'turn-child' } } },
        { protocol: 'legacy', method: 'codex/event/task_complete', params: { conversationId: 'thread-child', msg: { type: 'task_complete', turn_id: 'turn-child' } } },
        { protocol: 'legacy', method: 'codex/event/turn_aborted', params: { conversationId: 'thread-child', msg: { type: 'turn_aborted', turn_id: 'turn-child' } } },
        { protocol: 'legacy', method: 'turn/started', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'inProgress' } } },
        { protocol: 'legacy', method: 'turn/completed', params: { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } } },
        { protocol: 'raw', method: 'turn/completed', params: { threadId: 'thread-main', turn: { id: 'turn-old', status: 'completed' } } },
        { protocol: 'raw', method: 'item/completed', params: {
            threadId: 'thread-main', turnId: 'turn-old',
            item: { type: 'agentMessage', id: 'old-answer', text: 'Previous turn finished', phase: 'final_answer' },
        } },
        { protocol: 'legacy', method: 'codex/event', params: { msg: { type: 'task_complete', turn_id: 'turn-old' } } },
    ])('keeps the parent turn active after unrelated $protocol $method ($params)', async ({ protocol, method, params }) => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: {
                        thread: { id: 'thread-main', path: '/tmp/thread-main' },
                        model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                        approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null,
                    } });
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: {
                        turn: { id: 'turn-main', items: [], status: 'inProgress', error: null },
                    } });
                    pushJsonLine(stdout, protocol === 'raw' ? {
                        method: 'turn/started', params: {
                            threadId: 'thread-main', turn: { id: 'turn-main', status: 'inProgress' },
                        },
                    } : {
                        method: 'codex/event', params: {
                            conversationId: 'thread-main', msg: { type: 'task_started', turn_id: 'turn-main' },
                        },
                    });
                }
                if (msg.method === 'turn/interrupt' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: {} });
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        let state: CodexTurnState = { currentTurnId: null };
        const sessionLifecycle: string[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg as Record<string, unknown>, state);
            state = mapped;
            for (const envelope of mapped.envelopes) {
                if (envelope.ev.t === 'turn-start' || envelope.ev.t === 'turn-end') {
                    sessionLifecycle.push(envelope.ev.t);
                }
            }
        });
        await client.connect();
        try {
            await client.startThread({
                model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
            });
            const onSettled = vi.fn();
            const turn = client.sendTurnAndWait('Run the parent task');
            void turn.then(onSettled);
            await waitFor(() => events.some((event) => event.type === 'task_started'));

            pushJsonLine(proc.stdout, { method, params });
            if (protocol === 'raw') {
                pushJsonLine(proc.stdout, { method: 'item/started', params: {
                    threadId: 'thread-child', turnId: 'turn-child',
                    item: { type: 'commandExecution', id: 'child-tool', command: 'pwd', cwd: '/tmp/project' },
                } });
                pushJsonLine(proc.stdout, { method: 'item/completed', params: {
                    threadId: 'thread-child', turnId: 'turn-child',
                    item: { type: 'commandExecution', id: 'child-tool', aggregatedOutput: '/tmp/project', exitCode: 0 },
                } });
            }
            // A parent tool notification is a barrier: the preceding child
            // notification must have been consumed before these assertions.
            pushJsonLine(proc.stdout, protocol === 'raw' ? {
                method: 'item/started', params: {
                    threadId: 'thread-main', turnId: 'turn-main',
                    item: { type: 'commandExecution', id: 'parent-tool', command: 'pwd', cwd: '/tmp/project' },
                },
            } : {
                method: 'codex/event', params: {
                    conversationId: 'thread-main', msg: { type: 'exec_command_begin', call_id: 'parent-tool', command: 'pwd' },
                },
            });
            const parentCallId = protocol === 'raw' ? 'thread-main:parent-tool' : 'parent-tool';
            await waitFor(() => events.some((event) => event.type === 'exec_command_begin' && event.call_id === parentCallId));

            expect(events.filter((event) => ['task_started', 'task_complete', 'turn_aborted'].includes(String(event.type))))
                .toEqual([expect.objectContaining({ type: 'task_started', turn_id: 'turn-main' })]);
            expect(onSettled).not.toHaveBeenCalled();
            expect(client.turnId).toBe('turn-main');
            expect(sessionLifecycle).toEqual(['turn-start']);
            expect(state.currentTurnId).not.toBeNull();
            expect(events.filter((event) => event.type === 'token_count')).toEqual([]);
            if (protocol === 'raw') {
                expect(events).toEqual(expect.arrayContaining([
                    expect.objectContaining({ type: 'exec_command_begin', callId: 'thread-child:child-tool' }),
                    expect.objectContaining({ type: 'exec_command_end', callId: 'thread-child:child-tool' }),
                ]));
                if (method === 'item/completed' && params.item) {
                    expect(events).toContainEqual(expect.objectContaining({ type: 'agent_message', item_id: params.item.id }));
                }
            }
            await client.interruptTurn();
            expect(requests.find((request) => request.method === 'turn/interrupt')?.params)
                .toMatchObject({ threadId: 'thread-main', turnId: 'turn-main' });

            pushJsonLine(proc.stdout, {
                method: 'turn/completed', params: {
                    threadId: 'thread-main', turn: { id: 'turn-main', status: 'interrupted' },
                },
            });
            await expect(turn).resolves.toEqual({ aborted: true });
            expect(events.filter((event) => event.type === 'turn_aborted')).toHaveLength(1);
            expect(sessionLifecycle).toEqual(['turn-start', 'turn-end']);
            expect(state.currentTurnId).toBeNull();
        } finally {
            await client.disconnect();
        }
    });

    it('maps raw goal notifications into legacy goal events', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-goal-1', path: '/tmp/thread-goal-1' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/updated',
                            params: {
                                threadId: 'thread-goal-1',
                                turnId: 'turn-goal-1',
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: 'finish the task',
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 11,
                                    timeUsedSeconds: 3,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680003,
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'thread/goal/cleared',
                            params: { threadId: 'thread-goal-1' },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await waitFor(() => events.some((event) => event.type === 'thread_goal_cleared'));

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'thread_goal_updated',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
                turn_id: 'turn-goal-1',
                turnId: 'turn-goal-1',
                goal: expect.objectContaining({
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                    status: 'active',
                }),
            }),
            expect.objectContaining({
                type: 'thread_goal_cleared',
                thread_id: 'thread-goal-1',
                threadId: 'thread-goal-1',
            }),
        ]));

        await client.disconnect();
    });

    it('sends goal set and clear requests through app-server', async () => {
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                requests.push(msg);

                if (msg.method === 'thread/goal/set' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                goal: {
                                    threadId: 'thread-goal-1',
                                    objective: msg.params?.objective,
                                    status: 'active',
                                    tokenBudget: null,
                                    tokensUsed: 0,
                                    timeUsedSeconds: 0,
                                    createdAt: 1781680000,
                                    updatedAt: 1781680001,
                                },
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'thread/goal/clear' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: { cleared: true },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();
        await expect(client.setGoal({
            threadId: 'thread-goal-1',
            objective: 'finish the task',
        })).resolves.toMatchObject({
            goal: {
                threadId: 'thread-goal-1',
                objective: 'finish the task',
                status: 'active',
            },
        });
        await expect(client.clearGoal({
            threadId: 'thread-goal-1',
        })).resolves.toEqual({ cleared: true });

        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                method: 'thread/goal/set',
                params: {
                    threadId: 'thread-goal-1',
                    objective: 'finish the task',
                },
            }),
            expect.objectContaining({
                method: 'thread/goal/clear',
                params: {
                    threadId: 'thread-goal-1',
                },
            }),
        ]));

        await client.disconnect();
    });

    it('maps raw file change items into legacy patch events', async () => {
        const proc = createMockProcess({
            pid: 3003,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-3', path: '/tmp/thread-raw-3' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-1',
                                    status: 'completed',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }, {
                                        path: 'MONETIZATION.md',
                                        type: 'add',
                                        content: '# Monetization\n\nPaid plans.\n',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turnId: 'turn-raw-3',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-3',
                                    text: 'patched',
                                    phase: 'final_answer',
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/completed',
                            params: {
                                threadId: 'thread-raw-3',
                                turn: { id: 'turn-raw-3', status: 'completed' },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        await expect(client.sendTurnAndWait('patch the file')).resolves.toEqual({ aborted: false });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch_apply_begin',
                callId: 'thread-raw-3:patch-1',
                changes: {
                    'README.md': {
                        diff: '@@ -1 +1 @@',
                        kind: { type: 'update', move_path: null },
                    },
                    'MONETIZATION.md': {
                        kind: { type: 'add', move_path: null },
                        add: { content: '# Monetization\n\nPaid plans.\n' },
                    },
                },
            }),
            expect.objectContaining({
                type: 'patch_apply_end',
                callId: 'thread-raw-3:patch-1',
                status: 'completed',
            }),
        ]));

        await client.disconnect();
    });

    it('hydrates v2 file change approvals from raw item metadata', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3004,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-4', path: '/tmp/thread-raw-4' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-approval-1',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'README.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ -1 +1 @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 99,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-raw-4',
                                turnId: 'turn-raw-4',
                                itemId: 'patch-approval-1',
                                reason: null,
                                grantRoot: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'patch',
            callId: 'thread-raw-4:patch-approval-1',
            itemId: 'patch-approval-1',
            threadId: 'thread-raw-4',
            turnId: 'turn-raw-4',
            fileChanges: {
                'README.md': {
                    diff: '@@ -1 +1 @@',
                    kind: { type: 'update', move_path: null },
                },
            },
            reason: null,
        }));

        await client.disconnect();
    });

    it('scopes v2 approval IDs and raw file-change metadata by thread', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-a', path: '/tmp/thread-a' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-shared',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'A.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ A @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/started',
                            params: {
                                threadId: 'thread-b',
                                turnId: 'turn-b',
                                item: {
                                    type: 'fileChange',
                                    id: 'patch-shared',
                                    status: 'inProgress',
                                    changes: [{
                                        path: 'B.md',
                                        kind: { type: 'update', move_path: null },
                                        diff: '@@ B @@',
                                    }],
                                },
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 101,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                itemId: 'patch-shared',
                                reason: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 102,
                            method: 'item/fileChange/requestApproval',
                            params: {
                                threadId: 'thread-b',
                                turnId: 'turn-b',
                                itemId: 'patch-shared',
                                reason: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 103,
                            method: 'item/commandExecution/requestApproval',
                            params: {
                                threadId: 'thread-a',
                                turnId: 'turn-a',
                                itemId: 'cmd-shared',
                                approvalId: 'approval-a',
                                command: 'npm test',
                                cwd: '/tmp/project',
                                reason: null,
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 3);

        expect(approvals).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: 'patch',
                callId: 'thread-a:patch-shared',
                itemId: 'patch-shared',
                threadId: 'thread-a',
                turnId: 'turn-a',
                fileChanges: {
                    'A.md': expect.objectContaining({ diff: '@@ A @@' }),
                },
            }),
            expect.objectContaining({
                type: 'patch',
                callId: 'thread-b:patch-shared',
                itemId: 'patch-shared',
                threadId: 'thread-b',
                turnId: 'turn-b',
                fileChanges: {
                    'B.md': expect.objectContaining({ diff: '@@ B @@' }),
                },
            }),
            // No approvalId suffix in callId: the app attaches the permission
            // card to its tool call by exact id equality with the scoped
            // exec_command_begin call id.
            expect.objectContaining({
                type: 'exec',
                callId: 'thread-a:cmd-shared',
                itemId: 'cmd-shared',
                threadId: 'thread-a',
                turnId: 'turn-a',
                approvalId: 'approval-a',
                command: ['npm test'],
            }),
        ]));

        await client.disconnect();
    });

    it('routes native questions and stops responding after Codex resolves a request', async () => {
        const sent: MockRpcMessage[] = [];
        const proc = createMockProcess({ onRequest: message => { sent.push(message); } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        let answer!: (value: { answers: Record<string, { answers: string[] }> }) => void;
        const handler = vi.fn(() => new Promise<{ answers: Record<string, { answers: string[] }> }>(resolve => { answer = resolve; }));
        const onResolved = vi.fn();
        client.setUserInputHandler(handler, onResolved);
        await client.connect();
        const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: false, questions: [] };
        try {
            pushJsonLine(proc.stdout, { id: 'question-1', method: 'item/tool/requestUserInput', params });
            await waitFor(() => handler.mock.calls.length === 1);
            expect(handler).toHaveBeenCalledWith('question-1', params);
            answer({ answers: { color: { answers: ['Blue'] } } });
            await waitFor(() => sent.some(message => message.id === 'question-1'));
            expect(sent.find(message => message.id === 'question-1')?.result).toEqual({ answers: { color: { answers: ['Blue'] } } });

            pushJsonLine(proc.stdout, { id: 'question-2', method: 'item/tool/requestUserInput', params });
            await waitFor(() => handler.mock.calls.length === 2);
            pushJsonLine(proc.stdout, { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'question-2' } });
            await waitFor(() => onResolved.mock.calls.length === 1);
            answer({ answers: {} });
            await new Promise(resolve => setImmediate(resolve));
            expect(onResolved).toHaveBeenCalledWith('question-2');
            expect(sent.some(message => message.id === 'question-2')).toBe(false);
        } finally {
            await client.disconnect();
        }
    });

    it('steers the active turn without starting or interrupting another turn', async () => {
        const sent: MockRpcMessage[] = [];
        let rejectSteer = false;
        const proc = createMockProcess({ onRequest: (message, stdout) => {
            sent.push(message);
            if (message.method === 'thread/start') pushJsonLine(stdout, { id: message.id, result: {
                thread: { id: 'thread-steer' }, model: 'test', modelProvider: 'openai', cwd: '/tmp', approvalPolicy: 'never', sandbox: {}, reasoningEffort: null,
            } });
            if (message.method === 'turn/start') {
                pushJsonLine(stdout, { id: message.id, result: { turn: { id: 'turn-steer' } } });
                pushJsonLine(stdout, { method: 'turn/started', params: { threadId: 'thread-steer', turn: { id: 'turn-steer' } } });
            }
            if (message.method === 'turn/steer') pushJsonLine(stdout, rejectSteer
                ? { id: message.id, error: { code: -32600, message: 'No active turn' } }
                : { id: message.id, result: { turnId: 'turn-steer' } });
        } });
        mockSpawn.mockImplementation(() => proc);
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        await client.connect();
        try {
            await client.startThread({ model: 'test', cwd: '/tmp', approvalPolicy: 'never', sandbox: 'danger-full-access' });
            const turn = client.sendTurnAndWait('Investigate');
            await waitFor(() => client.turnId === 'turn-steer');
            expect(await client.steerTurn('Focus on tests', [{ type: 'localImage', path: '/tmp/input.png' }])).toBe(true);
            expect(sent.find(message => message.method === 'turn/steer')?.params).toEqual({
                threadId: 'thread-steer', expectedTurnId: 'turn-steer',
                input: [{ type: 'text', text: 'Focus on tests' }, { type: 'localImage', path: '/tmp/input.png' }],
            });
            expect(sent.filter(message => message.method === 'turn/start')).toHaveLength(1);
            expect(sent.some(message => message.method === 'turn/interrupt')).toBe(false);
            rejectSteer = true;
            expect(await client.steerTurn('Arrived too late')).toBe(false);
            pushJsonLine(proc.stdout, { method: 'turn/completed', params: { threadId: 'thread-steer', turn: { id: 'turn-steer', status: 'completed' } } });
            await turn;
            expect(await client.steerTurn('Next turn')).toBe(false);
        } finally {
            await client.disconnect();
        }
    });

    it.each([
        { delivery: undefined, status: 'completed' },
        { delivery: null, status: 'completed' },
        { delivery: 'async', status: 'completed' },
        { delivery: undefined, status: 'failed' },
        { delivery: undefined, status: 'interrupted' },
    ] as const)('keeps a final answer with delivery=$delivery pending until turn status is $status', async ({ delivery, status }) => {
        const requests: MockRpcMessage[] = [];
        const message = delivery === 'async' ? {
            text: 'Which model should I use?',
            questions: [{ title: 'Which model should I use?', options: ['Current model'] }],
        } : { text: 'Current work is complete.' };
        const proc = createMockProcess({
            pid: 3008,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: {
                        thread: { id: 'thread-async', path: '/tmp/thread-async' },
                        model: 'gpt-test', modelProvider: 'openai', cwd: '/tmp/project',
                        approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, reasoningEffort: null,
                    } });
                }
                if (msg.method === 'turn/start' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: {
                        turn: { id: 'turn-async', items: [], status: 'inProgress', error: null },
                    } });
                    pushJsonLine(stdout, { method: 'turn/started', params: {
                        threadId: 'thread-async',
                        turn: { id: 'turn-async', items: [], status: 'inProgress', error: null },
                    } });
                    pushJsonLine(stdout, { method: 'item/completed', params: {
                        threadId: 'thread-async', turnId: 'turn-async',
                        item: {
                            type: 'agentMessage', id: 'question-async', ...message,
                            phase: 'final_answer', delivery,
                        },
                    } });
                    pushJsonLine(stdout, { method: 'item/started', params: {
                        threadId: 'thread-async', turnId: 'turn-async',
                        item: { type: 'commandExecution', id: 'command-async', command: 'pwd', cwd: '/tmp/project' },
                    } });
                }
                if (msg.method === 'turn/steer' && msg.id != null) {
                    pushJsonLine(stdout, { id: msg.id, result: { turnId: 'turn-async' } });
                }
            },
        });
        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        let state: CodexTurnState = { currentTurnId: null };
        const sessionLifecycle: string[] = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
            const mapped = mapCodexMcpMessageToSessionEnvelopes(msg as Record<string, unknown>, state);
            state = mapped;
            for (const envelope of mapped.envelopes) {
                if (envelope.ev.t === 'turn-start' || envelope.ev.t === 'turn-end') {
                    sessionLifecycle.push(envelope.ev.t);
                }
            }
        });

        await client.connect();
        try {
            await client.startThread({
                model: 'gpt-test', cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'danger-full-access',
            });
            const onSettled = vi.fn();
            const turn = client.sendTurnAndWait('Investigate the task');
            void turn.then(onSettled);
            await waitFor(() => events.some((event) => event.type === 'exec_command_begin'));

            expect(events).toEqual(expect.arrayContaining([
                expect.objectContaining({ type: 'task_started', turn_id: 'turn-async' }),
                expect.objectContaining({
                    type: 'agent_message', message: message.text, delivery,
                    ...(delivery === 'async' ? { questions: message.questions } : {}),
                    thread_id: 'thread-async', turn_id: 'turn-async', item_id: 'question-async',
                }),
                expect.objectContaining({ type: 'exec_command_begin', callId: 'thread-async:command-async' }),
            ]));
            expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(0);
            expect(onSettled).not.toHaveBeenCalled();
            expect(client.turnId).toBe('turn-async');
            expect(sessionLifecycle).toEqual(['turn-start']);
            expect(state.currentTurnId).not.toBeNull();
            expect(await client.steerTurn('Continue with HTTP verification')).toBe(true);
            expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
            expect(requests.find((request) => request.method === 'turn/steer')?.params)
                .toMatchObject({ threadId: 'thread-async', expectedTurnId: 'turn-async' });

            pushJsonLine(proc.stdout, { method: 'turn/completed', params: {
                threadId: 'thread-async', turn: { id: 'turn-async', status },
            } });
            const aborted = status === 'interrupted';
            await expect(turn).resolves.toEqual({ aborted });
            expect(onSettled).toHaveBeenCalledExactlyOnceWith({ aborted });
            expect(events.filter((event) => event.type === 'task_complete' || event.type === 'turn_aborted'))
                .toEqual([expect.objectContaining({ type: aborted ? 'turn_aborted' : 'task_complete', status })]);
            expect(client.turnId).toBeNull();
            expect(sessionLifecycle).toEqual(['turn-start', 'turn-end']);
            expect(state.currentTurnId).toBeNull();
        } finally {
            await client.disconnect();
        }
    });

    it('waits for thread idle when raw turn/completed is missing', async () => {
        const proc = createMockProcess({
            pid: 3002,
            onRequest: (msg, stdout) => {
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-2', path: '/tmp/thread-raw-2' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'never',
                                sandbox: { type: 'dangerFullAccess' },
                                reasoningEffort: null,
                            },
                        });
                    }, 0);
                }

                if (msg.method === 'turn/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'turn/started',
                            params: {
                                threadId: 'thread-raw-2',
                                turn: { id: 'turn-raw-2', items: [], status: 'inProgress', error: null },
                            },
                        });
                        pushJsonLine(stdout, {
                            method: 'item/completed',
                            params: {
                                threadId: 'thread-raw-2',
                                turnId: 'turn-raw-2',
                                item: {
                                    type: 'agentMessage',
                                    id: 'msg-2',
                                    text: 'still works',
                                    phase: 'final_answer',
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        const events: Array<Record<string, unknown>> = [];
        client.setEventHandler((msg) => {
            events.push(msg as Record<string, unknown>);
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });

        const onSettled = vi.fn();
        const turn = client.sendTurnAndWait('say hi');
        void turn.then(onSettled);
        await waitFor(() => events.some((event) => event.type === 'agent_message'));
        expect(onSettled).not.toHaveBeenCalled();
        expect(client.turnId).toBe('turn-raw-2');

        pushJsonLine(proc.stdout, {
            method: 'thread/status/changed',
            params: { threadId: 'thread-raw-2', status: { type: 'idle' } },
        });
        await expect(turn).resolves.toEqual({ aborted: false });
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'task_started', turn_id: 'turn-raw-2' }),
            expect.objectContaining({ type: 'agent_message', message: 'still works' }),
            expect.objectContaining({ type: 'task_complete', turn_id: 'turn-raw-2' }),
        ]));

        await client.disconnect();
    });

    it('responds to MCP elicitation requests with an action payload', async () => {
        const approvals: Array<Record<string, unknown>> = [];
        const requests: MockRpcMessage[] = [];
        const proc = createMockProcess({
            pid: 3007,
            onRequest: (msg, stdout) => {
                requests.push(msg);
                if (msg.method === 'thread/start' && msg.id != null) {
                    setTimeout(() => {
                        pushJsonLine(stdout, {
                            id: msg.id,
                            result: {
                                thread: { id: 'thread-raw-7', path: '/tmp/thread-raw-7' },
                                model: 'gpt-test',
                                modelProvider: 'openai',
                                cwd: '/tmp/project',
                                approvalPolicy: 'on-request',
                                sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
                                reasoningEffort: null,
                            },
                        });
                        pushJsonLine(stdout, {
                            id: 77,
                            method: 'mcpServer/elicitation/request',
                            params: {
                                threadId: 'thread-raw-7',
                                turnId: 'turn-raw-7',
                                serverName: 'happy',
                                mode: 'form',
                                _meta: {
                                    codex_approval_kind: 'mcp_tool_call',
                                    tool_title: 'Change Chat Title',
                                    tool_description: 'Change the title of the current chat session',
                                    tool_params: { title: 'Casual Greeting' },
                                },
                                message: 'Allow the happy MCP server to run tool "change_title"?',
                                requestedSchema: {
                                    type: 'object',
                                    properties: {},
                                },
                            },
                        });
                    }, 0);
                }
            },
        });

        mockSpawn.mockImplementation(() => proc);

        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();
        client.setApprovalHandler(async (params) => {
            approvals.push(params as Record<string, unknown>);
            return 'approved';
        });

        await client.connect();
        await client.startThread({
            model: 'gpt-test',
            cwd: '/tmp/project',
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
        });

        await waitFor(() => approvals.length === 1);
        await waitFor(() => requests.some((msg) => msg.id === 77 && msg.result?.action === 'accept'));

        expect(approvals[0]).toEqual(expect.objectContaining({
            type: 'mcp',
            callId: 'thread-raw-7:happy:77',
            itemId: 'happy:77',
            threadId: 'thread-raw-7',
            turnId: 'turn-raw-7',
            approvalId: '77',
            toolName: 'change_title',
            input: { title: 'Casual Greeting' },
            serverName: 'happy',
        }));
        expect(requests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 77,
                result: {
                    action: 'accept',
                    content: {},
                    _meta: null,
                },
            }),
        ]));

        await client.disconnect();
    });
});
