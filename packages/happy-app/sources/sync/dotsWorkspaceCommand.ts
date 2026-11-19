import { z } from 'zod';
import { MMKV } from 'react-native-mmkv';
import { AsyncLock } from '@/utils/lock';
import { apiSocket } from './apiSocket';
import type { Encryption } from './encryption/encryption';
import { dotsWorkspaceCommandTarget, isDotsWorkspaceCommand, TestloopDotsRequestSchema, TestloopDotsSnapshotSchema,
    type DotsWorkspaceCommand, type TestloopDotsRequest } from './testloopDots';

const resultSchema = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().uuid(), requestId: z.string().uuid(),
    status: z.enum(['unknown', 'queued', 'processing', 'applied', 'rejected']), error: z.string().max(1000).nullable(),
    snapshot: TestloopDotsSnapshotSchema.optional() });
export type DotsWorkspaceCommandResult = z.infer<typeof resultSchema>;
export function isTerminalDotsWorkspaceResult(result: DotsWorkspaceCommandResult) {
    return result.status === 'applied' || result.status === 'rejected';
}

export type DotsWorkspaceCommandScope = { serverUrl: string; sessionId: string; workspaceId: string;
    encryption: Pick<Encryption, 'anonID' | 'encryptRaw' | 'decryptRaw'> };
const pending = new MMKV({ id: 'dots-workspace-commands' });
const locks = new Map<string, AsyncLock>();
const listeners = new Map<string, Set<() => void>>();
const scopeKey = (scope: DotsWorkspaceCommandScope) => JSON.stringify([
    scope.encryption.anonID, scope.serverUrl, scope.sessionId, scope.workspaceId,
]);
const targetKey = (scope: DotsWorkspaceCommandScope, command: DotsWorkspaceCommand) =>
    `${scopeKey(scope)}:${dotsWorkspaceCommandTarget(command) ?? 'create'}`;
const bindingSchema = z.object({ serverUrl: z.string(), sessionId: z.string(), workspaceId: z.string().uuid() });
const stateSchema = z.object({ command: TestloopDotsRequestSchema, result: resultSchema.optional() });
const storedSchema = z.discriminatedUnion('schemaVersion', [
    bindingSchema.merge(stateSchema).extend({ schemaVersion: z.literal(1) }),
    bindingSchema.merge(stateSchema).extend({ schemaVersion: z.literal(2), accountId: z.string() }),
]);
export type DotsWorkspaceCommandState = { command: DotsWorkspaceCommand; result?: DotsWorkspaceCommandResult };
function locked<T>(scope: DotsWorkspaceCommandScope, action: () => Promise<T>): Promise<T> {
    const key = scopeKey(scope);
    let lock = locks.get(key);
    if (!lock) { lock = new AsyncLock(); locks.set(key, lock); }
    return lock.inLock(action);
}

function checkedCommand(command: TestloopDotsRequest): DotsWorkspaceCommand {
    const checked = TestloopDotsRequestSchema.safeParse(command);
    if (!checked.success || !isDotsWorkspaceCommand(checked.data))
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
    const encrypted = await scope.encryption.encryptRaw({ schemaVersion: 2, accountId: scope.encryption.anonID,
        serverUrl: scope.serverUrl, sessionId: scope.sessionId, workspaceId: scope.workspaceId, ...state });
    pending.set(targetKey(scope, state.command), encrypted);
    for (const listener of listeners.get(scopeKey(scope)) ?? []) listener();
}

async function loadState(scope: DotsWorkspaceCommandScope, key: string): Promise<DotsWorkspaceCommandState | null> {
    try {
        const raw = pending.getString(key);
        if (!raw) return null;
        const stored = storedSchema.parse(await scope.encryption.decryptRaw(raw));
        const command = checkedCommand(stored.command);
        if (stored.workspaceId !== scope.workspaceId || stored.sessionId !== scope.sessionId || stored.serverUrl !== scope.serverUrl
            || (stored.schemaVersion === 1 ? key !== scopeKey(scope)
                : stored.accountId !== scope.encryption.anonID || key !== targetKey(scope, command)))
            throw new Error('scope_changed');
        const { result } = stored;
        if (result) {
            checkedResult(result, scope.workspaceId, command);
            if (!isTerminalDotsWorkspaceResult(result)) throw new Error('not_terminal');
        }
        return { command, ...(result ? { result } : {}) };
    } catch { throw new Error('dots_command_local_recovery_invalid'); }
}

