import { io } from 'socket.io-client';
import { randomUUID } from 'expo-crypto';
import { type AuthCredentials, TokenStorage } from '@/auth/tokenStorage';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { getServerUrl, setServerUrl, getDefaultServerUrl } from './serverConfig';
import { queueRelayMigrations, startRelayMigrations, type RelayMigrationParticipant } from './relayMigrations';
import { sync } from './sync';
import { getServerSocketEndpoint, normalizeServerUrl } from '@slopus/happy-wire/serverUrl';
import { loadRegisteredPushToken, clearRelayPersistence } from './persistence';
import { unregisterPushTokenOnce } from './apiPush';

async function authenticateTarget(secret: string, serverUrl: string): Promise<string> {
    const token = await authGetToken(decodeBase64(secret, 'base64url'), serverUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(`${serverUrl}/v1/relay`, {
            headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (!response.ok || (await response.json()).liveSwitch !== 1) {
            throw new Error('This server does not support switching without pairing again.');
        }
    } finally { clearTimeout(timeout); }
    const endpoint = getServerSocketEndpoint(serverUrl);
    const socket = io(endpoint.origin, {
        path: endpoint.path, auth: { token, clientType: 'user-scoped' },
        transports: ['websocket'], reconnection: false, autoConnect: false, forceNew: true,
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Cannot connect to the new server.')), 15_000);
            socket.once('connect', () => { clearTimeout(timeout); resolve(); });
            socket.once('connect_error', () => { clearTimeout(timeout); reject(new Error('The new server rejected the connection.')); });
            socket.connect();
        });
    } finally { socket.disconnect(); }
    return token;
}

export async function switchServer(
    input: string | null,
    credentials: AuthCredentials | null,
    reload: (credentials: AuthCredentials | null) => Promise<void>,
): Promise<void> {
    const serverUrl = normalizeServerUrl(input ?? getDefaultServerUrl());
    const oldServerUrl = getServerUrl();
    if (serverUrl === oldServerUrl) { if (input === null) setServerUrl(null); return; }
    if (!credentials) {
        setServerUrl(input === null ? null : serverUrl);
        await reload(null);
        return;
    }

    const { machines, sessions } = storage.getState();
    const encryption = sync.encryption;
    const dataKey = (key: Uint8Array | null) => key ? encodeBase64(key) : null;
    const participants: RelayMigrationParticipant[] = [
        ...Object.values(machines).filter(machine => machine.active).map(machine => ({
            kind: 'machine' as const, entityId: machine.id,
            name: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            dataKey: dataKey(encryption.getMachineDataKey(machine.id)),
        })),
        ...Object.values(sessions).filter(session => session.active).map(session => ({
            kind: 'session' as const, entityId: session.id,
            name: [session.metadata?.host, session.metadata?.name || session.id].filter(Boolean).join(' / '),
            dataKey: dataKey(encryption.getSessionDataKey(session.id)),
        })),
    ];
    const token = await authenticateTarget(credentials.secret, serverUrl);
    let undoQueue: () => void;
    try {
        undoQueue = await queueRelayMigrations({
            id: randomUUID(), source: { serverUrl: oldServerUrl, token: credentials.token },
            target: { serverUrl, token }, participants, encryption,
        });
    } catch (error) {
        startRelayMigrations(encryption, oldServerUrl);
        throw error;
    }
    const next = { ...credentials, token };
    try {
        if (!await TokenStorage.setCredentials(next)) throw new Error('Could not save the new server login.');
        const pushToken = loadRegisteredPushToken();
        // Old relay cleanup is bounded by unregisterPushTokenOnce and is not
        // a prerequisite for moving the App or reconnecting computers.
        if (pushToken) void unregisterPushTokenOnce(credentials, pushToken, oldServerUrl)
            .catch(() => { console.warn('Relay switched; the old server could not clear its push registration.'); });
        apiSocket.disconnect();
        setServerUrl(input === null ? null : serverUrl);
        clearRelayPersistence();
        await reload(next);
    } catch (error) {
        undoQueue();
        setServerUrl(oldServerUrl);
        if (!await TokenStorage.setCredentials(credentials)) throw new Error('Could not restore the original login after the switch failed.');
        apiSocket.connect();
        startRelayMigrations(encryption, oldServerUrl);
        throw error;
    }
}
