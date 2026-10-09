import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC } = vi.hoisted(() => ({ machineRPC: vi.fn() }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));

import { machineListDirectory } from './ops';

describe('machine directory operation', () => {
    beforeEach(() => vi.clearAllMocks());

    it('uses the chosen machine encrypted RPC without needing a session', async () => {
        const response = { success: true, entries: [{ name: 'repo', type: 'directory' }] };
        machineRPC.mockResolvedValue(response);
        expect(await machineListDirectory('wsl-machine', '/home/dev/code')).toEqual(response);
        expect(machineRPC).toHaveBeenCalledExactlyOnceWith('wsl-machine', 'listDirectory', { path: '/home/dev/code' });
    });

    it('preserves filesystem failures', async () => {
        machineRPC.mockResolvedValue({ success: false, error: 'Permission denied' });
        expect(await machineListDirectory('machine', '/private')).toEqual({ success: false, error: 'Permission denied' });
    });

    it('returns transport failures so the picker can retry', async () => {
        machineRPC.mockRejectedValue(new Error('Machine offline'));
        expect(await machineListDirectory('machine', '/repo')).toEqual({ success: false, error: 'Machine offline' });
    });
});
