import axios from 'axios';
import { io } from 'socket.io-client';
import { getServerSocketEndpoint } from '@slopus/happy-wire/serverUrl';
import { decryptMachine, decryptSession, decryptField, type DecryptedMachine, type DecryptedSession, type RawMachine, type RawSession, type RawMessage } from '../api';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '../encryption';
import type { Credentials } from '../credentials';

export type MessagePage = { messages: { id: string; seq: number; localId: string | null; content: unknown }[]; hasMore: boolean };
export interface Transport {
    machines(): Promise<DecryptedMachine[]>;
    sessions(cursor?: string, limit?: number): Promise<{ sessions: DecryptedSession[]; nextCursor: string | null }>;
    rpc(machine: DecryptedMachine, input: Record<string, unknown>): Promise<Record<string, unknown>>;
    messages(session: DecryptedSession, cursor: number, limit: number): Promise<MessagePage>;
    send(session: DecryptedSession, requestID: string, text: string): Promise<{ id: string; seq: number }>;
}
export class ControlError extends Error {
    constructor(readonly code: string) { super(code); }
}

/** Existing relay protocol only; never sends decrypted metadata/keys to callers. */
export function relayTransport(serverUrl: string, creds: Credentials): Transport {
    const http = axios.create({ baseURL: serverUrl, timeout: 15_000, headers: {
        Authorization: `Bearer ${creds.token}`, 'X-Happy-Client': 'automation/1',
    } });
    return {
        ...recordMessageTransport(serverUrl, creds.token),
        async machines() {
            const { data } = await http.get<RawMachine[]>('/v1/machines');
            return data.map(m => decryptMachine(m, creds));
        },
        async sessions(cursor, limit = 100) {
            const { data } = await http.get<{ sessions: RawSession[]; nextCursor: string | null }>('/v2/sessions', { params: { cursor, limit } });
            return { sessions: data.sessions.map(s => decryptSession(s, creds)), nextCursor: data.nextCursor };
        },
        async rpc(machine, input) {
            const endpoint = getServerSocketEndpoint(serverUrl);
            const socket = io(endpoint.origin, { path: endpoint.path, auth: { token: creds.token }, transports: ['websocket'], reconnection: false, autoConnect: false });
            try {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(() => reject(new ControlError('UNAVAILABLE')), 10_000);
                    socket.once('connect', () => { clearTimeout(timer); resolve(); });
                    socket.once('connect_error', () => { clearTimeout(timer); reject(new ControlError('UNAVAILABLE')); });
                    socket.connect();
                });
                const params = encodeBase64(encrypt(machine.encryption.key, machine.encryption.variant, input));
                const ack = await socket.timeout(60_000).emitWithAck('rpc-call', { method: `${machine.id}:automation-control`, params });
                if (!ack?.ok || typeof ack.result !== 'string') throw new ControlError('UNAVAILABLE_OR_UNSUPPORTED');
                const result = decrypt(machine.encryption.key, machine.encryption.variant, decodeBase64(ack.result));
                if (!result || typeof result !== 'object' || Array.isArray(result) || !('version' in result) || result.version !== 1) throw new ControlError('UNSUPPORTED_VERSION');
                return result as Record<string, unknown>;
            } finally { socket.close(); }
        },
    };
}

/** Record-key-only transport for a trusted daemon; no account secret is needed. */
export function recordMessageTransport(serverUrl: string, token: string): Pick<Transport, 'messages' | 'send'> {
    const http = axios.create({ baseURL: serverUrl, timeout: 15000, maxRedirects: 0, headers: {
        Authorization: `Bearer ${token}`, 'X-Happy-Client': 'automation-worker/1',
    } });
    return {
        async messages(session, cursor, limit) {
            const { data } = await http.get<{ messages: RawMessage[]; hasMore: boolean }>(`/v3/sessions/${encodeURIComponent(session.id)}/messages`, { params: { after_seq: cursor, limit } });
            return { hasMore: data.hasMore, messages: data.messages.map(m => ({
                id: m.id, seq: m.seq, localId: m.localId ?? null, content: decryptField(m.content.c, session.encryption),
            })) };
        },
        async send(session, requestID, text) {
            const content = encodeBase64(encrypt(session.encryption.key, session.encryption.variant, {
                role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'happy-automation',
                    permissionMode: 'default', model: 'gpt-6.1-sol', effort: 'high' },
            }));
            const { data } = await http.post<{ messages: { id: string; seq: number; localId: string }[] }>(`/v3/sessions/${encodeURIComponent(session.id)}/messages`, {
                messages: [{ content, localId: `automation:${requestID}` }],
            });
            const message = data.messages.find(m => m.localId === `automation:${requestID}`);
            if (!message) throw new ControlError('INVALID_RELAY_RESPONSE');
            return { id: message.id, seq: message.seq };
        },
    };
}
