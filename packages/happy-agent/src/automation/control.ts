import { Journal, hash, type RecordEntry } from './journal';
import { ControlError, type Transport } from './relay';
import type { DecryptedSession } from '../api';

export const methods = ['machines.list', 'sessions.list', 'tasks.create', 'requests.get', 'sessions.send', 'sessions.status', 'sessions.logs', 'sessions.result', 'sessions.cancel'] as const;
export type Policy = {
    version: 1; serverUrl: string; methods: string[];
    machines: { id: string; directories: string[] }[];
    sessionIDs: string[];
};
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const processState = (v: unknown) => ['running', 'stopping', 'stopped'].includes(String(v)) ? String(v) : 'unknown';
const receiptState = (v: unknown) => ['pending', 'confirmed', 'cancel_requested', 'failed', 'unavailable'].includes(String(v)) ? String(v) : 'unknown';
function id(v: unknown): string {
    if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v)) throw new ControlError('INVALID_REQUEST');
    return v;
}
function integer(v: unknown, fallback: number, max: number) {
    if (v === undefined) return fallback;
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new ControlError('INVALID_REQUEST');
    return v as number;
}
export function validatePolicy(v: unknown): Policy {
    const p = obj(v);
    if (p.version !== 1 || typeof p.serverUrl !== 'string' || !Array.isArray(p.methods) || !p.methods.every(m => methods.includes(m))
        || !Array.isArray(p.sessionIDs) || !p.sessionIDs.every(s => typeof s === 'string')
        || !Array.isArray(p.machines) || !p.machines.every(m => typeof m?.id === 'string' && Array.isArray(m.directories) && m.directories.every((d: unknown) => typeof d === 'string' && d.startsWith('/')))) throw new ControlError('INVALID_POLICY');
    const url = new URL(p.serverUrl);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new ControlError('INVALID_POLICY');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new ControlError('INVALID_POLICY');
    return p as unknown as Policy;
}

