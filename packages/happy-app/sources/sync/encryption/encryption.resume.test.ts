import { describe, expect, it, vi } from 'vitest';

// Key ownership/lifetime test; native cryptography is not exercised here.
vi.mock('@/encryption/deriveKey', () => ({ deriveKey: async () => new Uint8Array(32).fill(9) }));
vi.mock('@/encryption/libsodium.lib', () => ({ default: { crypto_box_seed_keypair: () => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) }) } }));
vi.mock('@/encryption/libsodium', () => ({}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-id' }));
vi.mock('./encryptor', () => ({
    AES256Encryption: class {}, SecretBoxEncryption: class {},
}));

import { Encryption } from './encryption';

describe('resume data-key access', () => {
    it('retains per-machine keys for relay retries and drops them when a machine is removed', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const key = new Uint8Array(32).fill(3);
        await encryption.initializeMachines(new Map([['computer', key], ['legacy', null]]));
        expect(encryption.getMachineDataKey('computer')).toEqual(key);
        expect(encryption.getMachineDataKey('legacy')).toBeNull();
        expect(encryption.getMachineDataKey('unknown')).toBeNull();
        encryption.removeMachineEncryption('computer');
        expect(encryption.getMachineDataKey('computer')).toBeNull();
    });
    it('exposes per-session keys only, never the account master or legacy blob key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const firstKey = new Uint8Array(32).fill(1);
        const secondKey = new Uint8Array(32).fill(2);
        await encryption.initializeSessions(new Map([
            ['first', firstKey], ['second', secondKey], ['legacy', null],
        ]));
        expect(encryption.getSessionDataKey('first')).toEqual(firstKey);
        expect(encryption.getSessionDataKey('second')).toEqual(secondKey);
        expect(encryption.getSessionDataKey('legacy')).toBeNull();
        expect(encryption.getSessionDataKey('unknown')).toBeNull();

        encryption.removeSessionEncryption('first');
        expect(encryption.getSessionDataKey('first')).toBeNull();
        await encryption.initializeSessions(new Map([['first', null]]));
        expect(encryption.getSessionDataKey('first')).toBeNull();
    });
});
