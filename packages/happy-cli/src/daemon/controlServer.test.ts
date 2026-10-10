import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';

const mocks = vi.hoisted(() => ({ port: 0, startupFailed: vi.fn(), started: vi.fn() }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));
vi.mock('@/persistence', () => ({
    readDaemonState: async () => ({ pid: process.pid, httpPort: mocks.port }),
    clearDaemonState: vi.fn(),
}));

import { startDaemonControlServer } from './controlServer';
import { notifyDaemonSessionStarted, notifyDaemonSessionStartupFailed } from './controlClient';

describe('daemon startup notifications over HTTP', () => {
    let server: Awaited<ReturnType<typeof startDaemonControlServer>>;

    beforeEach(async () => {
        vi.clearAllMocks();
        server = await startDaemonControlServer({
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
});
