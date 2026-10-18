import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    credentials: [] as Array<{ token: string; secret: string }>,
    url: 'https://old.test', phases: [] as string[],
    authenticate: vi.fn(), cleanup: vi.fn(), reload: vi.fn(),
    connect: vi.fn(), disconnect: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'switch-1' }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {
    setCredentials: async (credentials: { token: string; secret: string }) => { mocks.credentials.push(credentials); return true; },
} }));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: mocks.authenticate }));
vi.mock('./serverConfig', () => ({
    getServerUrl: () => mocks.url,
    getDefaultServerUrl: () => 'https://default.test',
    setServerUrl: (url: string | null) => { mocks.url = url ?? 'https://default.test'; },
}));
vi.mock('./storage', () => ({ storage: { getState: () => ({
    machines: { online: { id: 'online', active: true }, offline: { id: 'offline', active: false } },
    sessions: { running: { id: 'running', active: true }, history: { id: 'history', active: false } },
}) } }));
vi.mock('./apiSocket', () => ({ apiSocket: {
    machineRPC: async (id: string, _method: string, request: { phase: string }) => { mocks.phases.push(`${id}:${request.phase}`); return { success: true }; },
    sessionRPC: async (id: string, _method: string, request: { phase: string }) => { mocks.phases.push(`${id}:${request.phase}`); return { success: true }; },
    connect: mocks.connect, disconnect: mocks.disconnect,
} }));
vi.mock('./persistence', () => ({ loadRegisteredPushToken: () => 'push-token', clearRelayPersistence: vi.fn() }));
vi.mock('./apiPush', () => ({ unregisterPushTokenOnce: mocks.cleanup }));
vi.mock('socket.io-client', () => ({ io: () => {
    const handlers = new Map<string, () => void>();
    return { once: (event: string, handler: () => void) => handlers.set(event, handler), connect: () => handlers.get('connect')?.(), disconnect: () => {} };
} }));
import { switchServer } from './switchServer';

const oldCredentials = { token: 'old-token', secret: '__________________________________________8' };
describe('App server switching', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.url = 'https://old.test';
        mocks.credentials.length = mocks.phases.length = 0;
        mocks.authenticate.mockResolvedValue('new-token');
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.reload.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ liveSwitch: 1 }) })));
    });

    it('keeps the account key and moves online devices without touching offline devices or history', async () => {
        await switchServer('https://new.test/relay/', oldCredentials, mocks.reload);
        expect(mocks.reload).toHaveBeenCalledWith({ token: 'new-token', secret: oldCredentials.secret });
        expect(mocks.authenticate).toHaveBeenCalledWith(new Uint8Array(32).fill(255), 'https://new.test/relay');
        expect(mocks.url).toBe('https://new.test/relay');
        expect(mocks.phases).toContain('running:finish');
        expect(mocks.phases).toContain('online:finish');
        expect(mocks.phases.some(phase => /offline|history/.test(phase))).toBe(false);
    });

    it('finishes even when old push cleanup fails', async () => {
        mocks.cleanup.mockRejectedValue(new Error('old relay unavailable'));
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await switchServer('https://new.test', oldCredentials, mocks.reload);
            expect(mocks.reload).toHaveBeenCalledOnce();
            expect(mocks.cleanup).toHaveBeenCalledOnce();
            expect(mocks.url).toBe('https://new.test');
        } finally { warning.mockRestore(); }
    });

    it('restores the original login, address and device connections if reload fails', async () => {
        mocks.reload.mockRejectedValue(new Error('reload failed'));
        await expect(switchServer('https://new.test', oldCredentials, mocks.reload)).rejects.toThrow('reload failed');
        expect(mocks.url).toBe('https://old.test');
        expect(mocks.credentials.at(-1)).toEqual(oldCredentials);
        expect(mocks.phases).toContain('online:rollback');
        expect(mocks.phases).toContain('running:rollback');
        expect(mocks.connect).toHaveBeenCalledOnce();
    });
});
