import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceOwnerRpc } from './workspaceOwnerRpc';

const config = { url: 'http://127.0.0.1:18989/', origin: 'http://127.0.0.1:8989' };
afterEach(() => vi.unstubAllGlobals());

describe('paired Workspace Owner RPC', () => {
    it('only allows a locally configured Owner and fixed routes on the paired machine', async () => {
        expect(createWorkspaceOwnerRpc({ ...config, url: 'https://owner.example' }, 'machine', () => 'token')).toBeUndefined();
        expect(createWorkspaceOwnerRpc({ ...config, origin: 'http://127.0.0.1:8989/path' }, 'machine', () => 'token')).toBeUndefined();
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const handle = createWorkspaceOwnerRpc(config, 'machine', () => 'token')!;
        await expect(handle({ route: 'read', body: { action: 'inventory', machineID: 'other', projectID: 'p' } }))
            .resolves.toMatchObject({ status: 403, body: { error: { code: 'WORKSPACE_SCOPE_DENIED' } } });
        await expect(handle({ route: 'catalog', body: { token: 'caller' }, url: 'https://other.example/' }))
            .resolves.toMatchObject({ status: 400 });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses the daemon’s current Relay credential and returns the Owner’s denial', async () => {
        const body = { version: 1, ok: false, error: { code: 'WORKSPACE_SCOPE_DENIED' }, dispatch: 'not_started' };
        const fetch = vi.fn().mockResolvedValue({ status: 403, json: async () => body });
        vi.stubGlobal('fetch', fetch);
        let token = 'previous';
        const handle = createWorkspaceOwnerRpc(config, 'machine', () => token)!;
        token = 'current-daemon';
        await expect(handle({ route: 'catalog', body: {} })).resolves.toEqual({ status: 403, body });
        expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:18989/api/workspace-owner/v1/catalog',
            expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({
                Origin: config.origin, Authorization: 'Bearer current-daemon',
            }) }));
    });
});
