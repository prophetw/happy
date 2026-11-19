import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createApi: vi.fn(),
    createSession: vi.fn(),
    setupSession: vi.fn(),
    connect: vi.fn(),
    resumeThread: vi.fn(),
    disconnect: vi.fn(),
    notifyStarted: vi.fn(),
    notifyFailed: vi.fn(),
    waitForMessage: vi.fn(),
    sendTurn: vi.fn(),
    notify: vi.fn(),
    eventHandler: null as null | ((event: any) => void),
    session: {
        sessionId: 'happy-resumed',
        getMetadata: vi.fn(() => null),
        getAgentState: vi.fn(() => ({} as { humanIntervention?: unknown })),
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        keepAlive: vi.fn(),
        updateMetadata: vi.fn(),
        suppressNextArchiveSignal: vi.fn(),
        skipExistingMessages: vi.fn(),
        updateAgentState: vi.fn(),
        sendSessionProtocolMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(),
        close: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    },
}));

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => 'codex-cli 0.162.1') }));
vi.mock('ink', () => ({ render: vi.fn() }));
vi.mock('@/ui/ink/CodexDisplay', () => ({ CodexDisplay: () => null }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('@/api/api', () => ({ ApiClient: { create: mocks.createApi } }));
vi.mock('@/persistence', () => ({ readSettings: async () => ({ machineId: 'machine-1' }) }));
vi.mock('@/daemon/run', () => ({ initialMachineMetadata: {} }));
vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: mocks.notifyStarted,
    notifyDaemonSessionStartupFailed: mocks.notifyFailed,
}));
vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: () => ({ metadata: { hostPid: process.pid, flavor: 'codex' }, state: {} }),
}));
vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: mocks.setupSession,
}));
vi.mock('@/utils/serverConnectionErrors', () => ({ connectionState: { setBackend: vi.fn() } }));
vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: class {
        waitForMessagesAndGetAsString = mocks.waitForMessage;
        size = () => 0;
    },
}));
vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: async () => ({ url: 'http://test.invalid', stop: vi.fn() }),
}));
vi.mock('@/claude/registerKillSessionHandler', () => ({ registerKillSessionHandler: vi.fn() }));
vi.mock('./codexAppServerClient', () => ({
    CodexAppServerClient: class {
        connect = mocks.connect;
        resumeThread = mocks.resumeThread;
        disconnect = mocks.disconnect;
        setApprovalHandler = vi.fn();
        threadId = 'native-thread';
        hasActiveThread = () => true;
        sendTurnAndWait = mocks.sendTurn;
        setEventHandler = (handler: (event: any) => void) => { mocks.eventHandler = handler; };
        setUserInputHandler = vi.fn();
    },
}));
vi.mock('./utils/permissionHandler', () => ({ CodexPermissionHandler: class { reset = vi.fn(); } }));
vi.mock('./utils/reasoningProcessor', () => ({ ReasoningProcessor: class { abort = vi.fn(); } }));
vi.mock('./utils/diffProcessor', () => ({ DiffProcessor: class { reset = vi.fn(); } }));
vi.mock('./codexSkills', () => ({ discoverCodexSkillCommands: async () => [] }));

import { runCodex } from './runCodex';

const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };

