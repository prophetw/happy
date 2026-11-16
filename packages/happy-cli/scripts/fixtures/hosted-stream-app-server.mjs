// Synthetic JSONL app-server. Never reads credentials or real threads.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.argv[2], count = Number(process.argv[3]), interval = Number(process.argv[4]);
const text = Array.from({ length: count }, (_, n) => n % 7 === 0 ? '🙂' : '文').join('');
const thread = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { id: 'fixture-thread', turns: [] };
const emit = (method, params) => process.stdout.write(JSON.stringify({ method, params: { threadId: 'fixture-thread', turnId: 'fixture-turn', ...params } }) + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\n');
createInterface({ input: process.stdin }).on('line', async line => {
    const msg = JSON.parse(line); if (msg.id === undefined) return;
    if (msg.method === 'initialize') return reply(msg.id, { userAgent: 'synthetic' });
    if (msg.method === 'model/list') return reply(msg.id, { data: [{ model: 'fixture', displayName: 'fixture', description: '', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high', isDefault: true }] });
    if (msg.method === 'thread/start' || msg.method === 'thread/resume') return reply(msg.id, { thread: thread(), model: 'fixture' });
    if (msg.method === 'thread/read') return reply(msg.id, { thread: thread() });
    if (msg.method === 'turn/interrupt') { emit('turn/completed', { turn: { id: 'fixture-turn', status: 'interrupted', items: [] } }); return reply(msg.id, {}); }
    if (msg.method !== 'turn/start') return reply(msg.id, {});
    const state = thread();
    state.dispatches = (state.dispatches ?? 0) + 1;
    const turn = { id: 'fixture-turn', status: 'completed', items: [
        { id: 'input', type: 'userMessage', content: [{ type: 'text', text: msg.params.input[0].text }] },
        { id: 'fixture-item', type: 'agentMessage', text } ] };
    // Fake native rollout is durable before notifications, permitting cold read/reconcile.
    state.turns = [turn]; writeFileSync(file, JSON.stringify(state));
    reply(msg.id, { turn: { id: turn.id } });
    emit('turn/started', { turn: { id: turn.id, status: 'inProgress', items: [] } });
    let n = 0;
    const tick = () => {
        if (n < count) {
            emit('item/agentMessage/delta', { itemId: 'fixture-item', delta: n % 7 === 0 ? '🙂' : '文', generatedAt: Date.now(), index: n++ });
            setTimeout(tick, interval);
        } else {
            emit('item/completed', { item: { id: 'fixture-item', type: 'agentMessage', text } });
            emit('turn/completed', { turn });
            if (process.env.FIXTURE_NATIVE_EXIT === '1') process.stdout.end(() => process.exit(0));
        }
    };
    setTimeout(tick, 1);
});
