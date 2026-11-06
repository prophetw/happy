import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readPrivate } from './hostedDotState';
const h = vi.hoisted(() => ({ options: null as any, event: null as any, rows: [] as any[], history: [] as any[], sent: [] as any[],
    send: vi.fn(), steer: vi.fn(), resume: vi.fn(), reconnect: vi.fn(), receive: null as any }));
vi.mock('./codexAppServerClient', () => ({ CodexAppServerClient: class {
    constructor(_: unknown, options: any) { h.options = options; }
    connect = async () => {}; disconnect = async () => {};
    setApprovalHandler() {} setEventHandler(fn: any) { h.event = fn; }
    startThread = async () => ({ threadId: 'native-thread', model: 'test' });
    resumeThread = h.resume; readThread = async () => ({ thread: { id: 'native-thread', turns: h.history } });
    reconnectAndResumeThread = h.reconnect;
    sendTurnAndWait = h.send; steerTurn = h.steer;
    abortTurnWithFallback = async () => { h.event({ type: 'turn_aborted' }); return { forcedRestart: true, resumedThread: true }; };
} }));
vi.mock('../api/api', () => ({ ApiClient: { create: async () => ({ attachSession: async () => ({}) }) } }));
vi.mock('../api/apiSession', () => ({ ApiSessionClient: class {
    timer: ReturnType<typeof setInterval>;
    constructor(_token: string, _session: unknown, _credential: unknown, options: any) {
        h.receive = options.receive;
        this.timer = setInterval(() => { for (const row of h.rows.splice(0)) options.receive.onMessage(row); }, 10);
    }
    rpcHandlerManager = { registerHandler() {} };
    waitForConnection = async () => {}; updateMetadata = async () => {}; updateAgentState = async () => {};
    sendSessionDeath() {} keepAlive() {} close = async () => { clearInterval(this.timer); };
    sendSessionProtocolMessageVerified = async (envelope: unknown, localId: string) => { h.sent.push({ localId, envelope }); };
} }));
import { runHostedDot } from './hostedDotMain';
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-loop-')), home = join(dir, 'happy'), data = join(dir, 'runtime');
    mkdirSync(home); mkdirSync(data);
    writeFileSync(join(home, 'credential-target.key'), JSON.stringify({ token: 'fixture-token', serverUrl: 'http://127.0.0.1:1234' }));
    symlinkSync(join(home, 'credential-target.key'), join(home, 'access.key'));
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: { session: { encryptionVariant: 'dataKey', encryptionKey: Buffer.alloc(32).toString('base64') } } }));
    const config = { version: 1, dotId: randomUUID(), sessionId: 'session', happyHome: home, serverUrl: 'http://127.0.0.1:1234', directory: data,
        executable: 'codex', args: [], model: 'test', provider: 'openai', providerConfig: {}, instruction: 'chat only', codexHome: join(dir, 'codex'), environment: [] };
    const controller = new AbortController(), running = runHostedDot(config, controller.signal), state = () => readPrivate(join(data, 'state.json'));
    return { config, state, running, stop: async () => { controller.abort(); await running; rmSync(dir, { recursive: true }); } };
}
const row = (seq: number, text: string, deliveryMode = 'queue') => ({ id: String(seq), seq, body: { role: 'user', content: { type: 'text', text }, meta: { deliveryMode } } });
const emit = (method: string, params: any) => {
    h.options.onNotification(method, { threadId: 'native-thread', ...params });
    if (method === 'turn/started') h.event({ type: 'task_started', thread_id: 'native-thread', turn_id: params.turn.id });
    if (method === 'turn/completed') h.event({ type: 'task_complete', thread_id: 'native-thread', turn_id: params.turn.id, status: params.turn.status });
};
beforeEach(() => { vi.clearAllMocks(); h.rows = []; h.history = []; h.sent = []; h.resume.mockResolvedValue({ threadId: 'native-thread' }); h.reconnect.mockResolvedValue(true); });
it('settles steering when completion arrives before its RPC acknowledgement', async () => {
    let finish!: (v: unknown) => void;
    h.send.mockImplementation(() => { emit('turn/started', { turn: { id: 'turn-1' } }); return new Promise(resolve => { finish = resolve; }); });
    h.steer.mockImplementation(async () => { emit('turn/completed', { turn: { id: 'turn-1', status: 'completed' } }); finish({ aborted: false }); return true; });
    const f = fixture();
    try {
        h.rows.push(row(1, 'first')); await vi.waitFor(() => expect(f.state().inputs[0]?.status).toBe('accepted'));
        h.rows.push(row(2, 'steering', 'steer')); await vi.waitFor(() => expect(f.state().inputs[1]?.status).toBe('completed'));
        expect(h.send).toHaveBeenCalledTimes(1); expect(h.steer).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
it('reconciles a native child crash without replaying accepted input', async () => {
    h.send.mockImplementation(async () => {
        emit('turn/started', { turn: { id: 'turn-1' } });
        h.history = [{ id: 'turn-1', status: 'interrupted', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'first' }] }] }];
        h.event({ type: 'turn_aborted', status: 'failed', error: { codexErrorInfo: 'transportError' } });
        return { aborted: true };
    });
    const f = fixture();
    try {
        h.rows.push(row(1, 'first')); await vi.waitFor(() => expect(h.reconnect).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(f.state().inputs[0]?.status).toBe('interrupted'));
        expect(f.state().threadId).toBe('native-thread'); expect(h.send).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
it('leaves unconfirmed native dispatch blocked instead of retrying', async () => {
    h.send.mockRejectedValue(new Error('connection lost before reply'));
    const f = fixture();
    try {
        h.rows.push(row(1, 'first')); await vi.waitFor(() => expect(f.state().status).toBe('blocked'));
        expect(f.state().inputs[0].status).toBe('unknown'); expect(h.send).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
it('keeps a synthetic forced abort interrupted rather than leaving input unknown', async () => {
    h.send.mockImplementation(async () => { emit('turn/started', { turn: { id: 'turn-1' } }); h.event({ type: 'turn_aborted' }); return { aborted: true }; });
    const f = fixture();
    try {
        h.rows.push(row(1, 'first')); await vi.waitFor(() => expect(f.state().inputs[0]?.status).toBe('interrupted'));
        expect(f.state().status).toBe('ready'); expect(h.send).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
