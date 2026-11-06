import { beforeEach, expect, it, vi } from 'vitest';
import { encrypt, encodeBase64, decodeBase64, decrypt } from '../api/encryption';
const h = vi.hoisted(() => ({ ack: vi.fn(), socket: null as any }));
vi.mock('socket.io-client', () => ({ io: () => {
    h.socket = { connected: true, on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), emit: vi.fn(), volatile: { emit: vi.fn() },
        timeout: () => h.socket, emitWithAck: h.ack };
    return h.socket;
} }));
import { HostedDotRelay } from './hostedDotRelay';
const key = new Uint8Array(32), metadata = { summary: { text: 'preserved' }, testloopDots: { dotId: 'dot', workspaceId: 'workspace' } };
const session = { id: 'session', metadata: encodeBase64(encrypt(key, 'dataKey', metadata)), metadataVersion: 2, agentStateVersion: 1, dataEncryptionKey: 'existing-key-envelope' };
beforeEach(() => { vi.clearAllMocks(); h.ack.mockResolvedValue({ result: 'success' }); });
it('reloads the original stable tag to lift heartbeat suppression and preserves Dot metadata', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [session] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ session })));
    vi.stubGlobal('fetch', fetcher);
    const relay = new HostedDotRelay({ base: 'http://127.0.0.1:1234', token: 'synthetic', key, sessionId: 'session', dotId: 'dot' }, async () => {});
    try {
        await relay.metadata('native');
        const call = fetcher.mock.calls[1]; expect(JSON.parse(call[1].body).tag).toBe('testloop-dot:workspace:dot');
        const update = h.ack.mock.calls.find(([method]) => method === 'update-metadata')![1];
        const result = decrypt(key, 'dataKey', decodeBase64(update.metadata)) as any;
        expect(result.testloopDots).toEqual(metadata.testloopDots); expect(result.summary.text).toBe('preserved');
        expect(result.codexCapabilities).toEqual({ steering: true, asyncUserInput: false });
    } finally { relay.close(); vi.unstubAllGlobals(); }
});
it('rejects a replacement Happy session before publishing a native thread binding', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [session] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ session: { ...session, id: 'replacement' } }))));
    const relay = new HostedDotRelay({ base: 'http://127.0.0.1:1234', token: 'synthetic', key, sessionId: 'session', dotId: 'dot' }, async () => {});
    try { await expect(relay.metadata('native')).rejects.toThrow('hosted_session_resume_identity_changed'); expect(h.ack).not.toHaveBeenCalled(); }
    finally { relay.close(); vi.unstubAllGlobals(); }
});
