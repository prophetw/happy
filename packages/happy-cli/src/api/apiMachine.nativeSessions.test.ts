import { beforeEach, describe, expect, it, vi } from 'vitest';

const { methods } = vi.hoisted(() => ({
    methods: { connect: vi.fn(), disconnect: vi.fn(), listThreads: vi.fn() },
}));

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn().mockImplementation(() => methods),
}));

async function listHandler() {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', {
        id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
    } as any);
    client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
    return (client as any).rpcHandlerManager.handlers.get('machine-1:codex-list-native-sessions');
}

describe('native Codex session machine RPC', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        methods.connect.mockResolvedValue(undefined);
        methods.disconnect.mockResolvedValue(undefined);
        methods.listThreads.mockResolvedValue({ data: [], nextCursor: null });
    });

    it('returns the host thread list and closes its temporary app-server client', async () => {
        methods.listThreads.mockResolvedValue({
            data: [{ id: 'native-thread', cwd: '/repo', preview: 'hello', createdAt: 1, updatedAt: 2 }],
            nextCursor: null,
        });
        const handler = await listHandler();
        expect(await handler({ directory: '/repo' })).toEqual({
            type: 'success',
            sessions: [{ sessionId: 'native-thread', cwd: '/repo', gitBranch: null, firstUserMessage: 'hello', summary: null, timestamp: 2000 }],
        });
        expect(methods.listThreads).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo' }));
        expect(methods.connect).toHaveBeenCalledOnce();
        expect(methods.disconnect).toHaveBeenCalledOnce();
    });

    it.each([null, '', ' ', 123])('rejects invalid directory filters (%s)', async (directory) => {
        const handler = await listHandler();
        await expect(handler({ directory })).rejects.toThrow('directory must be a non-empty string');
        expect(methods.connect).not.toHaveBeenCalled();
    });

    it('closes the app-server client even if the thread list request fails', async () => {
        methods.listThreads.mockRejectedValue(new Error('Codex history unavailable'));
        const handler = await listHandler();
        await expect(handler({})).rejects.toThrow('Codex history unavailable');
        expect(methods.disconnect).toHaveBeenCalledOnce();
    });
});