/** A newer target record supersedes v1 for that target. Other targets leave the v1 intent intact. */
export async function loadDotsWorkspaceCommandStates(scope: DotsWorkspaceCommandScope): Promise<DotsWorkspaceCommandState[]> {
    const key = scopeKey(scope);
    const [legacy, ...others] = await Promise.all([key, ...pending.getAllKeys().filter(stored => stored.startsWith(`${key}:`))]
        .map(stored => loadState(scope, stored)));
    const states = others.filter(state => state !== null);
    if (legacy && !states.some(state => targetKey(scope, state.command) === targetKey(scope, legacy.command))) states.unshift(legacy);
    if (new Set(states.map(state => state.command.requestId)).size !== states.length) throw new Error('dots_command_local_recovery_invalid');
    return states;
}

/** Only the caller that persists a new intent may send it. */
export async function saveDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope, command: DotsWorkspaceCommand): Promise<boolean> {
    return locked(scope, async () => {
        const checked = checkedCommand(command);
        const states = await loadDotsWorkspaceCommandStates(scope);
        const duplicate = states.find(state => state.command.requestId === checked.requestId);
        if (duplicate) {
            if (JSON.stringify(duplicate.command) !== JSON.stringify(checked)) throw new Error('dots_command_request_conflict');
            return false;
        }
        const target = dotsWorkspaceCommandTarget(checked);
        if (states.some(state => !state.result && dotsWorkspaceCommandTarget(state.command) === target))
            throw new Error('dots_command_pending');
        await saveState(scope, { command: checked });
        return true;
    });
}

/** Keep each target's last terminal receipt for mounted observers and reload. */
export async function settleDotsWorkspaceCommand(scope: DotsWorkspaceCommandScope, command: DotsWorkspaceCommand, result: DotsWorkspaceCommandResult): Promise<void> {
    checkedResult(result, scope.workspaceId, command);
    if (!isTerminalDotsWorkspaceResult(result)) throw new Error('dots_command_unconfirmed');
    return locked(scope, async () => {
        const previous = await loadState(scope, targetKey(scope, command)) ?? await loadState(scope, scopeKey(scope));
        if (!previous || previous.result || previous.command.requestId !== command.requestId) return;
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
        || result.status === 'rejected' && (!result.error || snapshot?.ok === true)
        || !isTerminalDotsWorkspaceResult(result) && snapshot !== undefined)
        throw new Error('dots_command_invalid_response');
    return result;
}

const resultEnvelope = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: resultSchema }),
    z.object({ ok: z.literal(false), error: z.string().min(1).max(1000) })]);

async function commandRPC(sessionId: string, workspaceId: string, command: DotsWorkspaceCommand, receiptOnly: boolean) {
    const payload = { schemaVersion: 1, workspaceId, command: checkedCommand(command) };
    let reply: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const request = receiptOnly ? apiSocket.sessionRPC(sessionId, 'testloop-dots-read', { ...payload, action: 'receipt' })
            : apiSocket.sessionRPC(sessionId, 'testloop-dots-command', payload);
        reply = await Promise.race([request,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); })]);
    } catch { throw new Error('dots_command_transport_unconfirmed'); }
    finally { clearTimeout(timer); }
    const envelope = resultEnvelope.safeParse(reply);
    if (!envelope.success) throw new Error('dots_command_invalid_response');
    if (!envelope.data.ok) throw new Error(envelope.data.error);
    return checkedResult(envelope.data.data, workspaceId, command);
}

export function requestDotsWorkspaceCommand(sessionId: string, workspaceId: string, command: DotsWorkspaceCommand) {
    return commandRPC(sessionId, workspaceId, command, false);
}

export function readDotsWorkspaceCommandReceipt(sessionId: string, workspaceId: string, command: DotsWorkspaceCommand) {
    return commandRPC(sessionId, workspaceId, command, true);
}
