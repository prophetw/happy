import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createApi: vi.fn(),
    connect: vi.fn(),
    resumeThread: vi.fn(),
    disconnect: vi.fn(),
    notifyStarted: vi.fn(),
    notifyFailed: vi.fn(),
    waitForMessage: vi.fn(),
    session: {
        sessionId: 'happy-resumed',
        onUserMessage: vi.fn(),
        onFileEvent: vi.fn(),
        keepAlive: vi.fn(),
        updateMetadata: vi.fn(),
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
    setupOfflineReconnection: () => ({ session: mocks.session }),
}));
vi.mock('@/utils/serverConnectionErrors', () => ({ connectionState: { setBackend: vi.fn() } }));
vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: class {
        waitForMessagesAndGetAsString = mocks.waitForMessage;
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
        setEventHandler = vi.fn();
    },
}));
vi.mock('./utils/permissionHandler', () => ({ CodexPermissionHandler: class { reset = vi.fn(); } }));
vi.mock('./utils/reasoningProcessor', () => ({ ReasoningProcessor: class {} }));
vi.mock('./utils/diffProcessor', () => ({ DiffProcessor: class {} }));
vi.mock('./codexSkills', () => ({ discoverCodexSkillCommands: async () => [] }));

import { runCodex } from './runCodex';

const credentials = { token: 'test-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };

describe('Codex resume startup readiness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', '');
        vi.stubEnv('HAPPY_FORK_CODEX_THREAD_ID', '');
        mocks.createApi.mockResolvedValue({
            getOrCreateMachine: vi.fn().mockResolvedValue({}),
            getOrCreateSession: vi.fn().mockResolvedValue({
                id: 'happy-resumed',
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
                seq: 0, metadataVersion: 0, agentStateVersion: 0,
            }),
        });
        mocks.connect.mockResolvedValue(undefined);
        mocks.resumeThread.mockResolvedValue({ threadId: 'native-thread', model: 'gpt-5.6-sol' });
        mocks.disconnect.mockResolvedValue(undefined);
        mocks.notifyStarted.mockResolvedValue({ status: 'ok' });
        mocks.notifyFailed.mockResolvedValue({ status: 'ok' });
        mocks.waitForMessage.mockResolvedValue(null);
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

    it('keeps normal new-session registration unchanged', async () => {
        await runCodex({ credentials, startedBy: 'daemon' });
        expect(mocks.notifyStarted).toHaveBeenCalledOnce();
        expect(mocks.resumeThread).not.toHaveBeenCalled();
        expect(mocks.notifyFailed).not.toHaveBeenCalled();
    });
});
