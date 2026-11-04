import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { startDaemonAutomation } from './automationWorker';
import type { DaemonAutomationOptions } from './automationWorker';
import type { Machine } from '@/api/types';

const mocks = vi.hoisted(() => ({ get: vi.fn(), transport: vi.fn(), proof: vi.fn(), run: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mocks.get } }));
vi.mock('happy-agent/automation', () => ({
    createDaemonTransport: mocks.transport,
    ProofClient: class { constructor(...args: unknown[]) { mocks.proof(...args); } },
    HTTPWorkerRunner: class { run(signal: AbortSignal) { mocks.run(); return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } },
}));
beforeEach(() => { vi.clearAllMocks(); mocks.get.mockResolvedValue({ data: { id: 'userA' } }); });
function setup() {
    const pair = generateKeyPairSync('ed25519');
    const options: DaemonAutomationOptions = { endpoint: 'https://control.invalid/happy-control/v1', identity: { id: 'worker', privateKey: pair.privateKey },
        registration: { id: 'worker', userID: 'userA', name: 'Fixture', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), machineID: 'machineA', projects: [], methods: [], protocol: 1 }, report: vi.fn() };
    const bindings = { machine: { id: 'machineA', encryptionVariant: 'dataKey', encryptionKey: new Uint8Array(32) } as Machine,
        token: 'fixture-private-bearer', serverUrl: 'https://relay.invalid', happyHomeDir: '/fixture-unused', sessions: () => [], control: async () => ({ version: 1 }) };
    return { options, bindings };
}
describe('explicit daemon worker bootstrap (no credentials/files/network)', () => {
    it('rejects mismatched machine, identity and legacy keys before profile or worker startup', async () => {
        const { options, bindings } = setup();
        await expect(startDaemonAutomation(options, { ...bindings, machine: { ...bindings.machine, id: 'other' } })).rejects.toThrow('AUTOMATION_WORKER_IDENTITY_MISMATCH');
        await expect(startDaemonAutomation(options, { ...bindings, machine: { ...bindings.machine, encryptionVariant: 'legacy' } })).rejects.toThrow('AUTOMATION_WORKER_IDENTITY_MISMATCH');
        expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
    });
    it('checks actual owner identity and sanitizes profile failures without leaking bearer', async () => {
        const { options, bindings } = setup(); mocks.get.mockResolvedValueOnce({ data: { id: 'wrong-user' } });
        await expect(startDaemonAutomation(options, bindings)).rejects.toThrow('AUTOMATION_WORKER_OWNER_UNVERIFIED');
        mocks.get.mockRejectedValueOnce(new Error('Bearer fixture-private-bearer'));
        await expect(startDaemonAutomation(options, bindings)).rejects.toThrow('AUTOMATION_WORKER_OWNER_UNVERIFIED');
        expect(mocks.run).not.toHaveBeenCalled();
    });
    it('starts only the outbound runner and aborts it on stop; exposes no credential in the handle', async () => {
        const { options, bindings } = setup(); const handle = await startDaemonAutomation(options, bindings);
        expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.transport).toHaveBeenCalledTimes(1);
        expect(mocks.get).toHaveBeenCalledWith('https://relay.invalid/v1/account/profile', expect.objectContaining({ maxRedirects: 0, timeout: 10000 }));
        expect(Object.keys(handle)).toEqual(['stop']); await handle.stop();
    });
});
