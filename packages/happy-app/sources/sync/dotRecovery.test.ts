import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/auth/tokenStorage', () => ({ TokenStorage: { getCredentials: async () => ({ token: 'account-token' }) } }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://relay.example/home-relay' }));
import { recoverDot } from './dotRecovery';
afterEach(() => vi.unstubAllGlobals());
it('works with the native AbortSignal implementation that has no timeout static method', async () => {
    vi.stubGlobal('AbortSignal', {});
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'starting', sessionId: 'session' }, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await expect(recoverDot({ workspaceId: 'workspace', dotId: 'dot', sessionId: 'session' })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('https://relay.example/home-relay/v1/dots/recover', expect.objectContaining({
        method: 'POST', signal: expect.objectContaining({ aborted: false }),
    }));
});
