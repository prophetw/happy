import { describe, expect, it, vi } from 'vitest';
import { inspectAutomationMetadata } from './automationMetadata';
const relay = 'https://control.fixture/home-relay';
function fixture() {
    return { relayURL: relay,
        credentials: vi.fn(async () => ({ token: 'fixture-secret-not-for-output', encryption: { type: 'dataKey', machineKey: 'fixture-private' } })),
        settings: vi.fn(async () => ({ machineId: 'machineA' })),
        request: vi.fn(async (url: string) => url.endsWith('/profile') ? { id: 'userA', private: 'fixture-unwanted-profile' } : [{ id: 'machineA', metadata: 'fixture-encrypted-metadata' }]),
    };
}
describe('read-only existing identity preflight', () => {
    it('uses only existing authentication and returns explicit public identity fields', async () => {
        const f = fixture(); const result = await inspectAutomationMetadata(relay, f);
        expect(result).toEqual({ userID: 'userA', machineID: 'machineA', relayURL: relay, encryptionType: 'dataKey' });
        expect(f.request.mock.calls.map(([url]) => url)).toEqual([relay + '/v1/account/profile', relay + '/v1/machines']);
        expect(JSON.stringify(result)).not.toContain('fixture-');
    });
    it('refuses another relay before credentials or network access', async () => {
        const f = fixture(); await expect(inspectAutomationMetadata('https://other.invalid', f)).rejects.toThrow('AUTOMATION_RELAY_BINDING_MISMATCH');
        expect(f.credentials).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    });
    it('missing/dataKey-incompatible credentials never trigger login or registration', async () => {
        const f = fixture(); f.credentials.mockResolvedValue({ token: 'fixture', encryption: { type: 'legacy', machineKey: 'unused' } });
        await expect(inspectAutomationMetadata(relay, f)).rejects.toThrow('AUTOMATION_EXISTING_AUTH_REQUIRED'); expect(f.request).not.toHaveBeenCalled();
    });
    it('mismatched machine ownership and network diagnostics fail closed without secret output', async () => {
        const f = fixture(); f.request.mockImplementation(async () => { throw new Error('fixture-secret-not-for-output'); });
        await expect(inspectAutomationMetadata(relay, f)).rejects.toThrow('AUTOMATION_EXISTING_IDENTITY_UNVERIFIED');
        const foreign = fixture(); foreign.request.mockImplementation(async url => url.endsWith('/profile') ? { id: 'userA', private: 'fixture' } : [{ id: 'machineB', metadata: 'encrypted' }]);
        await expect(inspectAutomationMetadata(relay, foreign)).rejects.toThrow('AUTOMATION_EXISTING_IDENTITY_UNVERIFIED');
    });
});
