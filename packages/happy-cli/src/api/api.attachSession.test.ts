import { beforeEach, expect, it, vi } from 'vitest';
import { encrypt, encodeBase64 } from './encryption';
const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('axios', () => ({ default: { get: h.get, post: h.post } }));
import { ApiClient } from './api';
const key = new Uint8Array(32), metadata = { path: '/tmp', testloopDots: { dotId: 'dot', workspaceId: 'workspace' }, summary: { text: 'preserved' } };
const session = { id: 'session', metadata: encodeBase64(encrypt(key, 'dataKey', metadata)), metadataVersion: 2, agentStateVersion: 1, dataEncryptionKey: 'existing-key-envelope' };
const credentials = { token: 'synthetic', encryption: { type: 'legacy' as const, secret: key } };
const options = { sessionId: 'session', tag: 'testloop-dot:workspace:dot', encryptionKey: key, encryptionVariant: 'dataKey' as const, validateMetadata: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); h.get.mockResolvedValue({ data: { sessions: [session] } }); h.post.mockResolvedValue({ data: { session } }); });
it('reattaches the original identity/tag and preserves encrypted metadata and key', async () => {
    const api = await ApiClient.create(credentials, { serverUrl: 'http://127.0.0.1:1234' });
    const result = await api.attachSession(options);
    expect(result.metadata).toEqual(metadata);
    expect(h.post).toHaveBeenCalledWith('http://127.0.0.1:1234/v1/sessions', expect.objectContaining({ tag: options.tag, metadata: session.metadata, dataEncryptionKey: session.dataEncryptionKey }), expect.anything());
    expect(options.validateMetadata).toHaveBeenCalledWith(metadata);
});
it('does not create a session when the original is missing', async () => {
    h.get.mockResolvedValue({ data: { sessions: [] } });
    const api = await ApiClient.create(credentials);
    await expect(api.attachSession(options)).rejects.toThrow('session_attach_missing');
    expect(h.post).not.toHaveBeenCalled();
});
it('does not attach a different Dot even with a valid encrypted key', async () => {
    const api = await ApiClient.create(credentials);
    await expect(api.attachSession({ ...options, validateMetadata: () => { throw Error('wrong Dot'); } })).rejects.toThrow('wrong Dot');
    expect(h.post).not.toHaveBeenCalled();
});
it('rejects a replacement identity or data-key envelope', async () => {
    const api = await ApiClient.create(credentials);
    for (const replacement of [{ ...session, id: 'replacement' }, { ...session, dataEncryptionKey: 'different' }]) {
        h.post.mockResolvedValue({ data: { session: replacement } });
        await expect(api.attachSession(options)).rejects.toThrow('session_attach_identity_changed');
    }
});
