import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelaySwitchController } from './relaySwitch';

const target = { id: 'move-1', serverUrl: 'https://new.test/relay', token: 'target-token' };

describe('live relay switch control', () => {
    afterEach(() => vi.useRealTimers());

    it('keeps rollback available after persisting a switch', async () => {
        const events: string[] = [];
        const controller = new RelaySwitchController(async () => ({
            commit: async () => { events.push('connected'); },
            finish: async () => { events.push('saved'); },
            rollback: async () => { events.push('restored'); },
            dispose: () => { events.push('closed-unused'); },
        }));
        for (const phase of ['prepare', 'commit', 'finish', 'rollback']) {
            expect(await controller.handle({ ...target, phase })).toEqual({ success: true });
        }
        expect(events).toEqual(['connected', 'saved', 'restored', 'closed-unused']);
    });

    it('rejects a stale commit instead of changing a different transaction', async () => {
        let committed = false;
        const controller = new RelaySwitchController(async () => ({
            commit: async () => { committed = true; }, finish: async () => {}, rollback: async () => {}, dispose: () => {},
        }));
        await controller.handle({ ...target, phase: 'prepare' });
        expect(await controller.handle({ ...target, id: 'stale', phase: 'commit' })).toHaveProperty('error');
        expect(committed).toBe(false);
        controller.dispose();
    });

    it('automatically restores the old connection if the app abandons a commit', async () => {
        vi.useFakeTimers();
        let restored = false;
        const controller = new RelaySwitchController(async () => ({
            commit: async () => {}, finish: async () => {},
            rollback: async () => { restored = true; }, dispose: () => {},
        }));
        await controller.handle({ ...target, phase: 'prepare' });
        await controller.handle({ ...target, phase: 'commit' });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(restored).toBe(true);
    });

    it('does not claim rollback succeeded after a completed transaction expires', async () => {
        vi.useFakeTimers();
        const controller = new RelaySwitchController(async () => ({
            commit: async () => {}, finish: async () => {}, rollback: async () => {}, dispose: () => {},
        }));
        for (const phase of ['prepare', 'commit', 'finish']) await controller.handle({ ...target, phase });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await controller.handle({ ...target, phase: 'rollback' })).toMatchObject({ error: expect.stringContaining('expired') });
    });

    it('retries failed automatic rollback without an unhandled rejection', async () => {
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let attempts = 0;
        const controller = new RelaySwitchController(async () => ({
            commit: async () => {}, finish: async () => {}, dispose: () => {},
            rollback: async () => { if (++attempts === 1) throw new Error('disk temporarily unavailable'); },
        }));
        await controller.handle({ ...target, phase: 'prepare' });
        await vi.advanceTimersByTimeAsync(130_000);
        expect(attempts).toBe(2);
        expect(warning).toHaveBeenCalledOnce();
        warning.mockRestore();
    });

    it('retries an explicitly requested rollback even after finish already succeeded', async () => {
        vi.useFakeTimers();
        let attempts = 0;
        let disposed = 0;
        const controller = new RelaySwitchController(async () => ({
            commit: async () => {}, finish: async () => {}, dispose: () => { disposed++; },
            rollback: async () => { if (++attempts === 1) throw new Error('temporary old socket failure'); },
        }));
        for (const phase of ['prepare', 'commit', 'finish']) await controller.handle({ ...target, phase });
        expect(await controller.handle({ ...target, phase: 'rollback' })).toHaveProperty('error');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(attempts).toBe(2);
        expect(disposed).toBe(1);
    });
});
