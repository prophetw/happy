import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import type { Encryption } from './encryption/encryption';
import { RelaySwitchController } from '../../../happy-cli/src/relay/relaySwitch';

const mocks = vi.hoisted(() => ({
    values: new Map<string, string>(),
    foreground: null as null | ((state: string) => void),
    failStorage: false,
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return mocks.values.get(key); }
    set(key: string, value: string) {
        if (mocks.failStorage) throw new Error('Disk full');
        mocks.values.set(key, value);
    }
    delete(key: string) { mocks.values.delete(key); }
    clearAll() { mocks.values.clear(); }
} }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_event: string, callback: typeof mocks.foreground) => {
    mocks.foreground = callback;
    return { remove: () => { mocks.foreground = null; } };
} } }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));

import { getRelayMigrationStatus, queueRelayMigrations, startRelayMigrations, stopRelayMigrations, waitForRelaySessionMigration, type RelayMigrationParticipant } from './relayMigrations';

// Real AES-GCM protects the journal and RPC payloads in this transport harness;
// native OS storage and cryptographic bridges are replaced at their boundaries.
const masterKey = Buffer.alloc(32, 7);
function seal(value: unknown, key: Uint8Array = masterKey): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
}
function open(value: Uint8Array, key: Uint8Array = masterKey): any {
    const bytes = Buffer.from(value);
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString());
}
const encryption = {
    anonID: 'test-account',
    encryptRaw: async (data: unknown) => Buffer.from(seal(data)).toString('base64'),
    decryptRaw: async (data: string) => open(Buffer.from(data, 'base64')),
    openEncryption: async (key: Uint8Array | null) => ({
        encrypt: async (data: unknown[]) => data.map(item => seal(item, key ?? masterKey)),
        decrypt: async (data: Uint8Array[]) => data.map(item => open(item, key ?? masterKey)),
    }),
} as unknown as Encryption;

