import { io, type Socket } from 'socket.io-client';
import { MMKV } from 'react-native-mmkv';
import { AppState } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { z } from 'zod';
import { getServerSocketEndpoint } from '@slopus/happy-wire/serverUrl';
import type { RelaySwitchRequest, RelaySwitchResult } from '@slopus/happy-wire';
import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import type { Encryption } from './encryption/encryption';

const endpointSchema = z.object({ serverUrl: z.string(), token: z.string() });
const participantSchema = z.object({
    kind: z.enum(['machine', 'session']), entityId: z.string(), name: z.string(),
    dataKey: z.string().nullable(),
});
const jobSchema = participantSchema.extend({
    id: z.string(), sources: z.array(endpointSchema), target: endpointSchema,
    phase: z.enum(['prepare', 'commit', 'finish']),
    attempts: z.number(), lastError: z.string().nullable(),
});
const queueSchema = z.object({ serverUrl: z.string(), jobs: z.array(jobSchema) });
type Endpoint = z.infer<typeof endpointSchema>;
type Job = z.infer<typeof jobSchema>;
export type RelayMigrationParticipant = z.infer<typeof participantSchema>;
export type RelayMigrationTask = Pick<Job, 'id' | 'kind' | 'entityId' | 'name' | 'lastError'>;

// URL/token pairs and per-device keys are encrypted with the account key.
// This store survives relay cache cleanup and the reload after switching.
const store = new MMKV({ id: 'relay-migrations' });
const listeners = new Set<() => void>();
let status = { pending: 0, lastError: null as string | null, tasks: [] as RelayMigrationTask[] };
export const getRelayMigrationStatus = () => status;
export const subscribeRelayMigrations = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};
function publish(jobs: Job[], error: string | null = null) {
    status = {
        pending: jobs.length,
        lastError: error ?? jobs.find(job => job.lastError)?.lastError ?? null,
        tasks: jobs.map(({ id, kind, entityId, name, lastError }) => ({ id, kind, entityId, name, lastError })),
    };
    for (const listener of listeners) listener();
}

interface Worker {
    encryption: Encryption;
    serverUrl: string;
    jobs: Job[];
    stopped: boolean;
    sockets: Map<string, Socket>;
    timer?: ReturnType<typeof setTimeout>;
    saving: Promise<void>;
    ready: Promise<void>;
    loadingError?: string;
    removeAppStateListener?: () => void;
}
let worker: Worker | null = null;
let workerRevision = 0;

/** Keep new prompts in the existing outbox until the live CLI has moved. */
export async function waitForRelaySessionMigration(sessionId: string, signal?: AbortSignal): Promise<void> {
    const state = worker;
    if (!state) return;
    await state.ready;
    if (state.loadingError) throw new Error(state.loadingError);
    await new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const finish = (error?: Error) => {
            unsubscribe();
            signal?.removeEventListener('abort', check);
            if (error) reject(error); else resolve();
        };
        const check = () => {
            if (signal?.aborted || state.stopped) finish(new Error('Relay changed while waiting to send the message'));
            else if (!state.jobs.some(job => job.kind === 'session' && job.entityId === sessionId)) finish();
        };
        unsubscribe = subscribeRelayMigrations(check);
        signal?.addEventListener('abort', check);
        check();
    });
}

export function stopRelayMigrations(clear = false) {
    workerRevision++;
    if (worker) {
        worker.stopped = true;
        clearTimeout(worker.timer);
        worker.removeAppStateListener?.();
        for (const socket of worker.sockets.values()) socket.disconnect();
        worker = null;
    }
    if (clear) store.clearAll();
    publish([]);
}

/** Abandon one task explicitly; an unavailable RPC alone cannot prove a device has exited. */
export async function cancelRelayMigration(task: RelayMigrationTask): Promise<void> {
    const state = worker;
    if (!state) return;
    await state.ready;
    if (state.stopped || worker !== state) throw new Error('Relay changed while stopping automatic reconnection');
    const remaining = state.jobs.filter(job =>
        job.id !== task.id || job.kind !== task.kind || job.entityId !== task.entityId);
    if (remaining.length === state.jobs.length) return;

    // Stop in-flight RPCs and journal writes before replacing the queue. Waiting
    // outbox sends must reject, rather than treating cancellation as a successful move.
    stopRelayMigrations();
    const revision = workerRevision;
    try {
        const encrypted = await state.encryption.encryptRaw({ serverUrl: state.serverUrl, jobs: remaining });
        if (workerRevision !== revision) throw new Error('Relay changed while stopping automatic reconnection');
        store.set(state.encryption.anonID, encrypted);
    } catch (error) {
        // A failed save retains the previous durable queue. Do not revive it
        // after logout or a concurrent server switch.
        if (workerRevision === revision) startRelayMigrations(state.encryption, state.serverUrl);
        throw error;
    }
    startRelayMigrations(state.encryption, state.serverUrl);
}

