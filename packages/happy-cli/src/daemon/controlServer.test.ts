import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';

const mocks = vi.hoisted(() => ({ port: 0, startupFailed: vi.fn(), started: vi.fn(), binding: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('./automationCreate', () => ({ readAutomationCreateBinding: mocks.binding }));
vi.mock('@/persistence', () => ({
    readDaemonState: async () => ({ pid: process.pid, httpPort: mocks.port }),
    clearDaemonState: vi.fn(),
}));

import { startDaemonControlServer } from './controlServer';
import { notifyDaemonSessionStarted, notifyDaemonSessionStartupFailed } from './controlClient';

describe('daemon startup notifications over HTTP', () => {
    let server: Awaited<ReturnType<typeof startDaemonControlServer>>;
    let machineVerified: boolean;

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.binding.mockReset();
        mocks.started.mockReset();
        machineVerified = true;
        server = await startDaemonControlServer({
            isMachineVerified: () => machineVerified,
            getChildren: () => [],
            stopSession: () => false,
            spawnSession: async () => ({ type: 'error', errorMessage: 'unused' }),
            requestShutdown: vi.fn(),
            onHappySessionWebhook: mocks.started,
            onHappySessionStartupFailed: mocks.startupFailed,
        });
        mocks.port = server.port;
    });

    afterEach(async () => { await server.stop(); });

    it('keeps the owner visible to older CLIs while rejecting session writes until verification', async () => {
        machineVerified = false;
        const post = (path: string, body: object) => fetch(`http://127.0.0.1:${server.port}${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        expect((await post('/list', {})).status).toBe(200);
        expect(await (await post('/status', {})).json()).toMatchObject({connected:false});
        expect((await post('/spawn-session', {directory:'/tmp'})).status).toBe(503);
        const report = {pid:42,errorMessage:'fixture'};
        expect((await post('/session-startup-failed', report)).status).toBe(503);
        expect(mocks.startupFailed).not.toHaveBeenCalled();
        machineVerified = true;
        expect((await post('/session-startup-failed', report)).status).toBe(200);
        expect(mocks.startupFailed).toHaveBeenCalledOnce();
    });

    it('delivers the provider startup error without registering a ready session', async () => {
        const errorMessage = 'Codex thread native-thread already has an active writer';
        expect(await notifyDaemonSessionStartupFailed(12345, errorMessage)).toEqual({ status: 'ok' });
        expect(mocks.startupFailed).toHaveBeenCalledWith(12345, errorMessage);
        expect(mocks.started).not.toHaveBeenCalled();
    });

    it('rejects invalid startup failure reports', async () => {
        const response = await fetch(`http://127.0.0.1:${server.port}/session-startup-failed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pid: -1, errorMessage: '' }),
        });
        expect(response.status).toBe(400);
        expect(mocks.startupFailed).not.toHaveBeenCalled();
    });

    it('continues to register a ready session through the existing notification', async () => {
        const metadata = { hostPid: 12345, codexThreadId: 'native-thread' } as Metadata;
        expect(await notifyDaemonSessionStarted('happy-resumed', metadata)).toEqual({ status: 'ok' });
        expect(mocks.started).toHaveBeenCalledWith('happy-resumed', metadata, undefined);
        expect(mocks.startupFailed).not.toHaveBeenCalled();
    });

    it('accepts a bound registration only when the daemon acknowledges the exact launch', async () => {
        const binding = { requestID: 'request-a', launchID: 'ad78efc0-ec23-49e8-b78c-a458771ea7f6' };
        const metadata = { hostPid: 12345 } as Metadata;
        mocks.binding.mockReturnValue(binding);
        mocks.started.mockReturnValue(true);
        expect(await notifyDaemonSessionStarted('session-a', metadata)).toEqual({ status: 'ok', automationCreate: binding });
        expect(mocks.started).toHaveBeenCalledExactlyOnceWith('session-a', metadata, undefined, binding);

        vi.useFakeTimers();
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ status: 'ok' }));
        try {
            const oldOwner = notifyDaemonSessionStarted('session-a', metadata);
            await vi.advanceTimersByTimeAsync(3100);
            expect(await oldOwner).toEqual({ error: 'Automation create registration was not acknowledged' });
            expect(fetch.mock.calls.length).toBeGreaterThan(1);
        } finally {
            fetch.mockRestore();
            vi.useRealTimers();
        }
    });
});
