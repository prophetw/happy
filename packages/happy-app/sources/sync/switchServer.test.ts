import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    credentials: [] as Array<{ token: string; secret: string }>,
    url: 'https://old.test', events: [] as string[],
    authenticate: vi.fn(), cleanup: vi.fn(), reload: vi.fn(),
    connect: vi.fn(), disconnect: vi.fn(), machineRPC: vi.fn(),
    queue: vi.fn(), undo: vi.fn(), start: vi.fn(),
    encryption: {
        getMachineDataKey: () => new Uint8Array(32).fill(1),
        getSessionDataKey: () => new Uint8Array(32).fill(2),
    },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'switch-1' }));
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: {
    setCredentials: async (credentials: { token: string; secret: string }) => {
        mocks.events.push('credentials'); mocks.credentials.push(credentials); return true;
    },
} }));
vi.mock('@/auth/authGetToken', () => ({ authGetToken: mocks.authenticate }));
vi.mock('./serverConfig', () => ({
    getServerUrl: () => mocks.url,
    getDefaultServerUrl: () => 'https://default.test',
    setServerUrl: (url: string | null) => { mocks.url = url ?? 'https://default.test'; },
}));
vi.mock('./sync', () => ({ sync: { encryption: mocks.encryption } }));
vi.mock('./relayMigrations', () => ({ queueRelayMigrations: mocks.queue, startRelayMigrations: mocks.start }));
vi.mock('./storage', () => ({ storage: { getState: () => ({
    machines: { online: { id: 'online', active: true }, offline: { id: 'offline', active: false } },
    sessions: { running: { id: 'running', active: true }, history: { id: 'history', active: false } },
}) } }));
vi.mock('./apiSocket', () => ({ apiSocket: {
    machineRPC: mocks.machineRPC, connect: mocks.connect, disconnect: mocks.disconnect,
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
        mocks.credentials.length = mocks.events.length = 0;
        mocks.authenticate.mockResolvedValue('new-token');
        mocks.cleanup.mockResolvedValue(undefined);
        mocks.reload.mockImplementation(async () => { mocks.events.push('reload'); });
        mocks.queue.mockImplementation(async () => { mocks.events.push('queue'); return mocks.undo; });
        mocks.machineRPC.mockRejectedValue(new Error('The computer did not respond'));
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ liveSwitch: 1 }) })));
    });

    it('switches the app when a computer cannot respond, without requiring old sessions to be ended', async () => {
        await expect(switchServer('https://new.test', oldCredentials, mocks.reload)).resolves.toBeUndefined();
        expect(mocks.url).toBe('https://new.test');
        expect(mocks.reload).toHaveBeenCalledWith({ token: 'new-token', secret: oldCredentials.secret });
        expect(mocks.machineRPC).not.toHaveBeenCalled();
        expect(mocks.queue).toHaveBeenCalledOnce();
    });

    it('persists active-device migration work before saving the new login, preserving account and per-device keys', async () => {
        await switchServer('https://new.test/relay/', oldCredentials, mocks.reload);
        expect(mocks.authenticate).toHaveBeenCalledWith(new Uint8Array(32).fill(255), 'https://new.test/relay');
        expect(mocks.queue).toHaveBeenCalledWith({
            id: 'switch-1',
            source: { serverUrl: 'https://old.test', token: 'old-token' },
            target: { serverUrl: 'https://new.test/relay', token: 'new-token' },
            encryption: mocks.encryption,
            participants: [
                { kind: 'machine', entityId: 'online', name: 'online', dataKey: Buffer.alloc(32, 1).toString('base64') },
                { kind: 'session', entityId: 'running', name: 'running', dataKey: Buffer.alloc(32, 2).toString('base64') },
            ],
        });
        expect(mocks.events).toEqual(['queue', 'credentials', 'reload']);
        expect(mocks.url).toBe('https://new.test/relay');
    });

    it('does not wait for an unavailable old relay to clear its push registration', async () => {
        mocks.cleanup.mockReturnValue(new Promise(() => {}));
        await switchServer('https://new.test', oldCredentials, mocks.reload);
        expect(mocks.reload).toHaveBeenCalledOnce();
        expect(mocks.url).toBe('https://new.test');
    });

    it('restores the original login, address and pending work if reload fails', async () => {
        mocks.reload.mockRejectedValue(new Error('reload failed'));
        await expect(switchServer('https://new.test', oldCredentials, mocks.reload)).rejects.toThrow('reload failed');
        expect(mocks.url).toBe('https://old.test');
        expect(mocks.credentials.at(-1)).toEqual(oldCredentials);
        expect(mocks.undo).toHaveBeenCalledOnce();
        expect(mocks.start).toHaveBeenCalledWith(mocks.encryption, 'https://old.test');
        expect(mocks.connect).toHaveBeenCalledOnce();
    });

    it('keeps the old login if migration work cannot be saved', async () => {
        mocks.queue.mockRejectedValue(new Error('Storage unavailable'));
        await expect(switchServer('https://new.test', oldCredentials, mocks.reload)).rejects.toThrow('Storage unavailable');
        expect(mocks.credentials).toEqual([]);
        expect(mocks.reload).not.toHaveBeenCalled();
        expect(mocks.url).toBe('https://old.test');
    });

    it('does not queue devices or save a new login if target authentication fails', async () => {
        mocks.authenticate.mockRejectedValue(new Error('HTTP 403'));
        await expect(switchServer('https://new.test', oldCredentials, mocks.reload)).rejects.toThrow('HTTP 403');
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.credentials).toEqual([]);
        expect(mocks.url).toBe('https://old.test');
    });

    it('restores the default server through the same automatic migration flow', async () => {
        await switchServer(null, oldCredentials, mocks.reload);
        expect(mocks.queue.mock.calls[0][0].target.serverUrl).toBe('https://default.test');
        expect(mocks.url).toBe('https://default.test');
    });
});
