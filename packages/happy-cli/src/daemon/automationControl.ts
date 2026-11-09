import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OptionsDenied, resolveTaskOptions, taskOptionsSchema, type LaunchOptionsPolicy, type OptionCatalogEntry, type ResolvedTaskOptions } from 'happy-agent/automation';

type Receipt = {
    version: 1;
    requestID: string;
    fingerprint: string;
    operation: 'create' | 'cancel';
    state: 'pending' | 'confirmed' | 'cancel_requested' | 'failed' | 'unknown';
    sessionID?: string;
    errorCode?: string;
    /** Fully-resolved launch selection; IDs only, never prompts or keys. */
    options?: ResolvedTaskOptions;
};

type Dependencies = {
    directory: string;
    spawn: (directory: string, options: ResolvedTaskOptions, environment?: Record<string, string>) => Promise<{ type: string; sessionId?: string }>;
    stop: (sessionID: string) => boolean;
    // A false value is not evidence of exit. Only the owner may attest stopped.
    observe: (sessionID: string) => 'running' | 'stopping' | 'stopped' | 'unknown';
    /**
     * Live launch catalog plus the owner's allowlist (worker registration).
     * Absent = legacy fixed launch; any requested override is rejected.
     */
    options?: () => { defaultAgent: string; catalog: OptionCatalogEntry[]; policy?: LaunchOptionsPolicy };
};

/** Launch used by automation before options existed; identical session for legacy callers. */
const LEGACY_LAUNCH: ResolvedTaskOptions = { agent: 'codex', model: 'gpt-6.1-sol', permissionMode: 'default', effort: 'high' };

