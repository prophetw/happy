import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Transport } from '../../relay';
import { hash } from '../../journal';
import { privateDirectory, privateRead } from '../privateFs';
import { ApiError, type WorkerRegistration } from '../schema';
import { MetadataStore } from '../store';
import { TaskQueue, terminalTask } from '../taskQueue';
import { ScopedWorker } from '../worker';

// Run with node --import tsx src/automation/rest/fixtures/workerQueueBenchmark.ts <private snapshot under TMPDIR>.
const queueFile = hash('queue') + '.json';
const machineID = 'benchmark-machine';
const phaseNames = ['lock', 'readValidate', 'callback', 'prepareWrite', 'persist', 'finish'] as const;
type Sample = { started: number; ended: number; lockAcquired: number; timings: Record<typeof phaseNames[number], number>; writes: number };
type Operation = { processIndex: number; started: number; ended: number; transactions: Sample[] };
const now = () => performance.timeOrigin + performance.now();

function measureQueue(queue: TaskQueue) {
    let active: { read?: number; set?: number; committed?: number } | undefined;
    let transactions: Sample[] = [];
    const originalGet = MetadataStore.prototype.get, originalSet = MetadataStore.prototype.set;
    const originalTransaction = queue.transaction.bind(queue);
    MetadataStore.prototype.get = function<T>(key: string): T | null {
        if (active && key === 'queue') active.read = now();
        return originalGet.call(this, key) as T | null;
    };
    MetadataStore.prototype.set = function(key: string, value: unknown) {
        if (active && key === 'queue') active.set = now();
        originalSet.call(this, key, value);
        if (active && key === 'queue') active.committed = now();
    };
    queue.transaction = (fn, readOnly) => {
        const probe: NonNullable<typeof active> = {};
        active = probe;
        const started = now();
        let callbackStarted = 0, callbackEnded = 0;
        try {
            const value = originalTransaction(state => {
                callbackStarted = now();
                const result = fn(state);
                callbackEnded = now();
                return result;
            }, readOnly);
            const ended = now(), { read, set, committed } = probe;
            if (read === undefined || !callbackStarted || !callbackEnded || set !== undefined && committed === undefined)
                throw Error('QUEUE_BENCHMARK_MISSING_TIMING');
            transactions.push({ started, ended, lockAcquired: read, writes: committed === undefined ? 0 : 1, timings: {
                lock: read - started, readValidate: callbackStarted - read, callback: callbackEnded - callbackStarted,
                prepareWrite: (set ?? callbackEnded) - callbackEnded, persist: (committed ?? callbackEnded) - (set ?? callbackEnded),
                finish: ended - (committed ?? callbackEnded),
            } });
            return value;
        } finally { active = undefined; }
    };
    return {
        take(processIndex: number, started: number): Operation {
            const result = { processIndex, started, ended: now(), transactions };
            transactions = [];
            return result;
        },
        restore() {
            queue.transaction = originalTransaction;
            MetadataStore.prototype.get = originalGet;
            MetadataStore.prototype.set = originalSet;
        },
    };
}

function copySnapshot(from: string, to: string) {
    privateDirectory(from);
    mkdirSync(to, { mode: 0o700 });
    for (const [name, limit] of [[queueFile, 64 * 1024 * 1024], ['.payload-key', 32]] as const) {
        const data = privateRead(join(from, name), limit);
        try { writeFileSync(join(to, name), data, { mode: 0o600, flag: 'wx' }); }
        finally { data.fill(0); }
    }
}

async function idleSamples(directory: string, count: number) {
    const denied = async (): Promise<never> => { throw Error('QUEUE_BENCHMARK_EXTERNAL_CALL'); };
    const transport: Transport = { localSessions: () => [], machines: denied, sessions: denied, messages: denied, rpc: denied, send: denied };
    const registration: WorkerRegistration = {
        id: randomUUID(), userID: 'benchmark-owner', name: 'Benchmark', machineID, publicKey: 'fixture', projects: [], methods: [], protocol: 1,
    };
    const worker = new ScopedWorker(registration, transport, join(directory, 'worker'), denied, Date.now, undefined, denied, directory);
    const signal = new AbortController().signal, errors: unknown[] = [];
    const tick = () => worker.tick({ signal, onError: error => errors.push(error) });
    for (let index = 0; index < 3; index++) await tick();
    const probe = measureQueue(worker.queue), samples: Operation[] = [];
    try {
        for (let index = 0; index < count; index++) {
            const started = now();
            await tick();
            samples.push(probe.take(0, started));
        }
        await worker.drain();
        if (errors.length) throw Error('QUEUE_BENCHMARK_BACKGROUND_ERRORS');
        return samples;
    } finally { probe.restore(); }
}

async function enqueueChild(directory: string, processIndex: number, count: number) {
    if (!process.send || !process.connected) throw Error('QUEUE_BENCHMARK_REQUIRES_FORK');
    const queue = new TaskQueue(directory), namespace = randomUUID();
    const start = new Promise<void>(resolveStart => process.once('message', () => resolveStart()));
    process.send({ ready: true });
    await start;
    const probe = measureQueue(queue), samples: Operation[] = [];
    try {
        for (let index = 0; index < count; index++) {
            const input = { requestID: namespace + '-' + index, workerID: 'benchmark-worker', grantID: namespace,
                sessionID: namespace, authorization: '', text: 'Isolated benchmark input', resources: [] };
            const started = now();
            queue.enqueue(input);
            samples.push(probe.take(processIndex, started));
        }
        process.send({ samples }, () => process.disconnect!());
    } finally { probe.restore(); }
}