interface Device {
    participant: RelayMigrationParticipant;
    controller: RelaySwitchController;
    available: boolean;
    relay: string;
    originalRelay: string;
    finished: boolean;
    loseFinishReply: boolean;
    holdPrepare?: Promise<void>;
    onFinish?: () => void;
    rejectCommit?: boolean;
    phases: string[];
}
const devices = new Map<string, Device>();
const relays: Array<{ url: string; close: () => Promise<void> }> = [];
function device(id: string, relay: string, kind: 'machine' | 'session' = 'machine', legacy = false): Device {
    const item: Device = {
        participant: { entityId: id, kind, name: id, dataKey: legacy ? null : randomBytes(32).toString('base64') },
        available: true, relay, originalRelay: relay, finished: false, loseFinishReply: false, phases: [],
        controller: undefined as unknown as RelaySwitchController,
    };
    item.controller = new RelaySwitchController(async target => ({
        commit: async () => { item.relay = target.serverUrl; },
        finish: async () => { item.finished = true; item.onFinish?.(); },
        rollback: async () => { item.relay = relay; },
        dispose: () => {},
    }));
    devices.set(id, item);
    return item;
}
async function relay(prefix = '') {
    const http = createServer();
    const io = new Server(http, { path: `${prefix}/v1/updates`, transports: ['websocket'] });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}${prefix}`;
    io.on('connection', socket => {
        socket.on('rpc-call', async ({ method, params }, reply) => {
            const item = devices.get(method.split(':')[0]);
            if (!item?.available || (url !== item.relay && item.finished)) {
                reply({ ok: false, error: 'The computer did not respond' });
                return;
            }
            // Only the original relay can reach a device until it commits.
            if (url !== item.relay && url !== item.originalRelay) {
                reply({ ok: false, error: 'RPC method not available' });
                return;
            }
            const key = item.participant.dataKey ? Buffer.from(item.participant.dataKey, 'base64') : masterKey;
            const request = open(Buffer.from(params, 'base64'), key);
            item.phases.push(request.phase);
            if (request.phase === 'prepare' && item.holdPrepare) await item.holdPrepare;
            const answer = request.phase === 'commit' && item.rejectCommit
                ? { error: 'Injected participant commit failure' }
                : await item.controller.handle(request);
            if (request.phase === 'finish' && item.loseFinishReply) {
                reply({ ok: false, error: 'The computer did not respond' });
                return;
            }
            reply({ ok: true, result: Buffer.from(seal(answer, key)).toString('base64') });
        });
    });
    const result = { url, close: () => new Promise<void>(resolve => io.close(() => resolve())) };
    relays.push(result);
    return result;
}
async function enqueue(source: string, target: string, participants: Device[], id = 'switch-1') {
    return queueRelayMigrations({
        id, source: { serverUrl: source, token: 'old-private-token' },
        target: { serverUrl: target, token: 'new-private-token' },
        participants: participants.map(item => item.participant), encryption,
    });
}
async function journal() {
    return encryption.decryptRaw(mocks.values.get(encryption.anonID)!);
}
async function waitUntil(check: () => boolean | Promise<boolean>) {
    await expect.poll(check, { timeout: 4_000, interval: 20 }).toBe(true);
}

describe('durable automatic relay migration over Socket.IO', () => {
    beforeEach(() => {
        mocks.values.clear();
        mocks.failStorage = false;
    });
    afterEach(async () => {
        stopRelayMigrations(true);
        for (const item of devices.values()) item.controller.dispose();
        devices.clear();
        await Promise.all(relays.splice(0).map(server => server.close()));
    });

    it('encrypts migration credentials and keys before reload, without contacting devices', async () => {
        const item = device('computer', 'http://old.test');
        await enqueue('http://old.test', 'http://new.test/prefix', [item]);
        const saved = mocks.values.get(encryption.anonID)!;
        expect(saved).not.toContain('private-token');
        expect(saved).not.toContain(item.participant.dataKey);
        expect(saved).not.toContain('http://old.test');
        expect(item.phases).toEqual([]);
        expect(getRelayMigrationStatus().pending).toBe(0);
        expect((await journal()).jobs[0].target.serverUrl).toBe('http://new.test/prefix');
    });

    it('moves a healthy session independently, then resumes a disconnected computer after an App restart', async () => {
        const source = await relay();
        const target = await relay('/nested/relay');
        const computer = device('computer', source.url);
        const session = device('session', source.url, 'session');
        computer.available = false;
        await enqueue(source.url, target.url, [computer, session]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => session.finished && getRelayMigrationStatus().pending === 1 && !!getRelayMigrationStatus().lastError);
        expect(session.relay).toBe(target.url);
        expect(session.phases).toEqual(['prepare', 'commit', 'finish']);
        expect((await journal()).jobs.map((job: any) => job.entityId)).toEqual(['computer']);
        stopRelayMigrations();
        computer.available = true;
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => computer.finished && getRelayMigrationStatus().pending === 0);
        expect(computer.relay).toBe(target.url);
        expect(session.phases).not.toContain('rollback');
        expect(computer.phases).not.toContain('rollback');
    });

    it('retries automatically on return to foreground, including legacy account encryption', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url, 'machine', true);
        computer.available = false;
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        computer.available = true;
        mocks.foreground?.('active');
        await waitUntil(() => computer.finished && getRelayMigrationStatus().pending === 0);
        expect(computer.relay).toBe(target.url);
    });

    it('finishes via the new relay after the finish acknowledgement and old RPC connection are lost', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        computer.loseFinishReply = true;
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => computer.finished && !!getRelayMigrationStatus().lastError);
        expect((await journal()).jobs[0].phase).toBe('finish');
        stopRelayMigrations();
        computer.loseFinishReply = false;
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => getRelayMigrationStatus().pending === 0);
        expect(computer.relay).toBe(target.url);
        expect(computer.phases.filter(phase => phase === 'prepare')).toHaveLength(1);
        expect(computer.phases).not.toContain('rollback');
    });

    it('retargets a computer still on A when the App switches from B to C', async () => {
        const source = await relay();
        const middle = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        computer.available = false;
        await enqueue(source.url, middle.url, [computer]);
        startRelayMigrations(encryption, middle.url);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        await enqueue(middle.url, target.url, [], 'switch-2');
        const pending = (await journal()).jobs[0];
        expect(pending.sources.map((endpoint: any) => endpoint.serverUrl)).toContain(source.url);
        expect(pending.target.serverUrl).toBe(target.url);
        computer.available = true;
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => computer.finished && getRelayMigrationStatus().pending === 0);
        expect(computer.relay).toBe(target.url);
    });

    it('re-prepares an expired transaction instead of retrying a stale commit forever', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        await enqueue(source.url, target.url, [computer]);
        const saved = await journal();
        saved.jobs[0].phase = 'commit';
        mocks.values.set(encryption.anonID, await encryption.encryptRaw(saved));
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        expect((await journal()).jobs[0].phase).toBe('prepare');
        mocks.foreground?.('active');
        await waitUntil(() => computer.finished && getRelayMigrationStatus().pending === 0);
        expect(computer.relay).toBe(target.url);
    });

    it('cancels on logout and never sends a delayed commit after a prepare reply arrives', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        let release!: () => void;
        computer.holdPrepare = new Promise<void>(resolve => { release = resolve; });
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => computer.phases.includes('prepare'));
        stopRelayMigrations(true);
        release();
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(computer.phases).toEqual(['prepare']);
        expect(mocks.values.size).toBe(0);
        expect(getRelayMigrationStatus().pending).toBe(0);
    });

    it('restores previous pending work when saving the App login fails', async () => {
        const item = device('computer', 'http://old.test');
        await enqueue('http://old.test', 'http://middle.test', [item]);
        const previous = mocks.values.get(encryption.anonID);
        const undo = await enqueue('http://middle.test', 'http://new.test', [], 'switch-2');
        undo();
        expect(mocks.values.get(encryption.anonID)).toBe(previous);
        expect((await journal()).jobs[0].target.serverUrl).toBe('http://middle.test');
    });

    it('does not move devices if the App exits before applying its queued server switch', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, source.url);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        expect(computer.phases).toEqual([]);
        expect(computer.relay).toBe(source.url);
        expect((await journal()).jobs).toHaveLength(1);
    });

    it('retains unfinished journal work when disk writes fail after a device finishes', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        computer.onFinish = () => { mocks.failStorage = true; };
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => computer.finished && !!getRelayMigrationStatus().lastError);
        expect(getRelayMigrationStatus().pending).toBe(1);
        expect((await journal()).jobs[0].phase).toBe('finish');
        computer.onFinish = undefined;
        mocks.failStorage = false;
        mocks.foreground?.('active');
        await waitUntil(() => getRelayMigrationStatus().pending === 0);
        expect((await journal()).jobs).toEqual([]);
    });

    it('preserves the computer error instead of replacing it with an unavailable fallback RPC', async () => {
        const source = await relay();
        const target = await relay();
        const computer = device('computer', source.url);
        computer.rejectCommit = true;
        await enqueue(source.url, target.url, [computer]);
        startRelayMigrations(encryption, target.url);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        expect(getRelayMigrationStatus().lastError).toBe('computer: Injected participant commit failure');
        computer.rejectCommit = false;
        mocks.foreground?.('active');
        await waitUntil(() => computer.finished && getRelayMigrationStatus().pending === 0);
    });

    it('holds new session messages through startup loading and releases them only after migration', async () => {
        const source = await relay();
        const target = await relay();
        const session = device('session', source.url, 'session');
        session.available = false;
        await enqueue(source.url, target.url, [session]);
        startRelayMigrations(encryption, target.url);
        const send = vi.fn();
        const waiting = waitForRelaySessionMigration('session').then(send);
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        expect(send).not.toHaveBeenCalled();
        session.available = true;
        mocks.foreground?.('active');
        await waiting;
        expect(session.finished).toBe(true);
        expect(send).toHaveBeenCalledOnce();
    });

    it('cancels waiting outbox sends on logout instead of releasing them to another relay', async () => {
        const source = await relay();
        const target = await relay();
        const session = device('session', source.url, 'session');
        session.available = false;
        await enqueue(source.url, target.url, [session]);
        startRelayMigrations(encryption, target.url);
        const waiting = waitForRelaySessionMigration('session');
        const rejected = expect(waiting).rejects.toThrow('Relay changed');
        await waitUntil(() => !!getRelayMigrationStatus().lastError);
        stopRelayMigrations(true);
        await rejected;
    });
});