async function load(encryption: Encryption): Promise<z.infer<typeof queueSchema> | null> {
    const encrypted = store.getString(encryption.anonID);
    if (!encrypted) return null;
    return queueSchema.parse(await encryption.decryptRaw(encrypted));
}

/** Persist the work BEFORE changing the App login; no device RPC blocks Save. */
export async function queueRelayMigrations(options: {
    id: string;
    source: Endpoint;
    target: Endpoint;
    participants: RelayMigrationParticipant[];
    encryption: Encryption;
}): Promise<() => void> {
    stopRelayMigrations();
    const { encryption, source, target } = options;
    const previous = store.getString(encryption.anonID);
    const existing = (await load(encryption))?.jobs ?? [];
    const jobs = new Map<string, Job>();
    // A second switch retargets unfinished work, including computers which
    // never reached the intermediate relay and are absent from its device list.
    for (const job of existing) {
        const sources = [job.target, ...job.sources];
        jobs.set(`${job.kind}:${job.entityId}`, {
            ...job, id: options.id, target, sources, phase: 'prepare', attempts: 0, lastError: null,
        });
    }
    for (const participant of options.participants) {
        const key = `${participant.kind}:${participant.entityId}`;
        const prior = jobs.get(key);
        jobs.set(key, {
            ...participant, id: options.id, target,
            sources: [source, ...(prior?.sources ?? [])],
            phase: 'prepare', attempts: 0, lastError: null,
        });
    }
    for (const job of jobs.values()) {
        job.sources = job.sources.filter((endpoint, index, all) =>
            all.findIndex(other => other.serverUrl === endpoint.serverUrl) === index);
    }
    const next = [...jobs.values()];
    store.set(encryption.anonID, await encryption.encryptRaw({ serverUrl: target.serverUrl, jobs: next }));
    return () => {
        stopRelayMigrations();
        if (previous) store.set(encryption.anonID, previous);
        else store.delete(encryption.anonID);
    };
}

function persist(state: Worker): Promise<void> {
    const saving = state.saving.catch(() => {}).then(async () => {
        if (state.stopped) return;
        const encrypted = await state.encryption.encryptRaw({ serverUrl: state.serverUrl, jobs: state.jobs });
        if (state.stopped) return;
        store.set(state.encryption.anonID, encrypted);
        publish(state.jobs);
    });
    state.saving = saving;
    return saving;
}

async function connect(state: Worker, endpoint: Endpoint): Promise<Socket> {
    if (state.stopped) throw new Error('Relay migration stopped');
    const key = `${endpoint.serverUrl}:${endpoint.token}`;
    let socket = state.sockets.get(key);
    if (!socket) {
        const transport = getServerSocketEndpoint(endpoint.serverUrl);
        socket = io(transport.origin, {
            path: transport.path,
            auth: { token: endpoint.token, clientType: 'user-scoped', appState: 'background' },
            transports: ['websocket'], forceNew: true, autoConnect: false, reconnection: false,
        });
        state.sockets.set(key, socket);
    }
    if (!socket.connected) {
        const current = socket;
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timer);
                current.off('connect', connected);
                current.off('connect_error', failed);
                current.off('disconnect', failed);
                if (error) reject(error); else resolve();
            };
            const connected = () => finish();
            const failed = () => finish(new Error('Computer connection unavailable; retrying automatically'));
            const timer = setTimeout(failed, 7_000);
            current.once('connect', connected);
            current.once('connect_error', failed);
            current.once('disconnect', failed);
            current.connect();
        });
    }
    if (state.stopped) throw new Error('Relay migration stopped');
    return socket;
}

