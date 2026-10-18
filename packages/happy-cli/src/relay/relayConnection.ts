import axios from 'axios';
import { io, type Socket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { configuration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { encodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption';
import { getServerSocketEndpoint } from '@slopus/happy-wire/serverUrl';
import type { RelayTarget } from './relaySwitch';
import type { AsyncLock } from '@/utils/lock';

/** Expired queued callbacks must never perform a delayed, invisible switch. */
export async function withRelayLock<T>(lock: AsyncLock, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            reject(new Error('Session state is busy; the relay was not switched'));
        }, 3_000);
        void lock.inLock(async () => {
            if (expired) return;
            clearTimeout(timer);
            try { resolve(await run()); } catch (error) { reject(error); }
        }).catch(error => { clearTimeout(timer); reject(error); });
    });
}

/** Refresh an authoritative live snapshot, tolerating one version conflict. */
export async function publishRelaySnapshot(socket: Socket, event: string, payload: Record<string, unknown> & { expectedVersion: number }): Promise<number> {
    for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await socket.timeout(5_000).emitWithAck(event, payload);
        if (answer.result === 'success') return answer.version;
        if (answer.result !== 'version-mismatch' || typeof answer.version !== 'number') break;
        payload.expectedVersion = answer.version;
    }
    throw new Error('Could not synchronize the live session state');
}

export function wrapRelayKey(key: Uint8Array, credential: Credentials): string | null {
    if (credential.encryption.type === 'legacy') return null;
    const wrapped = libsodiumEncryptForPublicKey(key, credential.encryption.publicKey);
    return encodeBase64(new Uint8Array([0, ...wrapped]));
}

export async function relayRequest<T>(target: RelayTarget, method: 'GET' | 'POST' | 'PUT', path: string, data?: unknown): Promise<T> {
    try {
        const response = await axios.request<T>({
            url: `${target.serverUrl}${path}`, method, data,
            headers: { Authorization: `Bearer ${target.token}`, 'X-Happy-Client': `cli/${configuration.currentCliVersion}` },
            timeout: 7_000,
        });
        return response.data;
    } catch (error) {
        // Axios errors contain bearer tokens in their request config. Return
        // only the status, never the request or response body, over the RPC.
        throw new Error(`Target relay request failed${axios.isAxiosError(error) && error.response ? ` (HTTP ${error.response.status})` : ''}`);
    }
}

export async function probeRelay(target: RelayTarget, scope: { sessionId: string } | { machineId: string }) {
    const capability = await relayRequest<{ liveSwitch?: number }>(target, 'GET', '/v1/relay');
    if (capability.liveSwitch !== 1) throw new Error('Target relay does not support live switching');
    const endpoint = getServerSocketEndpoint(target.serverUrl);
    const socket = io(endpoint.origin, {
        path: endpoint.path, auth: { token: target.token, ...scope, clientType: 'sessionId' in scope ? 'session-scoped' : 'machine-scoped' },
        transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false,
    });
    try { await waitRelaySocket(socket); } finally { socket.disconnect(); }
}

export function waitRelaySocket(socket: Socket, requiredMethod?: string): Promise<void> {
    if (socket.connected && !requiredMethod) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Target relay connection timed out')), 7_000);
        const connected = () => { if (!requiredMethod) finish(); };
        const registered = (data: { method: string }) => { if (data.method === requiredMethod) finish(); };
        const failed = () => finish(new Error('Target relay rejected the connection'));
        const finish = (error?: Error) => {
            clearTimeout(timer);
            socket.off('connect', connected);
            socket.off('connect_error', failed);
            socket.off('rpc-registered', registered);
            if (error) reject(error); else resolve();
        };
        socket.once('connect', connected);
        socket.once('connect_error', failed);
        if (requiredMethod) socket.on('rpc-registered', registered);
        socket.connect();
    });
}

/** Save URL and token together so a later CLI never combines two relays. */
export function prepareRelayPersistence(credential: Credentials, target: RelayTarget) {
    const old = { serverUrl: configuration.serverUrl, token: credential.token, override: configuration.relayOverrideActive };
    const previousEnv = process.env.HAPPY_SERVER_URL;
    let persisted = false;
    const restore = () => {
        credential.token = old.token;
        configuration.setRelayServerUrl(old.serverUrl, old.override);
        if (previousEnv === undefined) delete process.env.HAPPY_SERVER_URL;
        else process.env.HAPPY_SERVER_URL = previousEnv;
    };
    const save = async (serverUrl: string, token: string, override: boolean) => {
        const encryption = credential.encryption;
        const record = {
            token, serverUrl: override ? serverUrl : undefined,
            ...(encryption.type === 'legacy'
                ? { secret: encodeBase64(encryption.secret) }
                : { encryption: { publicKey: encodeBase64(encryption.publicKey), machineKey: encodeBase64(encryption.machineKey) } }),
        };
        await mkdir(configuration.happyHomeDir, { recursive: true });
        const temporary = `${configuration.privateKeyFile}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
            await rename(temporary, configuration.privateKeyFile);
        } finally { await rm(temporary, { force: true }); }
    };
    return {
        restore,
        activate() {
            credential.token = target.token;
            configuration.setRelayServerUrl(target.serverUrl);
        },
        async finish() {
            persisted = true;
            await save(target.serverUrl, target.token, true);
        },
        async rollback() {
            restore();
            if (persisted) await save(old.serverUrl, old.token, old.override);
        },
    };
}
