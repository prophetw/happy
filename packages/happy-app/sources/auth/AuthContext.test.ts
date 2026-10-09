import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    events: [] as string[],
    removed: true,
    unregister: vi.fn(),
    disconnect: vi.fn(),
    reload: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, DevSettings: { reload: vi.fn() } }));
vi.mock('expo-updates', () => ({ reloadAsync: vi.fn() }));
vi.mock('@/track', () => ({ trackLogout: vi.fn() }));
vi.mock('@/sync/sync', () => ({ syncCreate: vi.fn() }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { disconnect: mocks.disconnect } }));
vi.mock('@/sync/persistence', () => ({
    loadRegisteredPushToken: () => 'old-push-token',
    clearPersistence: () => mocks.events.push('clear-persistence'),
}));
vi.mock('@/sync/apiPush', () => ({ unregisterPushToken: mocks.unregister }));
vi.mock('./tokenStorage', () => ({ TokenStorage: {
    setCredentials: vi.fn(),
    removeCredentials: async () => { mocks.events.push('remove-credentials'); return mocks.removed; },
} }));

import { AuthProvider, useAuth } from './AuthContext';

let auth: ReturnType<typeof useAuth>;
let renderer: ReturnType<typeof create>;
const credentials = { token: 'old-token', secret: 'old-secret' };
function CaptureAuth() { auth = useAuth(); return null; }

beforeEach(async () => {
    mocks.events.length = 0;
    mocks.removed = true;
    mocks.unregister.mockReset().mockImplementation(async () => { mocks.events.push('unregister-old-server'); });
    mocks.disconnect.mockReset().mockImplementation(() => { mocks.events.push('disconnect'); });
    mocks.reload.mockReset().mockImplementation(() => { mocks.events.push('reload'); });
    vi.stubGlobal('window', { location: { reload: mocks.reload } });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    await act(async () => {
        renderer = create(React.createElement(AuthProvider, { initialCredentials: credentials, children: React.createElement(CaptureAuth) }));
    });
});
afterEach(async () => { await act(async () => renderer.unmount()); vi.unstubAllGlobals(); });

describe('server changes during logout', () => {
    it('cleans up against the old server before changing configuration and reloading', async () => {
        await act(async () => auth.logout({ beforeReload: () => { mocks.events.push('change-server'); } }));
        expect(mocks.unregister).toHaveBeenCalledWith(credentials, 'old-push-token');
        expect(mocks.events).toEqual([
            'unregister-old-server', 'clear-persistence', 'remove-credentials',
            'disconnect', 'change-server', 'reload',
        ]);
        expect(auth.credentials).toBeNull();
        expect(auth.isAuthenticated).toBe(false);
    });

    it('keeps ordinary logout behavior when no server change is requested', async () => {
        await act(async () => auth.logout());
        expect(mocks.events).toEqual(['unregister-old-server', 'clear-persistence', 'remove-credentials', 'reload']);
        expect(mocks.disconnect).not.toHaveBeenCalled();
    });

    it('does not switch servers when stored credentials cannot be cleared', async () => {
        mocks.removed = false;
        const change = vi.fn();
        await act(async () => {
            await expect(auth.logout({ beforeReload: change })).rejects.toThrow('Failed to clear authentication tokens');
        });
        expect(change).not.toHaveBeenCalled();
        expect(mocks.reload).not.toHaveBeenCalled();
    });
});
