import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OptionsDenied, policyForCodeBuddyApproval, resolveTaskOptions, taskOptionsSchema, type Connection, type LaunchOptionsPolicy, type OptionCatalogEntry, type ResolvedTaskOptions } from 'happy-agent/automation';
import { CODEX_AUTOMATION_DEFAULTS } from './automationOptions';
import type { AutomationCreateBinding, AutomationCreateCode, AutomationCreateLaunch } from './automationCreate';

type CreateAttempt = { id: string; digest: string; previous: string | null; titleDigest?: string };
function createAttempt(value: unknown): CreateAttempt {
    const attempt = object(value);
    if (typeof attempt.digest !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.digest)) throw new Error('INVALID_REQUEST');
    const id = identifier(attempt.id), previous = attempt.previous === null ? null : identifier(attempt.previous);
    if (id === previous) throw new Error('INVALID_REQUEST');
    if (attempt.titleDigest !== undefined && (typeof attempt.titleDigest !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.titleDigest))) throw new Error('INVALID_REQUEST');
    return {id, digest: attempt.digest, previous, ...(typeof attempt.titleDigest === 'string' ? {titleDigest:attempt.titleDigest} : {})};
}

type Receipt = {
    createAttempt?: CreateAttempt;
    version: 1;
    requestID: string;
    fingerprint: string;
    operation: 'create' | 'cancel';
    state: 'withdrawn' | 'pending' | 'confirmed' | 'cancel_requested' | 'failed' | 'unknown';
    sessionID?: string;
    errorCode?: string;
    launchID?: string;
    launchPid?: number;
    /** Fully-resolved launch selection; IDs only, never prompts or keys. */
    options?: ResolvedTaskOptions;
};

