import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';

vi.mock('@/utils/log', () => ({ log: vi.fn() }));

import { rpcHandler } from './rpcHandler';

/** Socket.IO transport fixture: a reply competes with the selected ack deadline. */
function callRpc(method: string, options: {
    replyAfterMs?: number;
    reconnectAfterMs?: number;
    disconnectAfterMs?: number;
} = {}) {
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const socket = { id: 'caller', on: (event: string, handler: any) => handlers.set(event, handler) };
    const startedAt = Date.now();
    const target = {
        id: 'daemon',
        timeout: (ms: number) => ({
            emitWithAck: () => new Promise((resolve, reject) => {
                const deadline = setTimeout(() => reject(new Error('operation has timed out')), ms);
                if (options.replyAfterMs !== undefined) {
                    setTimeout(() => {
                        clearTimeout(deadline);
                        resolve('encrypted-session-result');
                    }, options.replyAfterMs);
                }
            }),
        }),
    };
    const io = {
        in: () => ({ timeout: () => ({ fetchSockets: async () => {
            const elapsed = Date.now() - startedAt;
            if (elapsed < (options.reconnectAfterMs ?? 0)) return [];
            if (options.disconnectAfterMs !== undefined && elapsed >= options.disconnectAfterMs) return [];
            return [target];
        } }) }),
    };
    rpcHandler('user-1', socket as unknown as Socket, io as unknown as Server);
    const reply = vi.fn();
    const done = handlers.get('rpc-call')!({ method: `machine-1:${method}`, params: 'encrypted-request' }, reply);
    return { done, reply };
}

describe('RPC session startup deadlines', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

    it.each(['spawn-happy-session', 'resume-happy-session'])('relays a slow %s result', async (method) => {
        const { done, reply } = callRpc(method, { replyAfterMs: 40_000 });
        await vi.advanceTimersByTimeAsync(40_000);
        await done;
        expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: true, result: 'encrypted-session-result' });
    });

    it('allows daemon reconnection followed by a slow startup', async () => {
        const { done, reply } = callRpc('spawn-happy-session', { reconnectAfterMs: 14_000, replyAfterMs: 40_000 });
        await vi.advanceTimersByTimeAsync(54_000);
        await done;
        expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: true, result: 'encrypted-session-result' });
    });

    it('still times out a startup that never answers', async () => {
        const { done, reply } = callRpc('spawn-happy-session');
        await vi.advanceTimersByTimeAsync(49_999);
        expect(reply).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await done;
        expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'operation has timed out' });
    });

    it('keeps the ordinary RPC deadline at 30 seconds', async () => {
        const { done, reply } = callRpc('bash', { replyAfterMs: 40_000 });
        await vi.advanceTimersByTimeAsync(30_000);
        await done;
        expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'operation has timed out' });
    });

    it('still fails promptly when the daemon disappears during startup', async () => {
        const { done, reply } = callRpc('spawn-happy-session', { disconnectAfterMs: 1_000 });
        await vi.advanceTimersByTimeAsync(4_000);
        await done;
        expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'RPC target disconnected' });
    });
});
