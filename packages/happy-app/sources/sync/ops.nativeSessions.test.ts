import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(), refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('./sync', () => ({ sync: { refreshSessions } }));
vi.mock('./storage', () => ({ storage: { getState: vi.fn(() => ({ sessions: {} })) } }));

import { codexListNativeSessions, resumeNativeCodexSession } from './ops';

describe('native Codex session operations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        refreshSessions.mockResolvedValue(undefined);
    });

    it('lists the requested machine native conversations with an optional directory filter', async () => {
        const result = { type: 'success', sessions: [{ sessionId: 'thread-1', cwd: '/repo' }] };
        machineRPC.mockResolvedValue(result);
        expect(await codexListNativeSessions({ machineId: 'machine-1', directory: '/repo' })).toEqual(result);
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'codex-list-native-sessions', { directory: '/repo' });
    });

    it('surfaces encrypted daemon failures and transport failures as list errors', async () => {
        machineRPC.mockResolvedValue({ error: 'Codex not installed' });
        expect(await codexListNativeSessions({ machineId: 'machine-1' })).toEqual({ type: 'error', errorMessage: 'Codex not installed' });
        machineRPC.mockRejectedValue(new Error('Machine offline'));
        expect(await codexListNativeSessions({ machineId: 'machine-1' })).toEqual({ type: 'error', errorMessage: 'Machine offline' });
    });

    it('attaches to the selected existing thread in its own directory and refreshes sessions', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-resumed' });
        expect(await resumeNativeCodexSession({ machineId: 'machine-1', directory: '/repo', codexThreadId: 'native-thread' })).toEqual({ type: 'success', sessionId: 'happy-resumed' });
        expect(machineRPC).toHaveBeenCalledOnce();
        expect(machineRPC).toHaveBeenCalledWith('machine-1', 'spawn-happy-session', expect.objectContaining({
            agent: 'codex', directory: '/repo', resumeCodexThreadId: 'native-thread', approvedNewDirectoryCreation: false,
        }));
        expect(refreshSessions).toHaveBeenCalledOnce();
    });

    it('returns launch errors without refreshing or substituting a new thread', async () => {
        machineRPC.mockResolvedValue({ type: 'error', errorMessage: 'Saved session path does not exist' });
        expect(await resumeNativeCodexSession({ machineId: 'machine-1', directory: '/missing', codexThreadId: 'native-thread' })).toEqual({ type: 'error', errorMessage: 'Saved session path does not exist' });
        expect(refreshSessions).not.toHaveBeenCalled();
    });

    it('keeps a successful resume when the best-effort refresh fails', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-resumed' });
        refreshSessions.mockRejectedValue(new Error('Sync offline'));
        expect(await resumeNativeCodexSession({ machineId: 'machine-1', directory: '/repo', codexThreadId: 'native-thread' })).toEqual({ type: 'success', sessionId: 'happy-resumed' });
    });
});
