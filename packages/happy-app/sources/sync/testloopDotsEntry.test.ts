import { describe, expect, it, vi } from 'vitest';
import { discoverDotsWorkspaces, matchesDotsWorkspace } from './testloopDotsEntry';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const dotId = '33333333-3333-4333-8333-333333333333';
const workspace = (id = 'manager-1', workspaceId = first, lifecycleState?: string) => ({ id, active: false,
    metadata: { ...(lifecycleState === undefined ? {} : { lifecycleState }), summary: { text: id },
        testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId } } });
const dot = { id: 'dot-1', active: false, metadata: { summary: { text: '写作助理' },
    testloopDots: { schemaVersion: 1, kind: 'dot', workspaceId: first, workspaceSessionId: 'manager-1', dotId } } };

function setup(sessions = [workspace()] as { id: string; metadata: unknown }[]) {
    let loaded = sessions;
    const refreshSessions = vi.fn(async (_signal?: AbortSignal) => {});
    const readSessions = vi.fn(() => loaded);
    const ensureSessionReady = vi.fn(async (_id: string) => {});
    const readSession = vi.fn((id: string) => loaded.find(s => s.id === id));
    const isCurrent = vi.fn(() => true);
    return { refreshSessions, readSessions, ensureSessionReady, readSession, isCurrent,
        setSessions: (value: typeof loaded) => { loaded = value; } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe('fixed Dots entry discovery', () => {
    it('refreshes raw account sessions and finds a workspace without native activity or visible groups', async () => {
        const deps = setup([]);
        deps.refreshSessions.mockImplementation(async () => { deps.setSessions([workspace()]); });
        const result = await discoverDotsWorkspaces(deps);
        expect(result.workspaces).toMatchObject([{ sessionId: 'manager-1', workspaceId: first, archived: false }]);
        expect(deps.refreshSessions).toHaveBeenCalledOnce();
        expect(deps.ensureSessionReady).toHaveBeenCalledWith('manager-1');
    });

    it('returns no candidate for ordinary or malformed sessions without creating anything', async () => {
        const deps = setup([{ id: 'ordinary', metadata: { summary: { text: 'Dots 工作台' } } },
            { id: 'bad', metadata: { testloopDots: { schemaVersion: 1, kind: 'workspace', workspaceId: 'invalid' } } }]);
        expect(await discoverDotsWorkspaces(deps)).toEqual({ canceled: false, workspaces: [], unresolved: 0 });
        expect(deps.ensureSessionReady).not.toHaveBeenCalled();
    });

    it('recovers a manager referenced by an actual Dot and verifies its hydrated metadata', async () => {
        const deps = setup([dot]);
        deps.ensureSessionReady.mockImplementation(async () => { deps.setSessions([dot, workspace()]); });
        expect((await discoverDotsWorkspaces(deps)).workspaces).toMatchObject([{ sessionId: 'manager-1', dotNames: ['写作助理'] }]);
    });

    it('deduplicates manager and Dot references while preserving multiple workspaces for an explicit choice', async () => {
        const deps = setup([workspace(), dot, workspace('manager-2', second)]);
        const result = await discoverDotsWorkspaces(deps);
        expect(result.workspaces.map(w => w.sessionId)).toEqual(['manager-1', 'manager-2']);
        expect(deps.ensureSessionReady).toHaveBeenCalledTimes(2);
    });

    it('marks explicit archive states without changing their lifecycle or treating inactive as archived', async () => {
        const records = [workspace(), workspace('archived', second, 'archived'), workspace('archiving', second, 'archiving')];
        const before = JSON.stringify(records);
        const result = await discoverDotsWorkspaces(setup(records));
        expect(result.workspaces.find(w => w.sessionId === 'manager-1')?.archived).toBe(false);
        expect(result.workspaces.find(w => w.sessionId === 'archived')?.archived).toBe(true);
        expect(result.workspaces.find(w => w.sessionId === 'archiving')?.archived).toBe(true);
        expect(JSON.stringify(records)).toBe(before);
    });

    it('refuses a Dot reference rebound to another workspace instead of opening the wrong manager', async () => {
        const deps = setup([dot]);
        deps.ensureSessionReady.mockImplementation(async () => { deps.setSessions([workspace('manager-1', second)]); });
        const result = await discoverDotsWorkspaces(deps);
        expect(result.workspaces).toEqual([]);
        expect(result.unresolved).toBe(1);
        expect(matchesDotsWorkspace({ sessionId: 'manager-1', workspaceId: first }, workspace('manager-1', second))).toBe(false);
    });

    it('reports an unreadable reference rather than falsely reporting that no workspace exists', async () => {
        const deps = setup([dot]);
        deps.ensureSessionReady.mockRejectedValue(new Error('offline'));
        expect(await discoverDotsWorkspaces(deps)).toMatchObject({ workspaces: [], unresolved: 1 });
    });

    it('fences late refresh results when the account, server or focused operation changes', async () => {
        const deps = setup(), pending = deferred();
        let current = true;
        deps.refreshSessions.mockImplementation(() => pending.promise);
        deps.isCurrent.mockImplementation(() => current);
        const result = discoverDotsWorkspaces(deps);
        current = false; pending.resolve();
        expect((await result).canceled).toBe(true);
        expect(deps.readSessions).not.toHaveBeenCalled();
        expect(deps.ensureSessionReady).not.toHaveBeenCalled();
    });

    it('fences a late manager hydration before reading it into the current account view', async () => {
        const deps = setup(), pending = deferred();
        let current = true;
        deps.ensureSessionReady.mockImplementation(() => pending.promise);
        deps.isCurrent.mockImplementation(() => current);
        const result = discoverDotsWorkspaces(deps);
        await vi.waitFor(() => expect(deps.ensureSessionReady).toHaveBeenCalledOnce());
        current = false; pending.resolve();
        expect((await result).canceled).toBe(true);
        expect(deps.readSession).not.toHaveBeenCalled();
    });

    it('bounds an indefinitely retrying refresh and prevents its later result from reading account sessions', async () => {
        vi.useFakeTimers();
        try {
            const deps = setup(), pending = deferred();
            deps.refreshSessions.mockImplementation(() => pending.promise);
            const result = discoverDotsWorkspaces(deps);
            const timeout = expect(result).rejects.toThrow('dots_entry_timeout');
            await vi.advanceTimersByTimeAsync(15000); await timeout;
            expect(deps.refreshSessions.mock.calls[0][0]?.aborted).toBe(true);
            pending.resolve(); await Promise.resolve(); await Promise.resolve();
            expect(deps.readSessions).not.toHaveBeenCalled();
            expect(deps.readSession).not.toHaveBeenCalled();
        } finally { vi.useRealTimers(); }
    });

    it('propagates focus or retry cancellation to the refresh request without consuming its late state', async () => {
        const deps = setup(), pending = deferred(), controller = new AbortController();
        deps.refreshSessions.mockImplementation(() => pending.promise);
        const result = discoverDotsWorkspaces({ ...deps, signal: controller.signal });
        controller.abort(); pending.resolve();
        expect((await result).canceled).toBe(true);
        expect(deps.refreshSessions.mock.calls[0][0]?.aborted).toBe(true);
        expect(deps.readSessions).not.toHaveBeenCalled();
    });
});