type Dependencies = {
    directory: string;
    spawn: (directory: string, options: ResolvedTaskOptions, environment: Record<string, string> | undefined,
        automationCreate: AutomationCreateLaunch) => Promise<{ type: string; sessionId?: string }>;
    stop: (sessionID: string) => boolean;
    // A false value is not evidence of exit. Only the owner may attest stopped.
    observe: (sessionID: string) => 'running' | 'stopping' | 'stopped' | 'unknown';
    /**
     * Live launch catalog plus the owner's allowlist (worker registration).
     * Absent = fixed defaults; any requested override is rejected.
     */
    options?: () => { defaultAgent: string; catalog: OptionCatalogEntry[]; policy?: LaunchOptionsPolicy };
};

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
    const awaitingRegistration = new Set<string>();
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
    const view = ({ launchID, launchPid, ...receipt }: Receipt) => {
        const interrupted = receipt.state === 'pending' && !inFlight.has(receipt.requestID);
        const trackingLost = receipt.errorCode === 'SPAWN_REGISTRATION_PENDING' && !awaitingRegistration.has(receipt.requestID);
        return { ...receipt,
            // A restart during dispatch leaves uncertainty, never a licence to retry.
            state: interrupted ? 'unknown' : receipt.state,
            ...(receipt.operation === 'create' && (interrupted || trackingLost) ? { errorCode: 'SPAWN_EVIDENCE_UNAVAILABLE' } : {}),
            ...(receipt.sessionID ? { process: deps.observe(receipt.sessionID) } : {}),
        };
    };
    const currentCreate = ({ requestID, launchID }: AutomationCreateBinding) => {
        const receipt = read(requestID);
        return receipt?.operation === 'create' && receipt.requestID === requestID && receipt.launchID === launchID ? receipt : undefined;
    };
    const updateCreate = (binding: AutomationCreateBinding, update: (receipt: Receipt) => boolean) => {
        const receipt = currentCreate(binding);
        if (receipt && (receipt.state === 'pending' || receipt.state === 'unknown') && update(receipt)) persist(receipt, false);
        return receipt;
    };
    const reportCreate = (binding: AutomationCreateBinding, code: AutomationCreateCode) => {
        if (code === 'SPAWN_REGISTRATION_PENDING') awaitingRegistration.add(binding.requestID);
        else awaitingRegistration.delete(binding.requestID);
        return updateCreate(binding, receipt => {
            if (receipt.errorCode === code) return false;
            receipt.state = code === 'SPAWN_NOT_STARTED' || code === 'SPAWN_EXITED_BEFORE_SESSION_REQUEST' ? 'failed' : 'unknown';
            receipt.errorCode = code;
            return true;
        });
    };
    const confirmCreate = (binding: AutomationCreateBinding, sessionID: string) => {
        sessionID = identifier(sessionID);
        awaitingRegistration.delete(binding.requestID);
        return updateCreate(binding, receipt => {
            receipt.state = 'confirmed';
            receipt.sessionID = sessionID;
            delete receipt.errorCode;
            return true;
        });
    };

    const handle = async (input: unknown, grant?: Pick<Connection, 'options' | 'codebuddyLaunch'>): Promise<unknown> => {
        try {
            const req = object(input);
            if (req.version !== 1) return { version: 1, errorCode: 'UNSUPPORTED_VERSION' };
            if (req.operation === 'capabilities') return { version: 1, operations: ['create', 'withdraw-create', 'request', 'status', 'cancel', 'restricted-task-v1', ...(deps.options ? ['options'] : [])] };
            if (req.operation === 'options') {
                if (!deps.options) return { version: 1, errorCode: 'UNSUPPORTED_VERSION' };
                const { defaultAgent, catalog } = deps.options();
                // Older workers validate the keys-only shape strictly.
                const agents = req.includeCodeBuddyDetails === true ? catalog : catalog.map(({ codebuddy, ...entry }) => entry);
                return { version: 1, defaultAgent, agents };
            }
            if (req.operation === 'status') return { version: 1, sessionID: identifier(req.sessionID), process: deps.observe(identifier(req.sessionID)) };
            const requestID = identifier(req.requestID);
            if (req.operation === 'request') {
                const receipt = read(requestID);
                return receipt ? view(receipt) : { version: 1, errorCode: 'NOT_FOUND' };
            }
            const attempt = req.createAttempt === undefined ? undefined : createAttempt(req.createAttempt);
            const withdrawing = req.operation === 'withdraw-create';
            const operation = withdrawing ? 'create' : req.operation;
            if (operation !== 'create' && operation !== 'cancel') throw new Error('INVALID_REQUEST');
            const directory = operation === 'create' && typeof req.directory === 'string' && req.directory.startsWith('/') && req.directory.length <= 4096
                ? req.directory : undefined;
            const sessionID = operation === 'cancel' ? identifier(req.sessionID) : undefined;
            if (operation === 'create' && !directory) throw new Error('INVALID_REQUEST');
            // Final enforcement point: the daemon re-resolves overrides against
            // the owner's allowlist and the live agent catalog. A worker-side
            // check alone is never trusted with permission elevation.
            let launch: ResolvedTaskOptions = CODEX_AUTOMATION_DEFAULTS;
            const parsed = taskOptionsSchema.safeParse(req.options ?? {});
            if (!parsed.success) throw new Error('INVALID_REQUEST');
            if (deps.options) {
                const { defaultAgent, catalog, policy } = deps.options();
                try { launch = resolveTaskOptions(parsed.data, policyForCodeBuddyApproval(policy, grant?.codebuddyLaunch), grant?.options, defaultAgent, catalog); }
                catch (error) { if (error instanceof OptionsDenied) return { version: 1, errorCode: 'OPTION_DENIED' }; throw error; }
            } else if (Object.values(parsed.data).some(v => v !== undefined)) return { version: 1, errorCode: 'OPTION_DENIED' };
            // Fixed key order: idempotency is stable regardless of caller JSON order.
            const requested = { agent: parsed.data.agent, model: parsed.data.model, permissionMode: parsed.data.permissionMode, effort: parsed.data.effort };
            const environment = req.taskEnvironment as Record<string, unknown> | undefined;
            if (environment && (typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([k,v]) => !['TMPDIR','TMP','TEMP','HAPPY_TASK_ID','HAPPY_TASK_PORT','HAPPY_TASK_ROOT','HAPPY_TASK_TITLE','HAPPY_TASK_RESTRICTION'].includes(k) || typeof v !== 'string' || v.length > 4096))) throw new Error('INVALID_REQUEST');
            const taskTitle = environment?.HAPPY_TASK_TITLE as string | undefined, taskRoot = environment?.HAPPY_TASK_ROOT as string | undefined;
            if ((taskTitle !== undefined || taskRoot !== undefined)
                && (!taskTitle || taskTitle.trim() !== taskTitle || taskTitle.length > 200 || !taskRoot?.startsWith('/') || !environment?.HAPPY_TASK_ID)) throw new Error('INVALID_REQUEST');
            const restriction = environment?.HAPPY_TASK_RESTRICTION;
            if (restriction !== undefined && ((restriction !== 'text' && restriction !== 'inspect')
                || operation !== 'create' || launch.agent !== 'codex' || launch.permissionMode !== 'read-only'))
                throw new Error('INVALID_REQUEST');
            const fingerprint = digest(JSON.stringify({ operation, directory, sessionID, options: requested,
                ...(taskTitle ? { task: { title: taskTitle, root: taskRoot } } : {}), restriction }));
            const previous = read(requestID);
            // Bind a fence to the real process launch arguments as well as the logical gateway command.
            const titleDigest = withdrawing ? attempt?.titleDigest : taskTitle && digest(taskTitle);
            const root = withdrawing ? req.withdrawRoot : taskRoot;
            if (attempt && (titleDigest !== attempt.titleDigest || (!!titleDigest !== !!root)
                || root !== undefined && (typeof root !== 'string' || !root.startsWith('/')))) return {version:1,errorCode:'REQUEST_ID_CONFLICT'};
            const launchBinding = 'withdrawn:'+digest(JSON.stringify([directory, requested, titleDigest, root,
                environment?.HAPPY_TASK_ID, environment?.HAPPY_TASK_PORT, environment?.TMPDIR, environment?.TMP, environment?.TEMP, ...(restriction === undefined ? [] : [restriction])]));
            if (withdrawing) {
                if (!attempt) throw new Error('INVALID_REQUEST');
                // No await separates reading and fsyncing the fence or the competing create's pending receipt.
                if (previous && previous.state !== 'withdrawn') return view(previous);
                if (previous && (previous.createAttempt?.digest !== attempt.digest || previous.fingerprint !== launchBinding))
                    return {version:1,errorCode:'REQUEST_ID_CONFLICT'};
                if (previous?.createAttempt?.id === attempt.id) return view(previous);
                if ((previous?.createAttempt?.id ?? null) !== attempt.previous) return {version:1,errorCode:'REQUEST_ID_CONFLICT'};
                const closed: Receipt = {version:1,requestID,operation:'create',fingerprint:launchBinding,state:'withdrawn',createAttempt:attempt};
                persist(closed, !previous); return view(closed);
            }
            if (previous?.state === 'withdrawn') {
                if (operation !== 'create' || !attempt || previous.fingerprint !== launchBinding || previous.createAttempt?.id !== attempt.previous
                    || previous.createAttempt.digest !== attempt.digest) return {version: 1, errorCode: 'REQUEST_ID_CONFLICT'};
            } else if (previous) {
                return previous.fingerprint === fingerprint && (!attempt || !previous.createAttempt || attempt.digest === previous.createAttempt.digest)
                    ? view(previous) : { version: 1, errorCode: 'REQUEST_ID_CONFLICT' };
            } else if (attempt?.previous) return {version: 1, errorCode: 'REQUEST_ID_CONFLICT'};
            const receipt: Receipt = { version: 1, requestID, fingerprint, operation, state: 'pending', sessionID, createAttempt: attempt,
                ...(operation === 'create' ? { options: launch, launchID: randomUUID() } : {}) };
            // Only an exactly matched withdrawal may be replaced by a fresh pending receipt.
            persist(receipt, !previous);
            inFlight.add(requestID);
            if (receipt.launchID) {
                const binding = { requestID, launchID: receipt.launchID };
                try {
                    const result = await deps.spawn(directory!, launch, environment as Record<string, string> | undefined,
                        { binding, bindPid: pid => updateCreate(binding, current => {
                            if (current.launchPid === pid) return false;
                            if (current.launchPid !== undefined) throw new Error('CREATE_PID_CONFLICT');
                            current.launchPid = pid;
                            return true;
                        }), report: code => reportCreate(binding, code) }).catch(() => undefined);
                    let settled: Receipt | undefined;
                    if (result?.type === 'success' && result.sessionId) settled = confirmCreate(binding, result.sessionId);
                    else if (result?.type === 'requestToApproveDirectoryCreation') settled = reportCreate(binding, 'SPAWN_NOT_STARTED');
                    else {
                        settled = updateCreate(binding, current => {
                            if (current.state !== 'pending') return false;
                            current.state = 'unknown';
                            current.errorCode = 'SPAWN_EVIDENCE_UNAVAILABLE';
                            return true;
                        });
                    }
                    if (!settled) throw new Error('CREATE_RECEIPT_UNAVAILABLE');
                    return view(settled);
                } finally {
                    inFlight.delete(requestID);
                }
            }
            try {
                receipt.state = deps.stop(sessionID!) ? 'cancel_requested' : 'unknown';
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
    return Object.assign(handle, { confirmCreate, matchesCreate: (binding: AutomationCreateBinding, pid: number, sessionID: string) => {
        const receipt = currentCreate(binding);
        return /^[a-zA-Z0-9_-]{1,128}$/.test(sessionID) && !!receipt && receipt.launchPid === pid && receipt.state !== 'failed'
            && (!receipt.sessionID || receipt.sessionID === sessionID);
    } });
}
