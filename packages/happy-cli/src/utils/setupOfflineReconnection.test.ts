import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnReconnected: (() => Promise<unknown>) | null = null;
const mocks = vi.hoisted(() => ({ binding: vi.fn(), report: vi.fn() }));

vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://server.test' },
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    startOfflineReconnection: (config: { onReconnected: () => Promise<unknown> }) => {
        capturedOnReconnected = config.onReconnected;
        return { cancel: () => {}, getSession: () => null, isReconnected: () => false };
    },
}));
vi.mock('@/daemon/automationCreate', () => ({ readAutomationCreateBinding: mocks.binding }));
vi.mock('@/daemon/controlClient', () => ({ notifyDaemonSessionStarted: mocks.report }));

import { setupOfflineReconnection } from './setupOfflineReconnection';

function makeRealSession() {
    return {
        sessionId: 'real-session',
        onUserMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    };
}

function setupOffline(realSession: ReturnType<typeof makeRealSession>, onSessionSwap = vi.fn()) {
    const api = {
        getOrCreateSession: vi.fn().mockResolvedValue({ id: 'real-session', encryptionKey: Uint8Array.of(1, 2, 3),
            encryptionVariant: 'dataKey', seq: 2, metadataVersion: 3, agentStateVersion: 4 }),
        sessionSyncClient: vi.fn().mockReturnValue(realSession),
    };
    const result = setupOfflineReconnection({
        api: api as any,
        sessionTag: 'tag-1',
        metadata: {} as any,
        state: {} as any,
        response: null,
        onSessionSwap,
    });
    return { result, onSessionSwap, api };
}

describe('setupOfflineReconnection', () => {
    beforeEach(() => {
        capturedOnReconnected = null;
        mocks.binding.mockReset();
        mocks.report.mockReset().mockResolvedValue({});
    });

    it('re-attaches the user message handler registered while offline', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const handler = vi.fn();

        result.session.onUserMessage(handler);
        await capturedOnReconnected!();

        expect(realSession.onUserMessage).toHaveBeenCalledWith(handler);
    });

    it('re-registers RPC handlers registered while offline', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const abort = vi.fn();
        const kill = vi.fn();

        result.session.rpcHandlerManager.registerHandler('abort', abort);
        result.session.rpcHandlerManager.registerHandler('killSession', kill);
        await capturedOnReconnected!();

        expect(realSession.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', abort);
        expect(realSession.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('killSession', kill);
    });

    it('attaches handlers before handing the real session to the caller', async () => {
        const realSession = makeRealSession();
        const order: string[] = [];
        realSession.onUserMessage.mockImplementation(() => order.push('attach'));
        const { result } = setupOffline(realSession, vi.fn(() => order.push('swap')));

        result.session.onUserMessage(vi.fn());
        await capturedOnReconnected!();

        expect(order).toEqual(['attach', 'swap']);
        expect(mocks.report).not.toHaveBeenCalled();
    });

    it('reports the real automation session after a successful swap even if the initial launch returned offline', async () => {
        mocks.binding.mockReturnValue({ requestID: 'receipt', launchID: 'automation-launch' });
        mocks.report.mockRejectedValue(new Error('lost daemon acknowledgement'));
        const realSession = makeRealSession();
        const { api, onSessionSwap } = setupOffline(realSession);

        await expect(capturedOnReconnected!()).resolves.toBe(realSession);
        expect(onSessionSwap).toHaveBeenCalledWith(realSession);
        expect(mocks.report).toHaveBeenCalledWith('real-session', {}, { encryptionKey: 'AQID', encryptionVariant: 'dataKey',
            seq: 2, metadataVersion: 3, agentStateVersion: 4 });
        expect(api.getOrCreateSession).toHaveBeenCalledOnce();
    });

    it('re-attaches only the latest user message handler', async () => {
        const realSession = makeRealSession();
        const { result } = setupOffline(realSession);
        const first = vi.fn();
        const second = vi.fn();

        result.session.onUserMessage(first);
        result.session.onUserMessage(second);
        await capturedOnReconnected!();

        expect(realSession.onUserMessage).toHaveBeenCalledTimes(1);
        expect(realSession.onUserMessage).toHaveBeenCalledWith(second);
    });
});
