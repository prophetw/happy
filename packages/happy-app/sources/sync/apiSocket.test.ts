import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Encryption } from './encryption/encryption';

const mocks = vi.hoisted(() => ({
    socket: { on: vi.fn(), onAny: vi.fn(), disconnect: vi.fn(), timeout: vi.fn() },
    replyAfterMs: null as number | null,
}));

vi.mock('socket.io-client', () => ({ io: () => mocks.socket }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: 'test' } } }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({}) } }));

import { apiSocket } from './apiSocket';

function callMachine(method: string) {
    // Capture rejections immediately so advancing timers cannot produce an
    // unhandled rejection before the test inspects the RPC result.
    return apiSocket.machineRPC('machine-1', method, {}).then(
        value => ({ value }),
        error => ({ error: error.message }),
    );
}

describe('App RPC startup deadlines', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.replyAfterMs = null;
        mocks.socket.timeout.mockImplementation((ms: number) => ({
            emitWithAck: () => new Promise((resolve, reject) => {
                const deadline = setTimeout(() => reject(new Error('ack timed out')), ms);
                if (mocks.replyAfterMs !== null) {
                    setTimeout(() => {
                        clearTimeout(deadline);
                        resolve({ ok: true, result: { type: 'success', sessionId: 'happy-claude' } });
                    }, mocks.replyAfterMs);
                }
            }),
        }));
        apiSocket.initialize({ endpoint: 'https://relay.test', token: 'test-token' }, {
            getMachineEncryption: () => ({ encryptRaw: async (value: unknown) => value, decryptRaw: async (value: unknown) => value }),
        } as unknown as Encryption);
    });

    afterEach(() => {
        apiSocket.disconnect();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it.each(['spawn-happy-session', 'resume-happy-session'])('waits through reconnection and slow %s', async (method) => {
        // 14s for daemon reconnection, then 40s to create/register the session.
        mocks.replyAfterMs = 54_000;
        const result = callMachine(method);
        await vi.advanceTimersByTimeAsync(54_000);
        expect(await result).toEqual({ value: { type: 'success', sessionId: 'happy-claude' } });
    });

    it('bounds a startup whose socket never acknowledges', async () => {
        let completed = false;
        const result = callMachine('spawn-happy-session').then(value => { completed = true; return value; });
        await vi.advanceTimersByTimeAsync(69_999);
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toEqual({ error: 'The computer did not respond' });
    });

    it('keeps ordinary machine RPCs bounded at 50 seconds', async () => {
        mocks.replyAfterMs = 54_000;
        const result = callMachine('bash');
        await vi.advanceTimersByTimeAsync(50_000);
        expect(await result).toEqual({ error: 'The computer did not respond' });
    });
});
