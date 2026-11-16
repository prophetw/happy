import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { runHostedDot } from '@fixture/main';
import { HostedDotConfig, loadHostedState, savePrivate } from '@fixture/state';
import { saveHostedStorage, readHostedStorage, migrateHostedStorage } from '@fixture/storage';
const [directory, backend, relay, countText, intervalText, historyText, restartText] = process.argv.slice(2);
const count = Number(countText), history = Number(historyText), restart = restartText === 'restart';
mkdirSync(directory, { recursive: true, mode: 0o700 });
const home = join(directory, 'home'), runtime = join(directory, 'runtime');
for (const p of [home, runtime]) mkdirSync(p, { recursive: true, mode: 0o700 });
const config = HostedDotConfig.parse({ version: 1, dotId: '00000000-0000-4000-8000-000000000001', sessionId: 'fixture-session',
    happyHome: home, directory: runtime, codexHome: join(directory, 'codex'), serverUrl: relay, executable: process.execPath,
    args: [process.env.FIXTURE_APP_SERVER, join(directory, 'native.json'), String(count), intervalText],
    model: 'fixture', effort: 'high', provider: 'openai', providerConfig: {}, instruction: 'synthetic benchmark', environment: [] });
globalThis.__fixtureDotId = config.dotId;
for (const [name, value] of Object.entries({ 'access.key': { token: 'synthetic-only', serverUrl: relay },
    'sessions.json': { sessions: { 'fixture-session': { encryptionVariant: 'dataKey', encryptionKey: Buffer.alloc(32).toString('base64') } } } }))
    writeFileSync(join(home, name), JSON.stringify(value), { mode: 0o600 });
writeFileSync(join(runtime, 'config.json'), JSON.stringify(config), { mode: 0o600 });
const file = join(runtime, 'state.json');
if (!restart) {
    const seed = loadHostedState(file, config);
    const body = n => ({ id: `history-${n}`, time: 1, role: 'agent', turn: 'history', ev: { t: 'text', text: 'synthetic' } });
    seed.outputs = Array.from({ length: history }, (_, n) => ({ localId: `hosted:0:history-${n}`, sent: true, envelope: body(n) }));
    seed.inputs = Array.from({ length: 190 }, (_, n) => ({ epoch: 0, seq: n + 1, id: `input-${n}`, text: 'synthetic settled', status: 'completed', delivery: 'queue', turnId: `old-${n}`, beforeTurns: [] }));
    seed.inputs.push({ epoch: 0, seq: 191, id: 'fixture-input', text: 'synthetic request', status: 'queued', delivery: 'queue' });
    seed.controls = Array.from({ length: 58 }, (_, n) => `synthetic-control-${n}`);
    seed.afterSeq = 191;
    const padding = history ? Math.max(0, Math.floor((13 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(seed))) / history)) : 0;
    for (const row of seed.outputs) row.envelope.ev.text += 'x'.repeat(padding);
    savePrivate(file, seed);
    if (backend === 'sqlite') migrateHostedStorage(runtime, () => {}); // Synthetic directory only; happy-path setup, not a migration test.
}
if (restart) writeFileSync(join(directory, 'restart-durable-ids.json'), JSON.stringify(readHostedStorage(file).outputs.map(row => row.localId)), { mode: 0o600 });
const metrics = { persists: 0, persistMs: 0, persistMaxMs: 0, queuePeak: 0, notifications: 0, nativeFailures: 0, generated: [], consumed: [] };
globalThis.__fixtureNativeEvent = event => { if (event.type === 'turn_aborted' && event.status === 'failed') metrics.nativeFailures++; };
globalThis.__fixtureRead = readHostedStorage;
globalThis.__fixtureWrite = (file, state) => {
    const firstText = state.outputs.find(row => row.localId.endsWith('fixture-item:0'));
    if (!restart && process.env.FIXTURE_FAULT === 'ack' && firstText?.sent) process.exit(86); // Verified, ACK not yet durable.
    const start = performance.now(); saveHostedStorage(file, state);
    const ms = performance.now() - start; metrics.persists++; metrics.persistMs += ms; metrics.persistMaxMs = Math.max(ms, metrics.persistMaxMs);
    metrics.queuePeak = Math.max(metrics.queuePeak, state.outputs.filter(row => !row.sent).length);
    if (!restart && process.env.FIXTURE_FAULT === 'durable' && firstText) process.exit(86); // Durable, not yet admitted to transport.
};
globalThis.__fixtureNotification = (method, params) => {
    if (method === 'item/agentMessage/delta') { metrics.notifications++; metrics.generated.push(params.generatedAt); metrics.consumed.push(Date.now()); }
};
const cpu = process.cpuUsage(), start = performance.now(), lag = monitorEventLoopDelay({ resolution: 5 }); lag.enable();
const controller = new AbortController();
let settled = false;
const task = runHostedDot(config, controller.signal).finally(() => { settled = true; });
const timeout = setTimeout(() => controller.abort(), 180000);
const poll = setInterval(() => {
    if (settled) return;
    if (existsSync(join(directory, 'relay-complete'))) controller.abort();
}, 25);
try { await task; } finally { clearInterval(poll); clearTimeout(timeout); lag.disable(); }
const state = readHostedStorage(file), outputs = state.outputs.filter(row => !row.localId.startsWith('hosted:0:history-'));
const native = JSON.parse(readFileSync(join(directory, 'native.json'), 'utf8'));
const usage = process.cpuUsage(cpu), end = performance.now();
const report = { ...metrics, backend, history, logicalBytes: Buffer.byteLength(JSON.stringify(state)), wallMs: end - start,
    cpuMs: (usage.user + usage.system) / 1000, eventLoopP50Ms: lag.percentile(50) / 1e6, eventLoopP95Ms: lag.percentile(95) / 1e6,
    stateStatus: state.status, threadId: state.threadId, epoch: state.epoch, dispatches: native.dispatches,
    input: state.inputs.at(-1), outputs: outputs.map(row => ({ localId: row.localId, sent: row.sent, envelope: row.envelope })) };
writeFileSync(join(directory, 'worker-result.json'), JSON.stringify(report), { mode: 0o600 });
process.stdout.write(JSON.stringify({ done: true, backend, persists: report.persists }) + '\n');