/** Only a daemon-owned child and ESRCH for both parent/group can prove stopped. */
export function observeOwnedProcess(
    processInfo: { pid: number; owned: boolean; stopping: boolean } | undefined,
    probe: (pid: number, signal: 0) => unknown = process.kill,
    platform: string = process.platform,
): 'running' | 'stopping' | 'stopped' | 'unknown' {
    if (!processInfo?.owned || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0) return 'unknown';
    try { probe(processInfo.pid, 0); return processInfo.stopping ? 'stopping' : 'running'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'unknown'; }
    if (platform === 'win32') return 'unknown';
    try { probe(-processInfo.pid, 0); return 'stopping'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown'; }
}

/** Read-only proof for a prior daemon's session. A saved PID never grants kill authority. */
export function observePersistedProcess(
    session: { savedAt: number; metadata?: { machineId?: string; hostPid?: number; startedBy?: string; startedFromDaemon?: boolean } } | undefined,
    machineID: string,
    bootTimeMs: number,
    probe: (pid: number, signal: 0) => unknown = process.kill,
    platform: string = process.platform,
): 'stopped' | 'unknown' {
    const metadata = session?.metadata, pid = metadata?.hostPid;
    if (!session || metadata?.machineId !== machineID || metadata.startedBy !== 'daemon' || metadata.startedFromDaemon !== true
        || !Number.isSafeInteger(pid) || pid! <= 0 || !Number.isFinite(session.savedAt) || session.savedAt <= 0
        || !Number.isFinite(bootTimeMs)) return 'unknown';
    if (session.savedAt < bootTimeMs) return 'stopped';
    if (platform === 'win32') return 'unknown';
    // Live/reused PIDs, remaining process groups and permission failures all stay unknown.
    try { probe(pid!, 0); return 'unknown'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return 'unknown'; }
    try { probe(-pid!, 0); return 'unknown'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown'; }
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
    return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('INVALID_REQUEST');
    return value;
}

/** Additive encrypted machine RPC. Receipts contain IDs/hashes, never prompts or keys. */
export function createAutomationControl(deps: Dependencies) {
    const inFlight = new Set<string>();
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    const path = (id: string) => join(deps.directory, `${digest(id)}.json`);
    const read = (id: string): Receipt | null => {
        try { return JSON.parse(readFileSync(path(id), 'utf8')) as Receipt; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error; // Corruption must never turn into a second dispatch.
        }
    };
    const persist = (receipt: Receipt, exclusive: boolean) => {
        mkdirSync(deps.directory, { recursive: true, mode: 0o700 });
        const target = exclusive ? path(receipt.requestID) : `${path(receipt.requestID)}.${randomUUID()}.tmp`;
        const fd = openSync(target, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); }
        finally { closeSync(fd); }
        if (!exclusive) renameSync(target, path(receipt.requestID));
        const dir = openSync(deps.directory, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
    };
    const view = (receipt: Receipt) => ({
        ...receipt,
        // A restart during dispatch leaves uncertainty, never a licence to retry.
        state: receipt.state === 'pending' && !inFlight.has(receipt.requestID) ? 'unknown' : receipt.state,
        ...(receipt.sessionID ? { process: deps.observe(receipt.sessionID) } : {}),
    });

    return async (input: unknown): Promise<unknown> => {
        try {
            const req = object(input);
            if (req.version !== 1) return { version: 1, errorCode: 'UNSUPPORTED_VERSION' };
            if (req.operation === 'capabilities') return { version: 1, operations: ['create', 'request', 'status', 'cancel', ...(deps.options ? ['options'] : [])] };
            if (req.operation === 'options') {
                // Keys-only catalog; the scoped worker narrows it per grant.
                if (!deps.options) return { version: 1, errorCode: 'UNSUPPORTED_VERSION' };
                const { defaultAgent, catalog } = deps.options();
                return { version: 1, defaultAgent, agents: catalog };
            }
            if (req.operation === 'status') return { version: 1, sessionID: identifier(req.sessionID), process: deps.observe(identifier(req.sessionID)) };
            const requestID = identifier(req.requestID);
            if (req.operation === 'request') {
                const receipt = read(requestID);
                return receipt ? view(receipt) : { version: 1, errorCode: 'NOT_FOUND' };
            }
            if (req.operation !== 'create' && req.operation !== 'cancel') throw new Error('INVALID_REQUEST');
            const operation = req.operation;
            const directory = operation === 'create' && typeof req.directory === 'string' && req.directory.startsWith('/') && req.directory.length <= 4096
                ? req.directory : undefined;
            const sessionID = operation === 'cancel' ? identifier(req.sessionID) : undefined;
            if (operation === 'create' && !directory) throw new Error('INVALID_REQUEST');
            // Final enforcement point: the daemon re-resolves overrides against
            // the owner's allowlist and the live agent catalog. A worker-side
            // check alone is never trusted with permission elevation.
            let launch = LEGACY_LAUNCH;
            const parsed = taskOptionsSchema.safeParse(req.options ?? {});
            if (!parsed.success) throw new Error('INVALID_REQUEST');
            if (deps.options) {
                const { defaultAgent, catalog, policy } = deps.options();
                try { launch = resolveTaskOptions(parsed.data, policy, undefined, defaultAgent, catalog); }
                catch (error) { if (error instanceof OptionsDenied) return { version: 1, errorCode: 'OPTION_DENIED' }; throw error; }
            } else if (Object.values(parsed.data).some(v => v !== undefined)) return { version: 1, errorCode: 'OPTION_DENIED' };
            // Fixed key order: idempotency is stable regardless of caller JSON order.
            const requested = { agent: parsed.data.agent, model: parsed.data.model, permissionMode: parsed.data.permissionMode, effort: parsed.data.effort };
            const fingerprint = digest(JSON.stringify({ operation, directory, sessionID, options: requested }));
            const environment = req.taskEnvironment as Record<string, unknown> | undefined;
            if (environment && (typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([k,v]) => !['TMPDIR','TMP','TEMP','HAPPY_TASK_ID','HAPPY_TASK_PORT'].includes(k) || typeof v !== 'string' || v.length > 4096))) throw new Error('INVALID_REQUEST');
            const previous = read(requestID);
            if (previous) return previous.fingerprint === fingerprint ? view(previous) : { version: 1, errorCode: 'REQUEST_ID_CONFLICT' };
            const receipt: Receipt = { version: 1, requestID, fingerprint, operation, state: 'pending', sessionID,
                ...(operation === 'create' ? { options: launch } : {}) };
            // Durable intent BEFORE any process mutation. An existing file is never overwritten here.
            persist(receipt, true);
            inFlight.add(requestID);
            try {
                if (operation === 'create') {
                    const result = environment ? await deps.spawn(directory!, launch, environment as Record<string, string>) : await deps.spawn(directory!, launch);
                    if (result.type === 'success' && result.sessionId) {
                        receipt.sessionID = result.sessionId;
                        receipt.state = 'confirmed';
                    } else {
                        // An error can follow a successful OS spawn. Do not assert no process exists.
                        receipt.state = 'unknown';
                        receipt.errorCode = 'SPAWN_NOT_CONFIRMED';
                    }
                } else {
                    receipt.state = deps.stop(sessionID!) ? 'cancel_requested' : 'unknown';
                }
            } catch {
                receipt.state = 'unknown';
                receipt.errorCode = 'DISPATCH_NOT_CONFIRMED';
            }
            try { persist(receipt, false); }
            finally { inFlight.delete(requestID); }
            return view(receipt);
        } catch {
            return { version: 1, errorCode: 'INVALID_REQUEST_OR_JOURNAL_UNAVAILABLE' };
        }
    };
}
