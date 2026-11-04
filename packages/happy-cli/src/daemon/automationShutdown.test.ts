import { describe, expect, it, vi } from 'vitest';
import { cleanupAutomationDaemon } from './automationShutdown';
function fixture() { return { stopWorker: vi.fn(async () => {}), announce: vi.fn(async () => {}), disconnect: vi.fn(() => {}), stopControl: vi.fn(async () => {}), clearState: vi.fn(async () => {}), releaseLock: vi.fn(async () => {}), stopCaffeinate: vi.fn(async () => {}) }; }
describe('managed worker local shutdown', () => {
    it('releases ownership after bounded offline worker/relay failures', async () => {
        vi.useFakeTimers(); const s = fixture(), reports: unknown[] = [];
        s.stopWorker.mockImplementation(() => new Promise(() => {})); s.announce.mockImplementation(() => new Promise(() => {}));
        try { const done = cleanupAutomationDaemon(s, (...v) => reports.push(v), 20); await vi.advanceTimersByTimeAsync(100); expect(await done).toEqual({ localOwnershipReleased: true }); expect(s.releaseLock).toHaveBeenCalledOnce(); expect(reports).toContainEqual(['relay-announcement', 'unconfirmed']); }
        finally { vi.useRealTimers(); }
    });
    it('retains state and lock if listener shutdown cannot be confirmed', async () => {
        const s = fixture();s.stopControl.mockRejectedValue(Error('fixture failure'));
        expect(await cleanupAutomationDaemon(s, () => {})).toEqual({ localOwnershipReleased: false });expect(s.clearState).not.toHaveBeenCalled();expect(s.releaseLock).not.toHaveBeenCalled();
    });
    it('retains the lock if owned state removal fails and keeps errors out of reports', async () => {
        const s = fixture(), report = vi.fn();s.clearState.mockRejectedValue(Error('fixture-secret'));
        expect((await cleanupAutomationDaemon(s, report)).localOwnershipReleased).toBe(false);expect(s.releaseLock).not.toHaveBeenCalled();expect(JSON.stringify(report.mock.calls)).not.toContain('fixture-secret');
    });
});