async function call(state: Worker, job: Job, endpoint: Endpoint): Promise<void> {
    const cipher = await state.encryption.openEncryption(job.dataKey ? decodeBase64(job.dataKey) : null);
    const request: RelaySwitchRequest = { id: job.id, phase: job.phase, ...job.target };
    const params = encodeBase64((await cipher.encrypt([request]))[0]);
    const socket = await connect(state, endpoint);
    // Check immediately before emit, without an intervening await. A volatile
    // emit would also drop healthy concurrent machine/session RPCs whenever
    // the WebSocket transport is temporarily not writable.
    if (state.stopped || !socket.connected) throw new Error('Computer connection unavailable; retrying automatically');
    const response = await socket.timeout(50_000).emitWithAck('rpc-call', {
        method: `${job.entityId}:relay-switch`, params,
    });
    if (state.stopped) throw new Error('Relay migration stopped');
    if (!response?.ok) throw new Error(response?.error || 'Computer did not respond; retrying automatically');
    const [answer] = await cipher.decrypt([decodeBase64(response.result)]);
    const result = answer as RelaySwitchResult | null;
    if (!result?.success) throw new Error(result?.error || 'Relay switch acknowledgement is invalid');
}

async function advance(state: Worker, job: Job) {
    try {
        while (!state.stopped) {
            // A lost commit/finish reply can leave a device on the target.
            // Its original RPC socket is retained only briefly by the CLI.
            const endpoints = job.phase === 'finish' ? [job.target, ...job.sources] : [...job.sources, job.target];
            let failure: unknown;
            let acknowledged = false;
            let expired = false;
            for (const endpoint of endpoints) {
                try {
                    await call(state, job, endpoint);
                    acknowledged = true;
                    break;
                } catch (error) {
                    if (state.stopped) return;
                    // An abandoned CLI transaction expires after two minutes.
                    // Re-prepare on the next attempt rather than waiting forever
                    // for a commit which can no longer match.
                    if (error instanceof Error && /transaction does not match|window expired/.test(error.message)) {
                        expired = true;
                    }
                    // A missing fallback RPC must not hide an explicit error
                    // returned by the computer on its original connection.
                    if (!failure || (failure instanceof Error && /RPC method not available|Method not found/.test(failure.message))) {
                        failure = error;
                    }
                }
            }
            if (!acknowledged) {
                if (expired) {
                    job.phase = 'prepare';
                    job.id = randomUUID();
                    job.sources = [job.target, ...job.sources.filter(source => source.serverUrl !== job.target.serverUrl)];
                }
                throw failure;
            }
            job.lastError = null;
            if (job.phase === 'finish') {
                state.jobs = state.jobs.filter(other => other !== job);
                try { await persist(state); }
                catch (error) { state.jobs.push(job); throw error; }
                return;
            }
            job.phase = job.phase === 'prepare' ? 'commit' : 'finish';
            await persist(state);
        }
    } catch (error) {
        if (state.stopped) return;
        job.attempts++;
        job.lastError = `${job.name}: ${error instanceof Error ? error.message : 'Automatic reconnection failed'}`;
        try { await persist(state); }
        catch { publish(state.jobs, 'Could not save automatic reconnection progress'); }
    }
}

/** Resume after an App reload/restart, independently of the current relay socket. */
export function startRelayMigrations(encryption: Encryption, serverUrl: string) {
    stopRelayMigrations();
    const state: Worker = { encryption, serverUrl, jobs: [], stopped: false, sockets: new Map(), saving: Promise.resolve(), ready: Promise.resolve() };
    worker = state;
    let running = false;
    const run = async () => {
        if (state.stopped || running) return;
        running = true;
        try {
            await Promise.all(state.jobs.map(job => advance(state, job)));
        } finally {
            running = false;
            if (!state.stopped && state.jobs.length > 0) {
                const attempts = Math.min(...state.jobs.map(job => job.attempts));
                const delay = Math.min(60_000, 10_000 * 2 ** Math.min(attempts, 3));
                state.timer = setTimeout(() => { void run(); }, delay);
            } else {
                for (const socket of state.sockets.values()) socket.disconnect();
                state.sockets.clear();
            }
        }
    };
    const subscription = AppState.addEventListener('change', next => {
        if (next === 'active') { clearTimeout(state.timer); void run(); }
    });
    state.removeAppStateListener = () => subscription.remove();
    state.ready = load(encryption).then(queue => {
        if (state.stopped) return;
        // Saving the work and saving the login are separate storage writes.
        // A process killed between them must not migrate devices away from
        // the server which the App still uses.
        if (queue && queue.serverUrl !== serverUrl) {
            publish([], 'Saved automatic reconnection work belongs to another server');
            return;
        }
        state.jobs = queue?.jobs ?? [];
        publish(state.jobs);
        void run();
    }).catch(() => {
        state.loadingError = 'Could not read automatic reconnection work';
        if (!state.stopped) publish([], state.loadingError);
    });
}