// Deliberate projection, not recursive serialization of decrypted records.
export function redact(text: string): string {
    return text.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
        .replace(/\bhsvc1\.[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}\b/g, '[REDACTED]')
        .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
        .replace(/\b(?:sk-[a-zA-Z0-9_-]+|gh[pousr]_[a-zA-Z0-9]+)\b/g, '[REDACTED]')
        .replace(/(["']?(?:[a-z_]*(?:token|secret|password|api[_-]?key|encryption[_-]?key))["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, '$1[REDACTED]');
}
export function projectMessage(message: { id: string; seq: number; content: unknown }) {
    const c = obj(message.content), body = obj(c.content), ev = obj(body.ev);
    const base = { messageID: message.id, seq: message.seq };
    const turnID = typeof body.turn === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.turn) ? body.turn : undefined;
    // Compatibility adapter for the current Happy stream. No frozen schema imports.
    if (c.role === 'session' && body.role === 'agent' && !body.subagent) {
        if (ev.t === 'turn-start') return { ...base, kind: 'turn', turnID, state: 'running' };
        if (ev.t === 'turn-end' && ['completed', 'failed', 'cancelled'].includes(String(ev.status))) return { ...base, kind: 'turn', turnID, state: ev.status };
        if (ev.t === 'text' && typeof ev.text === 'string' && ev.thinking !== true) return { ...base, kind: 'text', turnID, text: redact(ev.text).slice(0, 16000), truncated: ev.text.length > 16000 };
    }
    if (body.type === 'text' && typeof body.text === 'string') return { ...base, kind: 'text', text: redact(body.text).slice(0, 16000) };
    return { ...base, kind: 'omitted' };
}

export class AutomationControl {
    constructor(private transport: Transport, private policy: Policy, private journal: Journal) {}
    private allowedMachine(machineID: string) {
        const machine = this.policy.machines.find(m => m.id === machineID);
        if (!machine) throw new ControlError('FORBIDDEN');
        return machine;
    }
    private allowedEntry(entry: RecordEntry) {
        const machine = this.allowedMachine(entry.machineID);
        if (entry.directory && !machine.directories.includes(entry.directory)) throw new ControlError('FORBIDDEN');
        if (entry.method !== 'tasks.create' && entry.sessionID && !this.sessionAllowed(entry.sessionID)) throw new ControlError('FORBIDDEN');
    }
    private sessionAllowed(sessionID: string) {
        return this.policy.sessionIDs.includes(sessionID) || this.journal.entries().some(e => e.method === 'tasks.create' && e.sessionID === sessionID
            && this.policy.machines.some(m => m.id === e.machineID && m.directories.includes(e.directory!)));
    }
    private async machine(machineID: string) {
        this.allowedMachine(machineID);
        const machine = (await this.transport.machines()).find(m => m.id === machineID);
        if (!machine) throw new ControlError('NOT_FOUND');
        // The encrypted RPC is authoritative; relay activity is only a presence hint.
        return machine;
    }
    private async session(sessionID: string): Promise<DecryptedSession> {
        if (!this.sessionAllowed(sessionID)) throw new ControlError('FORBIDDEN');
        let cursor: string | undefined;
        do {
            const page = await this.transport.sessions(cursor);
            const session = page.sessions.find(s => s.id === sessionID);
            if (session) {
                this.allowedMachine(id(obj(session.metadata).machineId));
                if (!this.policy.sessionIDs.includes(sessionID) && !this.journal.entries().some(e => e.method === 'tasks.create' && e.sessionID === sessionID
                    && e.machineID === obj(session.metadata).machineId && e.directory === obj(session.metadata).path
                    && this.policy.machines.some(m => m.id === e.machineID && m.directories.includes(e.directory!)))) throw new ControlError('FORBIDDEN');
                if (obj(session.metadata).flavor !== 'codex') throw new ControlError('UNSUPPORTED_AGENT');
                return session;
            }
            if (page.nextCursor === cursor) throw new ControlError('INVALID_RELAY_RESPONSE');
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        throw new ControlError('NOT_FOUND');
    }
    private async rpc(entry: RecordEntry, operation: string) {
        this.allowedEntry(entry);
        const reply = await this.transport.rpc(await this.machine(entry.machineID), {
            version: 1, operation, requestID: entry.requestID, directory: entry.directory, sessionID: entry.sessionID,
        });
        if (reply.errorCode === 'NOT_FOUND' && operation === 'request') return { state: 'unavailable', safeToRetrySameRequestID: true };
        if (reply.errorCode) throw new ControlError(String(reply.errorCode));
        return reply;
    }
    private receipt(entry: RecordEntry) {
        return { requestID: entry.requestID, ...(entry.method === 'tasks.create' ? { taskID: entry.requestID } : {}),
            machineID: entry.machineID, sessionID: entry.sessionID, state: entry.state, messageID: entry.messageID, seq: entry.seq };
    }
    private async lookup(entry: RecordEntry) {
        this.allowedEntry(entry);
        if (entry.method === 'sessions.send') {
            if (entry.state !== 'submitted') {
                const session = await this.session(entry.sessionID!);
                // Incremental reconciliation; absence in one page proves nothing.
                const page = await this.transport.messages(session, entry.cursor ?? 0, 500);
                const found = page.messages.find(m => m.localId === `automation:${entry.requestID}`);
                if (found) { entry.state = 'submitted'; entry.messageID = found.id; entry.seq = found.seq; }
                entry.cursor = page.messages.at(-1)?.seq ?? entry.cursor;
                this.journal.save(entry);
                return { ...this.receipt(entry), hasMore: page.hasMore, reconciliationCursor: entry.cursor ?? 0 };
            }
            return this.receipt(entry);
        }
        const reply = await this.rpc(entry, 'request');
        if (reply.sessionID !== undefined) entry.sessionID = id(reply.sessionID);
        entry.state = receiptState(reply.state);
        this.journal.save(entry);
        return { ...this.receipt(entry), process: processState(reply.process), safeToRetrySameRequestID: reply.safeToRetrySameRequestID === true };
    }
    async handle(input: unknown): Promise<unknown> {
        let requestID: string | undefined;
        try {
            const req = obj(input);
            requestID = req.requestID === undefined ? undefined : id(req.requestID);
            if (req.version !== 1 || typeof req.method !== 'string' || !methods.includes(req.method as typeof methods[number])) throw new ControlError('INVALID_REQUEST');
            if (!this.policy.methods.includes(req.method)) throw new ControlError('FORBIDDEN');
            const fields: Record<string, string[]> = {
                'machines.list': ['cursor', 'limit'], 'sessions.list': ['cursor', 'limit'],
                'tasks.create': ['machineID', 'directory'], 'requests.get': [],
                'sessions.send': ['sessionID', 'taskID', 'text'], 'sessions.cancel': ['sessionID', 'taskID'],
                'sessions.status': ['sessionID', 'taskID', 'cursor', 'limit'], 'sessions.logs': ['sessionID', 'taskID', 'cursor', 'limit'],
                'sessions.result': ['sessionID', 'taskID', 'cursor', 'limit', 'turnID'],
            };
            const allowed = ['version', 'method', 'requestID', ...fields[req.method]];
            if (Object.keys(req).some(k => !allowed.includes(k))) throw new ControlError('INVALID_REQUEST');
            const result = await this.execute(req);
            return { version: 1, ok: true, requestID, data: result };
        } catch (error) {
            // Never serialize Axios/socket errors: they can include Authorization and plaintext.
            const code = error instanceof ControlError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'UNAVAILABLE_OR_UNKNOWN';
            return { version: 1, ok: false, requestID, error: { code, retryable: false, instruction: 'For mutations, query requests.get with the same requestID; never dispatch with a new ID to retry an uncertain result.' } };
        }
    }
    private async execute(req: Record<string, unknown>): Promise<unknown> {
        const method = req.method as string;
        if (method === 'machines.list') {
            const limit = integer(req.limit, 100, 200);
            if (!limit) throw new ControlError('INVALID_REQUEST');
            const cursor = req.cursor === undefined ? '' : id(req.cursor);
            const machines = (await this.transport.machines()).filter(m => this.policy.machines.some(p => p.id === m.id)).sort((a,b) => a.id.localeCompare(b.id)).filter(m => m.id > cursor);
            const page = machines.slice(0, limit);
            return { machines: page.map(m => ({ machineID: m.id, availability: m.active ? 'online_hint' : 'offline_hint', activeAt: m.activeAt })), nextCursor: machines.length > limit ? page.at(-1)!.id : null };
        }
        if (method === 'sessions.list') {
            const limit = integer(req.limit, 100, 200);
            if (!limit || (req.cursor !== undefined && (typeof req.cursor !== 'string' || !/^cursor_v1_[a-zA-Z0-9_-]+$/.test(req.cursor)))) throw new ControlError('INVALID_REQUEST');
            const page = await this.transport.sessions(req.cursor as string | undefined, limit);
            return { sessions: page.sessions.filter(s => this.sessionAllowed(s.id) && this.policy.machines.some(m => m.id === obj(s.metadata).machineId)).map(s => ({ sessionID: s.id, machineID: obj(s.metadata).machineId, availability: s.active ? 'online_hint' : 'offline_hint' })), nextCursor: page.nextCursor };
        }
        if (method === 'requests.get') {
            const entry = this.journal.get(id(req.requestID));
            if (!entry) throw new ControlError('NOT_FOUND');
            return this.lookup(entry);
        }
        let sessionID: string | undefined;
        if (method !== 'tasks.create') {
            if (req.taskID !== undefined) {
                const task = this.journal.get(id(req.taskID));
                if (!task || task.method !== 'tasks.create' || !task.sessionID) throw new ControlError('TASK_NOT_CONFIRMED');
                this.allowedEntry(task);
                sessionID = task.sessionID;
                if (req.sessionID !== undefined && req.sessionID !== sessionID) throw new ControlError('TARGET_CONFLICT');
            } else sessionID = id(req.sessionID);
        }
        if (method === 'sessions.logs' || method === 'sessions.status' || method === 'sessions.result') {
            const requestedTurn = method === 'sessions.result' ? id(req.turnID) : undefined;
            const session = await this.session(sessionID!);
            const cursor = integer(req.cursor, 0, Number.MAX_SAFE_INTEGER), limit = integer(req.limit, 100, 500);
            if (!limit) throw new ControlError('INVALID_REQUEST');
            const page = await this.transport.messages(session, cursor, limit);
            const messages = page.messages.map(projectMessage);
            const turn = [...messages].reverse().find(m => m.kind === 'turn');
            if (requestedTurn) {
                const evidence = messages.filter(m => 'turnID' in m && m.turnID === requestedTurn);
                const end = evidence.find(m => m.kind === 'turn' && 'state' in m && ['completed', 'failed', 'cancelled'].includes(String(m.state)));
                return { sessionID, turnID: requestedTurn, attribution: 'session_turn_only', ready: !!end,
                    outcome: end && 'state' in end ? end.state : 'unknown', messages: evidence,
                    nextCursor: page.messages.at(-1)?.seq ?? cursor, hasMore: page.hasMore };
            }
            const process = method === 'sessions.status' ? await this.transport.rpc(await this.machine(id(obj(session.metadata).machineId)), { version: 1, operation: 'status', sessionID }) : undefined;
            if (process?.errorCode) throw new ControlError(String(process.errorCode));
            return { sessionID, process: process ? processState(process.process) : undefined, turn: turn ?? { state: 'unknown' },
                waitingForPermission: Object.keys(obj(obj(session.agentState).requests)).length > 0,
                messages, nextCursor: page.messages.at(-1)?.seq ?? cursor, hasMore: page.hasMore };
        }
        const requestID = id(req.requestID);
        let entry: RecordEntry;
        if (method === 'tasks.create') {
            const machineID = id(req.machineID), directory = req.directory;
            if (typeof directory !== 'string' || !this.allowedMachine(machineID).directories.includes(directory)) throw new ControlError('FORBIDDEN');
            if (req.text !== undefined) throw new ControlError('SEND_SEPARATELY');
            entry = { requestID, method, machineID, directory, fingerprint: hash(JSON.stringify({ method, machineID, directory })), state: 'unknown' };
        } else {
            const session = await this.session(sessionID!);
            if (method === 'sessions.send' && (typeof req.text !== 'string' || !req.text.trim() || req.text.length > 100000)) throw new ControlError('INVALID_REQUEST');
            const machineID = id(obj(session.metadata).machineId);
            entry = { requestID, method, machineID, sessionID, fingerprint: hash(JSON.stringify({ method, sessionID, text: req.text })), state: 'unknown' };
        }
        if (!this.journal.claim(entry)) {
            const prior = this.journal.get(requestID)!;
            if (prior.fingerprint !== entry.fingerprint) throw new ControlError('REQUEST_ID_CONFLICT');
            if (!['unknown', 'unavailable'].includes(prior.state)) return this.lookup(prior);
            // An explicit repeat of the SAME payload/key can use the receiver's durable deduplication.
            // requests.get itself stays read-only and never retries a mutation.
            entry = prior;
        }
        if (method === 'sessions.send') {
            const sent = await this.transport.send(await this.session(sessionID!), requestID, req.text as string);
            entry.state = 'submitted'; entry.messageID = sent.id; entry.seq = sent.seq;
            this.journal.save(entry);
            return this.receipt(entry);
        }
        const reply = await this.rpc(entry, method === 'tasks.create' ? 'create' : 'cancel');
        if (reply.sessionID !== undefined) entry.sessionID = id(reply.sessionID);
        entry.state = receiptState(reply.state);
        this.journal.save(entry);
        return { ...this.receipt(entry), process: processState(reply.process) };
    }
}
