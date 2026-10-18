import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLock } from '@/utils/lock';
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://old.test', currentCliVersion: 'test' } }));
import { withRelayLock } from './relayConnection';

describe('bounded live switch state locking', () => {
    afterEach(() => vi.useRealTimers());
    it('does not perform an expired switch when a busy state lock is eventually released', async () => {
        vi.useFakeTimers();
        const lock = new AsyncLock();
        let release!: () => void;
        const held = lock.inLock(() => new Promise<void>(resolve => { release = resolve; }));
        await Promise.resolve();
        let switched = false;
        const attempted = withRelayLock(lock, async () => { switched = true; });
        const rejected = expect(attempted).rejects.toThrow('busy');
        await vi.advanceTimersByTimeAsync(3_000);
        await rejected;
        release();
        await held;
        await vi.runAllTimersAsync();
        expect(switched).toBe(false);
        expect(await lock.inLock(async () => 'available')).toBe('available');
    });
});