describe('Codex resume startup readiness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.session.getAgentState.mockReturnValue({});
        vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', '');
        vi.stubEnv('HAPPY_FORK_CODEX_THREAD_ID', '');
        mocks.setupSession.mockReturnValue({ session: mocks.session });
        mocks.createSession.mockResolvedValue({
            id: 'happy-resumed',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            seq: 0, metadataVersion: 0, agentStateVersion: 0,
        });
        mocks.createApi.mockResolvedValue({
            push: () => ({ sendSessionNotification: mocks.notify }),
            getOrCreateMachine: vi.fn().mockResolvedValue({}),
            getOrCreateSession: mocks.createSession,
        });
        mocks.connect.mockResolvedValue(undefined);
        mocks.resumeThread.mockResolvedValue({ threadId: 'native-thread', model: 'gpt-5.6-sol' });
        mocks.disconnect.mockResolvedValue(undefined);
        mocks.notifyStarted.mockResolvedValue({ status: 'ok' });
        mocks.notifyFailed.mockResolvedValue({ status: 'ok' });
        mocks.waitForMessage.mockResolvedValue(null);
        mocks.sendTurn.mockReset();
    });

    afterEach(() => vi.unstubAllEnvs());

    it('waits for the native thread to resume before reporting startup success', async () => {
        let resume!: (value: { threadId: string; model: string }) => void;
        mocks.resumeThread.mockReturnValue(new Promise((resolve) => { resume = resolve; }));
        const running = runCodex({ credentials, startedBy: 'daemon', resumeThreadId: 'native-thread' });
        try {
            await vi.waitFor(() => expect(mocks.resumeThread).toHaveBeenCalled());
            expect(mocks.notifyStarted).not.toHaveBeenCalled();
        } finally {
            resume({ threadId: 'native-thread', model: 'gpt-5.6-sol' });
            await running;
        }
        expect(mocks.notifyStarted).toHaveBeenCalledWith(
            'happy-resumed', expect.objectContaining({ codexThreadId: 'native-thread' }), expect.any(Object),
        );
        const { metadata } = mocks.createSession.mock.calls[0][0];
        expect(metadata.modelMode).toBeUndefined();
        expect(metadata.effortLevel).toBeUndefined();
        expect(mocks.notifyFailed).not.toHaveBeenCalled();
    });

    it('reports an active writer conflict without announcing a successful startup', async () => {
        mocks.resumeThread.mockRejectedValue(new Error('thread/resume: thread native-thread already has an active writer (code=-32600)'));
        await expect(runCodex({ credentials, startedBy: 'daemon', resumeThreadId: 'native-thread' }))
            .rejects.toThrow('already has an active writer');
        expect(mocks.notifyStarted).not.toHaveBeenCalled();
        expect(mocks.notifyFailed).toHaveBeenCalledWith(process.pid, expect.stringContaining('already has an active writer'));
        expect(mocks.session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message', message: expect.stringContaining('Close'),
        });
        expect(mocks.disconnect).toHaveBeenCalledOnce();
        expect(mocks.session.close).toHaveBeenCalledOnce();
    });

    it('reports a transport startup error before attempting to resume', async () => {
        mocks.connect.mockRejectedValue(new Error('Codex transport failed'));
        await expect(runCodex({ credentials, startedBy: 'daemon', resumeThreadId: 'native-thread' }))
            .rejects.toThrow('Codex transport failed');
        expect(mocks.notifyStarted).not.toHaveBeenCalled();
        expect(mocks.resumeThread).not.toHaveBeenCalled();
        expect(mocks.notifyFailed).toHaveBeenCalledWith(process.pid, 'Codex transport failed');
    });

    it.each([
        [{ model: 'gpt-6.2-sol', effort: 'max' } as const, 'gpt-6.2-sol', 'max'],
        [{}, 'gpt-6.1-sol', 'medium'],
    ] as const)('publishes resolved launch modes in the first session snapshot for %j', async (options, model, effort) => {
        await runCodex({ credentials, startedBy: 'daemon', ...options });
        expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({ flavor: 'codex', modelMode: model, effortLevel: effort }),
        }));
        expect(mocks.createSession).toHaveBeenCalledBefore(mocks.notifyStarted);
        expect(mocks.resumeThread).not.toHaveBeenCalled();
    });

    it('keeps the latest user picks and metadata when resuming an existing Happy session', async () => {
        vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'happy-resumed');
        vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_KEY', Buffer.alloc(32).toString('base64'));
        vi.stubEnv('HAPPY_RECONNECT_ENCRYPTION_VARIANT', 'legacy');
        vi.stubEnv('HAPPY_RECONNECT_METADATA_VERSION', '7');
        await runCodex({
            credentials, startedBy: 'daemon', resumeThreadId: 'native-thread',
            model: 'gpt-6.1-sol', effort: 'low',
        });

        expect(mocks.createSession).not.toHaveBeenCalled();
        const { response } = mocks.setupSession.mock.calls[0][0];
        expect(response.metadataVersion).toBeLessThan(0);
        expect(response.metadata).not.toHaveProperty('modelMode');
        expect(response.metadata).not.toHaveProperty('effortLevel');
        const latest = { modelMode: 'gpt-6.2-sol', effortLevel: 'max', name: 'User title', lifecycleState: 'archived' };
        const merged = mocks.session.updateMetadata.mock.calls.reduce((metadata, [apply]) => apply(metadata), latest);
        expect(merged).toMatchObject({ ...latest, lifecycleState: 'running', codexThreadId: 'native-thread' });
    });

    it('sends failure with its type, then success for a successful retry', async () => {
        const batch = { message: 'Continue', mode: { permissionMode: 'yolo', model: 'gpt-6.1-sol' }, hash: 'test', isolate: false };
        mocks.waitForMessage.mockResolvedValueOnce(batch).mockResolvedValueOnce(batch);
        mocks.sendTurn.mockImplementationOnce(async () => {
            mocks.eventHandler!({ type: 'task_started', turn_id: 'failed-turn' });
            mocks.eventHandler!({ type: 'task_complete', status: 'failed', error: {
                message: 'Selected model is at capacity. Please try a different model.', codexErrorInfo: 'serverOverloaded',
            } });
            return { aborted: false };
        }).mockImplementationOnce(async () => {
            mocks.eventHandler!({ type: 'task_started', turn_id: 'retry-turn' });
            mocks.eventHandler!({ type: 'task_complete', status: 'completed' });
            return { aborted: false };
        });
        await runCodex({ credentials, startedBy: 'daemon' });
        expect(mocks.notify.mock.calls.map(([event]) => event.kind)).toEqual(['failed', 'done']);
        expect(mocks.notify.mock.calls[0][0].data.errorCode).toBe('serverOverloaded');
    });

    it('does not send a success notification for a user cancellation', async () => {
        mocks.waitForMessage.mockResolvedValueOnce({ message: 'Continue', mode: { permissionMode: 'yolo' }, hash: 'test', isolate: false });
        mocks.sendTurn.mockImplementationOnce(async () => {
            mocks.eventHandler!({ type: 'task_started' });
            mocks.eventHandler!({ type: 'turn_aborted' });
            return { aborted: true };
        });
        await runCodex({ credentials, startedBy: 'daemon' });
        expect(mocks.notify).not.toHaveBeenCalled();
    });

    it('does not let legacy intervention state suppress completion', async () => {
        mocks.session.getAgentState.mockReturnValue({ humanIntervention: { id: 'local-1' } });
        mocks.waitForMessage.mockResolvedValueOnce({ message: 'Continue', mode: { permissionMode: 'yolo' }, hash: 'test', isolate: false });
        mocks.sendTurn.mockImplementationOnce(async () => {
            mocks.eventHandler!({ type: 'task_started', turn_id: 'waiting-turn' });
            mocks.eventHandler!({ type: 'task_complete', status: 'completed' });
            return { aborted: false };
        });
        await runCodex({ credentials, startedBy: 'daemon' });
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'done' }));
    });

    it('marks an unexpected exception as failure and closes the active UI turn', async () => {
        mocks.waitForMessage.mockResolvedValueOnce({ message: 'Continue', mode: { permissionMode: 'yolo' }, hash: 'test', isolate: false });
        mocks.sendTurn.mockImplementationOnce(async () => {
            mocks.eventHandler!({ type: 'task_started' });
            throw new Error('Codex app-server exited unexpectedly');
        });
        await runCodex({ credentials, startedBy: 'daemon' });
        expect(mocks.notify).toHaveBeenCalledOnce();
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', data: expect.objectContaining({ errorCode: 'executionError' }) }));
        expect(mocks.session.sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({
            ev: { t: 'turn-end', status: 'failed', errorCode: 'executionError' },
        }));
    });
});
