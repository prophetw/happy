import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { DecryptedSession } from '../../../api';
import type { Transport } from '../../relay';
import type { WorkerRegistration } from '../schema';

// Isolated, repeatable idle-workload comparison. No relay, credentials or model calls.
// node --import tsx src/automation/rest/fixtures/workerEfficiencyBenchmark.ts [worker.ts]
const moduleURL = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : new URL('../worker.ts', import.meta.url).href;
const { ScopedWorker } = await import(moduleURL) as typeof import('../worker');
const root = mkdtempSync(join(tmpdir(), 'happy-worker-benchmark-'));
try {
    const sessionCount = 24, historyLength = 600, rounds = 5;
    const sessions = Array.from({ length: sessionCount }, (_, index) => ({ id: 'idle-' + index, seq: historyLength,
        metadata: { machineId: 'machine', path: root, hostPid: 99999999 } }) as DecryptedSession);
    const history = Array.from({ length: historyLength }, (_, index) => ({ id: 'm' + index, seq: index + 1, localId: null,
        content: { role: 'user', content: { type: 'text', text: 'isolated benchmark message' } } }));
    let sessionListCalls = 0, messagePageCalls = 0, returnedMessages = 0, queueTransactions = 0;
    const transport: Transport = {
        machines: async () => [{ id: 'machine' }] as any,
        sessions: async () => { sessionListCalls++; return { sessions, nextCursor: null }; },
        messages: async (_session, cursor, limit) => {
            messagePageCalls++; const tail = history.filter(message => message.seq > cursor), page = tail.slice(0, limit);
            returnedMessages += page.length; return { messages: page, hasMore: tail.length > limit };
        },
        rpc: async () => ({ version: 1, process: 'stopped' }),
        send: async () => { throw Error('BENCHMARK_MUST_NOT_SEND'); },
    };
    const registration: WorkerRegistration = { id: 'worker', userID: 'owner', name: 'Benchmark', machineID: 'machine', publicKey: 'fixture', projects: [], methods: [], protocol: 1 };
    const worker = new ScopedWorker(registration, transport, join(root, 'worker'), async () => { throw Error('BENCHMARK_MUST_NOT_AUTHORIZE'); }, Date.now, undefined, undefined, join(root, 'queue'));
    const transaction = worker.queue.transaction.bind(worker.queue);
    worker.queue.transaction = fn => { queueTransactions++; return transaction(fn); };
    const elapsed: number[] = [], cpuBefore = process.cpuUsage();
    for (let round = 0; round < rounds; round++) { const before = performance.now(); await worker.tick(); elapsed.push(Math.round((performance.now() - before) * 100) / 100); }
    const cpu = process.cpuUsage(cpuBefore);
    process.stdout.write(JSON.stringify({ moduleURL, sessionCount, historyLength, rounds, sessionListCalls, messagePageCalls, returnedMessages, queueTransactions,
        elapsedMs: elapsed, totalMs: Math.round(elapsed.reduce((a, b) => a + b, 0) * 100) / 100, cpuMs: Math.round((cpu.user + cpu.system) / 1000) }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