async function enqueueSamples(directory: string, processes: number, count: number) {
    const children: ChildProcess[] = [];
    try {
        return await new Promise<Operation[]>((done, fail) => {
            const samples: Operation[] = [];
            let ready = 0, finished = 0;
            for (let index = 0; index < processes; index++) {
                const child = fork(fileURLToPath(import.meta.url), ['--enqueue-child', directory, String(index), String(count / processes)], { timeout: 60_000, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
                children.push(child);
                child.on('message', (message: { ready?: boolean; samples?: Operation[] }) => {
                    if (message.ready && ++ready === processes) for (const peer of children) peer.send('start');
                    if (message.samples) samples.push(...message.samples);
                });
                child.on('error', fail);
                child.on('exit', code => {
                    if (code !== 0) fail(Error('QUEUE_BENCHMARK_CHILD_FAILED'));
                    else if (++finished === processes) done(samples);
                });
            }
        });
    } finally {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    }
}

function summarize(samples: Operation[], expected: number, processCount: number) {
    if (samples.length !== expected || samples.some(sample => !sample.transactions.length)) throw Error('QUEUE_BENCHMARK_INCOMPLETE');
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const rounded = (value: number) => Math.round(value * 100) / 100;
    const p95 = (values: number[]) => rounded(values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!);
    const transactions = samples.flatMap(sample => sample.transactions);
    const durations = samples.map(sample => sample.ended - sample.started), total = sum(durations);
    const overlaps = samples.filter(sample => sample.transactions.some(tx => samples.some(other =>
        other.processIndex !== sample.processIndex && other.transactions.some(previous =>
            previous.lockAcquired < tx.lockAcquired && previous.ended > tx.started)))).length;
    return {
        samples: samples.length, processCount, transactions: transactions.length, durableWrites: sum(transactions.map(tx => tx.writes)), lockOverlapSamples: overlaps,
        elapsedMs: rounded(Math.max(...samples.map(sample => sample.ended)) - Math.min(...samples.map(sample => sample.started))),
        totalOperationMs: rounded(total), operationP95Ms: p95(durations),
        queueSharePct: rounded(100 * sum(transactions.map(tx => tx.ended - tx.started)) / total),
        phases: Object.fromEntries(phaseNames.map(phase => {
            const times = samples.map(sample => sum(sample.transactions.map(tx => tx.timings[phase])));
            return [phase, { p95Ms: p95(times), sharePct: rounded(100 * sum(times) / total) }];
        })),
    };
}

async function main() {
    if (process.argv[2] === '--enqueue-child') {
        await enqueueChild(process.argv[3]!, Number(process.argv[4]), Number(process.argv[5]));
        return;
    }
    const source = process.argv[2] && resolve(process.argv[2]);
    const withinTmp = source && relative(tmpdir(), source);
    if (!source || !withinTmp || withinTmp === '..' || withinTmp.startsWith('..' + sep))
        throw Error('QUEUE_BENCHMARK_REQUIRES_PRIVATE_TEMP_SNAPSHOT');
    const root = mkdtempSync(join(tmpdir(), 'happy-worker-queue-benchmark-'));
    try {
        const seed = join(root, 'seed');
        copySnapshot(source, seed);
        const sealedBytes = statSync(join(seed, queueFile)).size, queue = new TaskQueue(seed);
        const counts = queue.transaction(state => ({ tasks: state.tasks.length, workspaces: state.workspaces.length,
            cancellations: state.cancellations.length, active: state.tasks.filter(task => !terminalTask(task)).length }), true);
        if (counts.active) queue.transaction(state => {
            for (const task of state.tasks) if (!terminalTask(task)) task.state = 'cancelled';
        });
        const idle = join(root, 'idle'), serial = join(root, 'serial'), concurrent = join(root, 'concurrent');
        for (const target of [idle, serial, concurrent]) copySnapshot(seed, target);
        const idleCount = 48, enqueueCount = 80, processes = 4;
        const report = { sealedBytes, ...counts, idle: summarize(await idleSamples(idle, idleCount), idleCount, 1),
            serial: summarize(await enqueueSamples(serial, 1, enqueueCount), enqueueCount, 1),
            concurrent: summarize(await enqueueSamples(concurrent, processes, enqueueCount), enqueueCount, processes) };
        for (const directory of [serial, concurrent]) {
            const end = new TaskQueue(directory).transaction(state => ({ tasks: state.tasks.length,
                pending: state.tasks.filter(task => !terminalTask(task)).length }), true);
            if (end.tasks !== counts.tasks + enqueueCount || end.pending !== enqueueCount) throw Error('QUEUE_BENCHMARK_ENTRIES_MISSING');
        }
        process.stdout.write(JSON.stringify(report) + '\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
}

await main().catch(error => {
    const code = error instanceof ApiError ? error.code : error instanceof Error && /^QUEUE_BENCHMARK_[A-Z_]+$/.test(error.message) ? error.message : 'QUEUE_BENCHMARK_FAILED';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect!();
});
