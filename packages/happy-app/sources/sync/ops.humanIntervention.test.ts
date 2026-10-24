import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: rpc } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn() } }));
vi.mock('./rigComposer', () => ({ rigComposerSetMode: vi.fn() }));

import { sessionReplyHumanIntervention } from './ops';

beforeEach(() => rpc.mockReset());

describe('intervention reply RPC', () => {
    it('uses the separate intervention channel without any privilege or permission-mode payload', async () => {
        rpc.mockResolvedValue({ success: true });
        await sessionReplyHumanIntervention('session-1', 'request-1', 'resolved');
        expect(rpc).toHaveBeenCalledExactlyOnceWith('session-1', 'human-intervention', { id: 'request-1', status: 'resolved' });
    });

    it('surfaces stale requests and missing success acknowledgements for retry', async () => {
        rpc.mockResolvedValueOnce({ error: 'This request is no longer pending' }).mockResolvedValueOnce(undefined);
        await expect(sessionReplyHumanIntervention('s', 'old', 'cancelled')).rejects.toThrow('no longer pending');
        await expect(sessionReplyHumanIntervention('s', 'old', 'cancelled')).rejects.toThrow('Could not send');
    });
});
