import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readPrivate } from './hostedDotState';
const h = vi.hoisted(() => ({ options: null as any, event: null as any, rows: [] as any[], history: [] as any[], sent: [] as any[],
    start: vi.fn(), send: vi.fn(), steer: vi.fn(), resume: vi.fn(), reconnect: vi.fn(), receive: null as any }));
vi.mock('./codexAppServerClient', () => ({ CodexAppServerClient: class {
    constructor(_: unknown, options: any) { h.options = options; }
    connect = async () => {}; disconnect = async () => {};
    setApprovalHandler() {} setEventHandler(fn: any) { h.event = fn; }
    startThread = h.start;
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
function fixture(gateway = false) {
    const dir = mkdtempSync(join(tmpdir(), 'hosted-loop-')), home = join(dir, 'happy'), data = join(dir, 'runtime');
    mkdirSync(home); mkdirSync(data);
    writeFileSync(join(home, 'credential-target.key'), JSON.stringify({ token: 'fixture-token', serverUrl: 'http://127.0.0.1:1234' }));
    symlinkSync(join(home, 'credential-target.key'), join(home, 'access.key'));
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions: { session: { encryptionVariant: 'dataKey', encryptionKey: Buffer.alloc(32).toString('base64') } } }));
    const config = { version: 1, dotId: randomUUID(), sessionId: 'session', happyHome: home, serverUrl: 'http://127.0.0.1:1234', directory: data,
        executable: 'codex', args: [], model: 'test', provider: 'openai', providerConfig: {}, instruction: 'chat only', codexHome: join(dir, 'codex'), environment: [] };
    const servers = { happy_fixture: { command: '/usr/bin/node', args: ['/fixture/gateway.mjs'], startup_timeout_sec: 30, tool_timeout_sec: 30, required: true, default_tools_approval_mode: 'approve' } };
    const policy = (value: unknown) => writeFileSync(join(data, 'task-gateway.json'), JSON.stringify({ version: 1, dotId: config.dotId, sessionId: config.sessionId, servers: value }));
    if (gateway) policy(servers);
    let controller = new AbortController(), running = runHostedDot(config, controller.signal);
    const state = () => readPrivate(join(data, 'state.json'));
    const event = (id: string, epoch = 0, overrides: any = {}) => {
        mkdirSync(join(data, 'events'), { recursive: true });
        writeFileSync(join(data, 'events', `task-${id.repeat(64)}.json`), JSON.stringify({ version: 1, id: `task-${id.repeat(64)}`, dotId: config.dotId, sessionId: config.sessionId, epoch, createdAt: new Date().toISOString(), text: 'result event ' + id, ...overrides }));
    };
    return { config, state, running, servers, policy, event,
        restart: async () => { controller.abort(); await running; controller = new AbortController(); running = runHostedDot(config, controller.signal); },
        stop: async () => { controller.abort(); try { await running; } finally { rmSync(dir, { recursive: true }); } } };

}
const row = (seq: number, text: string, deliveryMode = 'queue') => ({ id: String(seq), seq, body: { role: 'user', content: { type: 'text', text }, meta: { deliveryMode } } });
const emit = (method: string, params: any) => {
    h.options.onNotification(method, { threadId: 'native-thread', ...params });
    if (method === 'turn/started') h.event({ type: 'task_started', thread_id: 'native-thread', turn_id: params.turn.id });
    if (method === 'turn/completed') h.event({ type: 'task_complete', thread_id: 'native-thread', turn_id: params.turn.id, status: params.turn.status });
};
beforeEach(() => { vi.clearAllMocks(); h.rows = []; h.history = []; h.sent = []; h.start.mockResolvedValue({ threadId: 'native-thread', model: 'test' }); h.resume.mockResolvedValue({ threadId: 'native-thread' }); h.reconnect.mockResolvedValue(true); });
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

it('mounts scoped MCP servers at start, refreshes on the same thread and retains them after restart', async () => {
    h.send.mockImplementation(async () => { emit('turn/started', { turn: { id: 'user-turn' } }); emit('turn/completed', { turn: { id: 'user-turn', status: 'completed' } }); });
    const f = fixture(true);
    try {
        await vi.waitFor(() => expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: f.servers })));
        expect(h.options.config.mcp_servers).toEqual(f.servers);
        h.rows.push(row(1, 'dispatch')); await vi.waitFor(() => expect(f.state().inputs[0]?.status).toBe('completed'));
        f.policy({}); await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'native-thread', mcpServers: {} })));
        await f.restart(); await vi.waitFor(() => expect(h.resume).toHaveBeenCalledTimes(2));
        expect(f.state().threadId).toBe('native-thread'); expect(h.start).toHaveBeenCalledTimes(1); expect(h.send).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
it('delivers an internal task event once on the original thread without inventing a Relay user sequence', async () => {
    h.send.mockImplementation(async () => { emit('turn/started', { turn: { id: 'event-turn' } }); emit('turn/completed', { turn: { id: 'event-turn', status: 'completed' } }); });
    const f = fixture();
    try {
        await vi.waitFor(() => expect(f.state().status).toBe('ready'));
        f.event('a'); await vi.waitFor(() => expect(f.state().inputs[0]?.status).toBe('completed'));
        expect(f.state().inputs[0]).toMatchObject({ origin: 'task-result', epoch: 0 });
        expect(f.state().inputs[0].seq).toBeUndefined(); expect(f.state().afterSeq).toBe(0);
        f.event('b', 9); await f.restart(); await vi.waitFor(() => expect(h.resume).toHaveBeenCalledTimes(1));
        expect(f.state().inputs).toHaveLength(1); expect(h.send).toHaveBeenCalledTimes(1);
    } finally { await f.stop(); }
});
it('rejects a task event bound to another Dot before starting a model turn', async () => {
    const f = fixture();
    const failed = expect(f.running).rejects.toThrow('hosted_task_event_binding_changed');
    try {
        await vi.waitFor(() => expect(f.state().status).toBe('ready'));
        f.event('c', 0, { dotId: randomUUID() });
        await vi.waitFor(() => expect(f.state().status).toBe('blocked'));
        expect(f.state().error).toBe('hosted_task_event_binding_changed'); expect(h.send).not.toHaveBeenCalled(); await failed;
    } finally { await expect(f.stop()).rejects.toThrow('hosted_task_event_binding_changed'); }
});

it('mounts the dedicated memory gateway on an existing thread without replacing history', async () => {
    const f = fixture(true);
    try {
        await vi.waitFor(() => expect(f.state().status).toBe('ready'));
        f.policy({ ...f.servers, dot_memory: f.servers.happy_fixture });
        await vi.waitFor(() => expect(h.resume).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'native-thread', mcpServers: expect.objectContaining({ dot_memory: f.servers.happy_fixture }) })));
        expect(f.state().threadId).toBe('native-thread'); expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.options.instructions).toContain('dot_memory_');
    } finally { await f.stop(); }
});
