import { z } from 'zod';
import { MMKV } from 'react-native-mmkv';
import { AsyncLock } from '@/utils/lock';
import { apiSocket } from './apiSocket';
import type { Encryption } from './encryption/encryption';
import { TestloopDotsRequestSchema, TestloopDotsSnapshotSchema, type TestloopDotsRequest } from './testloopDots';

export type DotsWorkspaceCommand = Exclude<TestloopDotsRequest, { action: 'list' | 'inspect' }>;
const resultSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().uuid(), requestId: z.string().uuid(),
    status: z.enum(['queued', 'processing', 'applied', 'rejected']), error: z.string().max(1000).nullable(),
    snapshot: TestloopDotsSnapshotSchema.optional() });
export type DotsWorkspaceCommandResult = z.infer<typeof resultSchema>;

export type DotsWorkspaceCommandScope = { serverUrl: string; sessionId: string; workspaceId: string;
    encryption: Pick<Encryption, 'anonID' | 'encryptRaw' | 'decryptRaw'> };
const pending = new MMKV({ id: 'dots-workspace-commands' });
const locks = new Map<string, AsyncLock>();
const listeners = new Map<string, Set<() => void>>();
const scopeKey = (scope: DotsWorkspaceCommandScope) => JSON.stringify([
    scope.encryption.anonID, scope.serverUrl, scope.sessionId, scope.workspaceId,
]);
const storedSchema = z.object({ schemaVersion: z.literal(1), serverUrl: z.string(), sessionId: z.string(),
    workspaceId: z.string().uuid(), command: TestloopDotsRequestSchema, result: resultSchema.optional() });
export type DotsWorkspaceCommandState = { command: DotsWorkspaceCommand; result?: DotsWorkspaceCommandResult };
function locked<T>(scope: DotsWorkspaceCommandScope, action: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    let lock = locks.get(key);
    if (!lock) { lock = new AsyncLock(); locks.set(key, lock); }
    return lock.inLock(action);
}

function checkedCommand(command: TestloopDotsRequest): DotsWorkspaceCommand {
    const checked = TestloopDotsRequestSchema.safeParse(command);
    if (!checked.success || checked.data.action === 'list' || checked.data.action === 'inspect')
        throw new Error('dots_command_invalid_request');
    return checked.data;
}

export function subscribeDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope, listener: () => void): () => void {
    const key = scopeKey(scope);
    let group = listeners.get(key);
    if (!group) { group = new Set(); listeners.set(key, group); }
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) listeners.delete(key); };
}

async function saveState(scope: DotsWorkspaceCommandScope, state: DotsWorkspaceCommandState): Promise<void> {
    const encrypted = await scope.encryption.encryptRaw({ schemaVersion: 1, serverUrl: scope.serverUrl,
        sessionId: scope.sessionId, workspaceId: scope.workspaceId, ...state });
    pending.set(scopeKey(scope), encrypted);
    for (const listener of listeners.get(scopeKey(scope)) ?? []) listener();
}

/** Instructions are account-encrypted; credentials are never written into the recovery record. */
export async function loadDotsWorkspaceCommandState(scope: DotsWorkspaceCommandScope): Promise<DotsWorkspaceCommandState | null> {
    try {
        const raw = pending.getString(scopeKey(scope));
        if (!raw) return null;
        const stored = storedSchema.parse(await scope.encryption.decryptRaw(raw));
        if (stored.workspaceId !== scope.workspaceId || stored.sessionId !== scope.sessionId || stored.serverUrl !== scope.serverUrl)
            throw new Error('scope_changed');
        const command = checkedCommand(stored.command);
        if (stored.result) {
            checkedResult(stored.result, scope.workspaceId, command);
            if (!['applied', 'rejected'].includes(stored.result.status)) throw new Error('not_terminal');
        }
        return { command, ...(stored.result ? { result: stored.result } : {}) };
    } catch { throw new Error('dots_command_local_recovery_invalid'); }
}

export async function loadDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope): Promise<DotsWorkspaceCommand | null> {
    const state = await loadDotsWorkspaceCommandState(scope);
    return state && !state.result ? state.command : null;
}

export async function saveDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope, command: DotsWorkspaceCommand): Promise<void> {
    return locked(scope, async () => {
        const checked = checkedCommand(command), previous = await loadDotsWorkspaceCommand(scope);
        if (previous) {
            if (previous.requestId !== checked.requestId) throw new Error('dots_command_pending');
            if (JSON.stringify(previous) !== JSON.stringify(checked)) throw new Error('dots_command_request_conflict');
            return;
        }
        await saveState(scope, { command: checked });
    });
}

/** Keep the last terminal receipt for mounted observers and reload; the next intent replaces it. */
export async function settleDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope, command: DotsWorkspaceCommand, result: DotsWorkspaceCommandResult): Promise<void> {
    checkedResult(result, scope.workspaceId, command);
    if (!['applied', 'rejected'].includes(result.status)) throw new Error('dots_command_unconfirmed');
    return locked(scope, async () => {
        const previous = await loadDotsWorkspaceCommandState(scope);
        if (!previous || previous.command.requestId !== command.requestId) return;
        if (JSON.stringify(previous.command) !== JSON.stringify(checkedCommand(command))) throw new Error('dots_command_request_conflict');
        await saveState(scope, { command: previous.command, result });
    });
}

function checkedResult(result: DotsWorkspaceCommandResult, workspaceId: string, command: DotsWorkspaceCommand): DotsWorkspaceCommandResult {
    const snapshot = result.snapshot;
    if (result.workspaceId !== workspaceId || result.requestId !== command.requestId
        || snapshot && (snapshot.workspaceId !== workspaceId || snapshot.requestId !== command.requestId)
        || result.status === 'applied' && (!snapshot?.ok || result.error !== null)
        || result.status === 'applied' && command.action === 'delete' && snapshot?.deletedDot?.id !== command.dotId
        || result.status === 'rejected' && (!result.error || snapshot?.ok === true))
        throw new Error('dots_command_invalid_response');
    return result;
}

/** A queued command is durable, but only its terminal result confirms the operation. */
export async function requestDotsWorkspaceCommand(sessionId: string, workspaceId: string, command: DotsWorkspaceCommand): Promise<DotsWorkspaceCommandResult> {
    const checked = checkedCommand(command);
    let reply: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    try {
        reply = await Promise.race([apiSocket.sessionRPC(sessionId, 'testloop-dots-command', { schemaVersion: 1, workspaceId, command: checked }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); })]);
    } catch { throw new Error('dots_command_transport_unconfirmed'); }
    finally { clearTimeout(timer); }
    const envelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: resultSchema }),
        z.object({ ok: z.literal(false), error: z.string().min(1).max(1000) })]).safeParse(reply);
    if (!envelope.success) throw new Error('dots_command_invalid_response');
    if (!envelope.data.ok) throw new Error(envelope.data.error);
    return checkedResult(envelope.data.data, workspaceId, command);
}
