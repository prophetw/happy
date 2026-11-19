import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), values: new Map<string, string>(), failStorage: false }));
vi.mock('./apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return mocks.values.get(key); }
    getAllKeys() { return [...mocks.values.keys()]; }
    set(key: string, value: string) { if (mocks.failStorage) throw new Error('disk full'); mocks.values.set(key, value); }
    delete(key: string) { if (mocks.failStorage) throw new Error('disk full'); mocks.values.delete(key); }
} }));

import { loadDotsWorkspaceCommandStates, saveDotsWorkspaceCommand, settleDotsWorkspaceCommand,
    subscribeDotsWorkspaceCommand, requestDotsWorkspaceCommand } from './dotsWorkspaceCommand';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const dotId = '33333333-3333-4333-8333-333333333333';
const command = { schemaVersion: 1 as const, requestId, action: 'create' as const, name: '助理', instruction: '整理通知' };
const dot = { id: dotId, name: '助理', instruction: '整理通知', sessionId: 'dot-session', status: 'active' as const };
const snapshot = { schemaVersion: 1 as const, workspaceId, requestId, revision: 1, ok: true, dots: [dot] };
const applied = { schemaVersion: 1 as const, workspaceId, requestId, status: 'applied' as const, error: null, snapshot };

beforeEach(() => { mocks.rpc.mockReset(); mocks.values.clear(); mocks.failStorage = false; });
afterEach(() => vi.useRealTimers());

it('returns the confirmed command result through the encrypted workspace RPC', async () => {
    mocks.rpc.mockResolvedValue({ ok: true, data: applied });
    await expect(requestDotsWorkspaceCommand('workspace-session', workspaceId, command)).resolves.toEqual(applied);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('workspace-session', 'testloop-dots-command', {
        schemaVersion: 1, workspaceId, command,
    });
});

it('rejects a receipt for another binding or one without a durable terminal outcome', async () => {
    for (const patch of [
        { workspaceId: dotId }, { requestId: dotId }, { snapshot: undefined },
        { snapshot: { ...snapshot, requestId: dotId } }, { snapshot: { ...snapshot, workspaceId: dotId } },
        { snapshot: { ...snapshot, ok: false } }, { error: 'not_really_applied' },
        { status: 'rejected', error: null, snapshot: undefined },
    ]) {
        mocks.rpc.mockResolvedValue({ ok: true, data: { ...applied, ...patch } });
        await expect(requestDotsWorkspaceCommand('workspace-session', workspaceId, command)).rejects.toThrow('dots_command_invalid_response');
    }
});

it('accepts only management writes and requires the matching deletion proof', async () => {
    mocks.rpc.mockResolvedValue({ ok: true, data: applied });
    await expect(requestDotsWorkspaceCommand('workspace-session', workspaceId,
        { schemaVersion: 1, requestId, action: 'list' } as any)).rejects.toThrow('dots_command_invalid_request');
    expect(mocks.rpc).not.toHaveBeenCalled();
    await expect(requestDotsWorkspaceCommand('workspace-session', workspaceId,
        { schemaVersion: 1, requestId, action: 'delete', dotId })).rejects.toThrow('dots_command_invalid_response');
});

it('bounds a lost response as unknown so the original command remains recoverable', async () => {
    vi.useFakeTimers();
    mocks.rpc.mockImplementation(() => new Promise(() => {}));
    const outcome = expect(requestDotsWorkspaceCommand('workspace-session', workspaceId, command))
        .rejects.toThrow('dots_command_transport_unconfirmed');
    await vi.advanceTimersByTimeAsync(10000);
    await outcome;
}, 500);

