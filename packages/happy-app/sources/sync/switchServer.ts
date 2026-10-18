import { io } from 'socket.io-client';
import { randomUUID } from 'expo-crypto';
import { type AuthCredentials, TokenStorage } from '@/auth/tokenStorage';
import { authGetToken } from '@/auth/authGetToken';
import { decodeBase64 } from '@/encryption/base64';
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { getServerUrl, setServerUrl, getDefaultServerUrl } from './serverConfig';
import { switchRelay, type RelaySwitchParticipant } from './relaySwitch';
import { getServerSocketEndpoint, normalizeServerUrl } from '@slopus/happy-wire/serverUrl';
import { loadRegisteredPushToken, clearRelayPersistence } from './persistence';
import { unregisterPushTokenOnce } from './apiPush';
import { t } from '@/text';

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
    const participants: RelaySwitchParticipant[] = [
        ...Object.values(machines).filter(machine => machine.active).map(machine => ({
            name: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            call: request => apiSocket.machineRPC(machine.id, 'relay-switch', request),
        } satisfies RelaySwitchParticipant)),
        ...Object.values(sessions).filter(session => session.active).map(session => ({
            name: [session.metadata?.host, session.metadata?.name || session.id].filter(Boolean).join(' / '),
            call: request => apiSocket.sessionRPC(session.id, 'relay-switch', request),
        } satisfies RelaySwitchParticipant)),
    ];
    await switchRelay({
        id: randomUUID(), serverUrl, participants,
        authenticate: url => authenticateTarget(credentials.secret, url),
        messages: {
            unavailable: t('server.relaySwitchUnavailable'),
            rollbackUnconfirmed: t('server.relayRollbackUnconfirmed'),
            keepOriginal: t('server.keepOriginalRelay'),
        },
        save: async (url, token) => {
            const next = { ...credentials, token };
            try {
                if (!await TokenStorage.setCredentials(next)) throw new Error('Could not save the new server login.');
                const pushToken = loadRegisteredPushToken();
                if (pushToken) {
                    try { await unregisterPushTokenOnce(credentials, pushToken, oldServerUrl); }
                    catch { console.warn('Relay switched; the old server could not clear its push registration.'); }
                }
                apiSocket.disconnect();
                setServerUrl(input === null ? null : url);
                clearRelayPersistence();
                await reload(next);
            } catch (error) {
                setServerUrl(oldServerUrl);
                if (!await TokenStorage.setCredentials(credentials)) throw new Error('Could not restore the original login after the switch failed.');
                apiSocket.connect();
                throw error;
            }
        },
    });
}
