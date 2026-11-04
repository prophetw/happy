import { beforeEach, describe, expect, it, vi } from 'vitest';
import { relayTransport } from './relay';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '../encryption';
import type { DecryptedMachine, DecryptedSession } from '../api';
import type { Credentials } from '../credentials';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), create: vi.fn(), io: vi.fn() }));
vi.mock('axios', () => ({ default: { create: mocks.create } }));
vi.mock('socket.io-client', () => ({ io: mocks.io }));
const key = new Uint8Array(32).fill(7); // Synthetic fixture key, never a real credential.
const encryption = { key, variant: 'dataKey' as const };
const session = { id: 'session1', encryption } as DecryptedSession;
const machine = { id: 'machine1', encryption } as DecryptedMachine;
const creds = { token: 'fixture-bearer' } as Credentials;
beforeEach(() => { vi.resetAllMocks(); mocks.create.mockReturnValue({ get: mocks.get, post: mocks.post }); });

describe('existing encrypted relay transport contract', () => {
    it('posts ciphertext with stable localId and safe provider defaults; never leaks a key', async () => {
        mocks.post.mockResolvedValue({ data: { messages: [{ id: 'msg1', seq: 12, localId: 'automation:req1' }] } });
        const transport = relayTransport('https://relay.invalid', creds);
        expect(await transport.send(session, 'req1', 'fixture instruction')).toEqual({ id: 'msg1', seq: 12 });
        const [path, body] = mocks.post.mock.calls[0];
        expect(path).toBe('/v3/sessions/session1/messages');
        expect(body.messages[0].localId).toBe('automation:req1');
        expect(JSON.stringify(body)).not.toContain('fixture instruction');
        expect(decrypt(key, 'dataKey', decodeBase64(body.messages[0].content))).toMatchObject({
            role: 'user', content: { text: 'fixture instruction' }, meta: { permissionMode: 'default', model: 'gpt-6.1-sol', effort: 'high' },
        });
        expect(mocks.create.mock.calls[0][0]).toMatchObject({ timeout: 15000, headers: { Authorization: 'Bearer fixture-bearer' } });
    });
    it('preserves forward pagination and decrypts a page locally', async () => {
        mocks.get.mockResolvedValue({ data: { hasMore: true, messages: [{ id: 'msg1', seq: 8, localId: null, content: { t: 'encrypted', c: encodeBase64(encrypt(key, 'dataKey', { fixture: true })) } }] } });
        expect(await relayTransport('https://relay.invalid', creds).messages(session, 7, 1)).toMatchObject({ hasMore: true, messages: [{ seq: 8, content: { fixture: true } }] });
        expect(mocks.get).toHaveBeenCalledWith('/v3/sessions/session1/messages', { params: { after_seq: 7, limit: 1 } });
    });
    it('uses existing encrypted machine RPC and closes transport on success and error', async () => {
        const listeners = new Map<string, (...args: any[]) => void>();
        const close = vi.fn();
        const emitWithAck = vi.fn(async () => ({ ok: true, result: encodeBase64(encrypt(key, 'dataKey', { version: 1, state: 'confirmed' })) }));
        const socket = {
            once: vi.fn((name, cb) => { listeners.set(name, cb); }),
            connect: vi.fn(() => listeners.get('connect')!()), close,
            timeout: vi.fn(() => ({ emitWithAck })),
        };
        mocks.io.mockReturnValue(socket);
        const transport = relayTransport('https://relay.invalid', creds);
        expect(await transport.rpc(machine, { version: 1, operation: 'status', sessionID: 'session1' })).toMatchObject({ state: 'confirmed' });
        const [event, payload] = emitWithAck.mock.calls[0] as unknown as [string, { method: string; params: string }];
        expect(event).toBe('rpc-call'); expect(payload.method).toBe('machine1:automation-control');
        expect(decrypt(key, 'dataKey', decodeBase64(payload.params))).toMatchObject({ operation: 'status', sessionID: 'session1' });
        expect(close).toHaveBeenCalledTimes(1);
        emitWithAck.mockRejectedValueOnce(new Error('timeout'));
        await expect(transport.rpc(machine, { version: 1, operation: 'create' })).rejects.toThrow('timeout');
        expect(close).toHaveBeenCalledTimes(2);
    });
});
