import { describe, expect, it, vi } from 'vitest';
import { createTestloopDotsNavigationGuard } from './testloopDotsNavigation';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe('Dot navigation after asynchronous session hydration', () => {
    it('opens the destination only after hydration finishes while its source still owns focus', async () => {
        const guard = createTestloopDotsNavigationGuard(), hydration = deferred(), open = vi.fn();
        guard.update('workspace/session-a', true);
        const result = guard.begin()!.afterReady(() => hydration.promise, open);
        expect(open).not.toHaveBeenCalled();
        hydration.resolve();
        await expect(result).resolves.toBe(true);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('cancels a retained screen navigation when focus leaves during hydration', async () => {
        const guard = createTestloopDotsNavigationGuard(), hydration = deferred(), open = vi.fn();
        guard.update('workspace/session-a', true);
        const result = guard.begin()!.afterReady(() => hydration.promise, open);
        guard.update('workspace/session-a', false);
        hydration.resolve();
        await expect(result).resolves.toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('does not revive an earlier return-to-workspace operation after blur and refocus', async () => {
        const guard = createTestloopDotsNavigationGuard(), hydration = deferred(), open = vi.fn();
        guard.update('dot/session-b', true);
        const result = guard.begin()!.afterReady(() => hydration.promise, open);
        guard.update('dot/session-b', false);
        guard.update('dot/session-b', true);
        hydration.resolve();
        await expect(result).resolves.toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('cancels navigation after unmount even when the old hydration later succeeds', async () => {
        const guard = createTestloopDotsNavigationGuard(), hydration = deferred(), open = vi.fn();
        guard.update('dot/session-b', true);
        const result = guard.begin()!.afterReady(() => hydration.promise, open);
        guard.invalidate();
        hydration.resolve();
        await expect(result).resolves.toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('does not navigate using a superseded source-session binding', async () => {
        const guard = createTestloopDotsNavigationGuard(), hydration = deferred(), open = vi.fn();
        guard.update('dot/session-b/workspace-1', true);
        const result = guard.begin()!.afterReady(() => hydration.promise, open);
        guard.update('dot/session-c/workspace-2', true);
        hydration.resolve();
        await expect(result).resolves.toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('lets a later click supersede the older request without a delayed jump back', async () => {
        const guard = createTestloopDotsNavigationGuard(), firstHydration = deferred(), openFirst = vi.fn(), openSecond = vi.fn();
        guard.update('workspace/session-a', true);
        const first = guard.begin()!.afterReady(() => firstHydration.promise, openFirst);
        await expect(guard.begin()!.afterReady(async () => {}, openSecond)).resolves.toBe(true);
        firstHydration.resolve();
        await expect(first).resolves.toBe(false);
        expect(openFirst).not.toHaveBeenCalled();
        expect(openSecond).toHaveBeenCalledTimes(1);
    });

    it('preserves an active hydration error for the page to display and refuses inactive starts', async () => {
        const guard = createTestloopDotsNavigationGuard(), open = vi.fn();
        expect(guard.begin()).toBeNull();
        guard.update('workspace/session-a', true);
        const operation = guard.begin()!;
        await expect(operation.afterReady(async () => { throw new Error('unavailable'); }, open)).rejects.toThrow('unavailable');
        expect(operation.isCurrent()).toBe(true);
        expect(open).not.toHaveBeenCalled();
    });
});
