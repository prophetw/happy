/** Hosted sessions reuse Happy encryption, RPC and wire envelopes, with a durable caller-owned outbox. */
import { io, type Socket } from 'socket.io-client';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { getServerSocketEndpoint } from '@slopus/happy-wire/serverUrl';
import { decodeBase64, encodeBase64, encrypt, decrypt } from '../api/encryption';
import { RpcHandlerManager } from '../api/rpc/RpcHandlerManager';

export type HostedMessage = { id: string; seq: number; localId: string | null; body: any };
export class HostedDotRelay {
    private socket: Socket;
    private rpc: RpcHandlerManager;
    constructor(private auth: { base: string; token: string; key: Uint8Array; sessionId: string; dotId: string }, abort: () => Promise<void>) {
        const endpoint = getServerSocketEndpoint(auth.base);
        this.socket = io(endpoint.origin, { path: endpoint.path, transports: ['websocket'], forceNew: true,
            auth: { token: auth.token, clientType: 'session-scoped', sessionId: auth.sessionId }, autoConnect: false });
        this.rpc = new RpcHandlerManager({ scopePrefix: auth.sessionId, encryptionKey: auth.key, encryptionVariant: 'dataKey' });
        this.rpc.registerHandler('abort', async () => { await abort(); return { success: true }; });
        this.socket.on('connect', () => this.rpc.onSocketConnect(this.socket));
        this.socket.on('disconnect', () => this.rpc.onSocketDisconnect());
        this.socket.on('rpc-request', async (req, callback) => callback(await this.rpc.handleRequest(req)));
    }
    private async request(path: string, body?: unknown): Promise<any> {
        const response = await fetch(this.auth.base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
            headers: { Authorization: `Bearer ${this.auth.token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`hosted_relay_http_${response.status}`);
        const value = await response.text();
        if (value.length > 8 * 1024 * 1024) throw new Error('hosted_relay_response_limit');
        return JSON.parse(value);
    }
    async messages(after: number): Promise<{ messages: HostedMessage[]; hasMore: boolean }> {
        const data = await this.request(`/v3/sessions/${encodeURIComponent(this.auth.sessionId)}/messages?after_seq=${after}&limit=100`);
        if (!Array.isArray(data.messages)) throw new Error('hosted_relay_messages_invalid');
        const messages = data.messages.map((m: any) => {
            if (!Number.isSafeInteger(m.seq) || m.seq <= after || m.content?.t !== 'encrypted') throw new Error('hosted_relay_message_invalid');
            const body = decrypt(this.auth.key, 'dataKey', decodeBase64(m.content.c));
            if (!body) throw new Error('hosted_relay_decryption_failed');
            return { id: m.id ?? String(m.seq), seq: m.seq, localId: m.localId ?? null, body };
        });
        return { messages, hasMore: data.hasMore === true };
    }
    async send(localId: string, envelope: SessionEnvelope): Promise<void> {
        const content = encodeBase64(encrypt(this.auth.key, 'dataKey', { role: 'session', content: envelope, meta: { sentFrom: 'cli' } }));
        const data = await this.request(`/v3/sessions/${encodeURIComponent(this.auth.sessionId)}/messages`, { messages: [{ localId, content }] });
        const receipt = data.messages?.find((m: any) => m.localId === localId);
        if (!receipt || !Number.isSafeInteger(receipt.seq)) throw new Error('hosted_output_unconfirmed');
        const readback = await this.messages(receipt.seq - 1);
        const stored = readback.messages.find(m => m.localId === localId);
        if (!stored || JSON.stringify(stored.body.content) !== JSON.stringify(envelope)) throw new Error('hosted_output_readback_failed');
    }
    async metadata(threadId: string): Promise<void> {
        // Read the original encrypted metadata and preserve Dot identity and all unrelated fields.
        const data = await this.request('/v1/sessions');
        const session = data.sessions?.find((s: any) => s.id === this.auth.sessionId);
        if (!session) throw new Error('hosted_session_missing');
        const original = decrypt(this.auth.key, 'dataKey', decodeBase64(session.metadata)) as Record<string, unknown>;
        const dot = original?.testloopDots as { dotId?: string; workspaceId?: string } | undefined;
        if (!dot || dot.dotId !== this.auth.dotId || !dot.workspaceId) throw new Error('hosted_dot_metadata_missing');
        // Happy suppresses heartbeats after session-end until the original stable tag is loaded.
        // Verify existence first; never choose a new/random tag or accept a replacement session.
        const resumed = await this.request('/v1/sessions', { tag: `testloop-dot:${dot.workspaceId}:${dot.dotId}`,
            metadata: session.metadata, agentState: session.agentState, dataEncryptionKey: session.dataEncryptionKey });
        if (resumed.session?.id !== this.auth.sessionId || resumed.session?.dataEncryptionKey !== session.dataEncryptionKey) throw new Error('hosted_session_resume_identity_changed');
        const metadata = encodeBase64(encrypt(this.auth.key, 'dataKey', { ...original, codexThreadId: threadId,
            codexCapabilities: { steering: true, asyncUserInput: false }, lifecycleState: 'running' }));
        const result = await this.socket.timeout(10000).emitWithAck('update-metadata', {
            sid: this.auth.sessionId, expectedVersion: session.metadataVersion, metadata });
        if (result.result !== 'success') throw new Error('hosted_metadata_update_failed');
        const agentState = encodeBase64(encrypt(this.auth.key, 'dataKey', { controlledByUser: false, requests: {} }));
        const stateResult = await this.socket.timeout(10000).emitWithAck('update-state', { sid: this.auth.sessionId, expectedVersion: session.agentStateVersion, agentState });
        if (stateResult.result !== 'success') throw new Error('hosted_agent_state_update_failed');
    }
    async connect(): Promise<void> {
        this.socket.connect();
        if (this.socket.connected) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error('hosted_relay_connect_timeout')); }, 10000);
            const ready = () => { cleanup(); resolve(); };
            const cleanup = () => { clearTimeout(timer); this.socket.off('connect', ready); };
            this.socket.on('connect', ready);
        });
    }
    alive(thinking: boolean): void { this.socket.volatile.emit('session-alive', { sid: this.auth.sessionId, time: Date.now(), thinking, mode: 'remote' }); }
    close(): void { this.socket.emit('session-end', { sid: this.auth.sessionId, time: Date.now() }); this.socket.disconnect(); }
}
