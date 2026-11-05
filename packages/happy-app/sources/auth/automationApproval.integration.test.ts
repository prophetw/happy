import { afterEach, expect, it } from 'vitest';
import { automationApprovalApi, consentProjects, type AutomationConsent } from './automationApproval';

// Load the backend fixture the same way as gateway tests, keeping backend
// example sources outside the mobile application's TypeScript compilation.
const fixturePath = new URL('../../../happy-agent/examples/rest-fixture.ts', import.meta.url).pathname;
interface Fixture {
    close(): Promise<void>;
    ownerRequest(route: string, method?: string, body?: unknown): Promise<{ status: number; body: { data: AutomationConsent } }>;
}
const rigs: Fixture[] = [];
afterEach(async () => { await Promise.all(rigs.splice(0).map(rig => rig.close())); });
it('reads and approves the real gateway legacy single-project consent including its projects compatibility alias', async () => {
    const { fixtureRig } = await import(fixturePath);
    const rig: Fixture = await fixtureRig({ multipleProjects: true, serviceTokens: { clients: [{ id: 'service', userID: 'userA', name: 'Fixture service', generation: 'v1' }] } });
    rigs.push(rig);
    const created = await rig.ownerRequest('/service-connections', 'POST', {
        clientID: 'service', workerID: 'worker', machineID: 'machineA', projectID: 'projectA',
        methods: ['tasks.create'], sessionIDs: [], expiresAt: Date.now() + 60000,
    });
    expect(created.status).toBe(200);
    const id = created.body.data.id;
    const raw = (await rig.ownerRequest(`/connections/${id}/consent`)).body.data;
    expect(raw.scopeVersion).toBeUndefined(); expect(raw.projectIDs).toBeUndefined();
    expect(raw.projects).toEqual([{ id: raw.projectID, directory: raw.projectDirectory }]);
    const calls: { route: string; method: string; body: unknown }[] = [];
    const request: typeof fetch = async (url, options) => {
        const route = new URL(String(url)).pathname.replace('/happy-control/v1', ''), method = options?.method ?? 'GET';
        const body = options?.body ? JSON.parse(String(options.body)) : undefined;
        calls.push({ route, method, body });
        const response = await rig.ownerRequest(route, method, body);
        return Response.json(response.body, { status: response.status });
    };
    const api = automationApprovalApi('https://fixture.invalid/home-relay', () => 'Bearer fixture-owner', request);
    const consent = await api.consent(id);
    expect(consentProjects(consent)).toEqual([{ id: raw.projectID, directory: raw.projectDirectory }]);
    expect(calls).toHaveLength(1);
    await api.approve(consent);
    expect(calls[1].body).toEqual({ digest: raw.digest, challenge: raw.challenge, credentialMode: 'service-token-v1' });
    expect((await rig.ownerRequest(`/connections/${id}/consent`)).body.data.state).toBe('approved');
});