function scope(account = 'account-a', serverUrl = 'https://relay.example') {
    const key = Buffer.alloc(32, account === 'account-a' ? 7 : 8);
    return { workspaceId, sessionId: 'workspace-session', serverUrl, encryption: {
        anonID: account,
        encryptRaw: async (value: unknown) => {
            const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
            return Buffer.concat([nonce, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
        },
        decryptRaw: async (value: string) => {
            const raw = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
            cipher.setAuthTag(raw.subarray(-16));
            return JSON.parse(Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString());
        },
    } };
}

it('restores the original encrypted intent after remount without exposing it to another account or relay', async () => {
    await saveDotsWorkspaceCommand(scope(), command);
    await expect(loadDotsWorkspaceCommandStates(scope())).resolves.toEqual([{ command }]);
    await expect(loadDotsWorkspaceCommandStates(scope('account-b'))).resolves.toEqual([]);
    await expect(loadDotsWorkspaceCommandStates(scope('account-a', 'https://other.example'))).resolves.toEqual([]);
    expect([...mocks.values.values()].join('')).not.toContain('整理通知');
    expect([...mocks.values.values()].join('')).not.toContain(requestId);
});

it('keeps one immutable pending command when two workspace views submit concurrently', async () => {
    const other = { ...command, requestId: dotId, name: '另一助理' };
    const results = await Promise.allSettled([
        saveDotsWorkspaceCommand(scope(), command), saveDotsWorkspaceCommand(scope(), other),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    await expect(loadDotsWorkspaceCommandStates(scope())).resolves.toEqual([{ command }]);
    await expect(saveDotsWorkspaceCommand(scope(), { ...command, instruction: '改变的草稿' })).rejects.toThrow('dots_command_request_conflict');
    await expect(saveDotsWorkspaceCommand(scope(), command)).resolves.toBe(false);
});

it('recovers a legacy clear while persisting an independent Dot write and settling both in either order', async () => {
    const bound = scope();
    const clear = { schemaVersion: 1 as const, requestId, action: 'clear' as const, dotId };
    const other = { ...clear, requestId: dotId, dotId: workspaceId };
    mocks.values.set(JSON.stringify([bound.encryption.anonID, bound.serverUrl, bound.sessionId, workspaceId]),
        await bound.encryption.encryptRaw({ schemaVersion: 1, serverUrl: bound.serverUrl,
            sessionId: bound.sessionId, workspaceId, command: clear }));
    await expect(saveDotsWorkspaceCommand(bound, other)).resolves.toBe(true);
    await expect(saveDotsWorkspaceCommand(bound, { ...clear, requestId: workspaceId })).rejects.toThrow('dots_command_pending');
    await settleDotsWorkspaceCommand(bound, clear, applied);
    await expect(loadDotsWorkspaceCommandStates(bound)).resolves.toEqual(expect.arrayContaining([{ command: clear, result: applied }, { command: other }]));
    await settleDotsWorkspaceCommand(bound, other, { ...applied, requestId: other.requestId,
        snapshot: { ...snapshot, requestId: other.requestId } });
    expect((await loadDotsWorkspaceCommandStates(bound)).map(state => state.result?.requestId).sort()).toEqual([requestId, other.requestId].sort());
});

it('shares and restores the terminal receipt without allowing a stale receipt to clear a newer intent', async () => {
    const listener = vi.fn(), foreign = vi.fn();
    const off = subscribeDotsWorkspaceCommand(scope(), listener), offForeign = subscribeDotsWorkspaceCommand(scope('account-b'), foreign);
    await saveDotsWorkspaceCommand(scope(), command);
    await settleDotsWorkspaceCommand(scope(), command, applied);
    await expect(loadDotsWorkspaceCommandStates(scope())).resolves.toEqual([{ command, result: applied }]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(foreign).not.toHaveBeenCalled();
    const next = { ...command, requestId: dotId, name: '下一次' };
    await saveDotsWorkspaceCommand(scope(), next);
    await settleDotsWorkspaceCommand(scope(), command, applied);
    await expect(loadDotsWorkspaceCommandStates(scope())).resolves.toEqual([{ command: next }]);
    off(); offForeign();
});
