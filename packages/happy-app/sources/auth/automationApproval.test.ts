import { describe, expect, it, vi } from 'vitest';
import { automationApprovalApi, automationConnectionQR, parseAutomationQR, type AutomationConsent } from './automationApproval';

describe('dedicated automation approval UI adapter', () => {
    it('accepts only the dedicated QR and never treats account/terminal keys or arbitrary URLs as authorization', () => {
        expect(parseAutomationQR(automationConnectionQR('connection_1'))).toBe('connection_1');
        for (const qr of ['happy:///account?key', 'happy://terminal?key', 'https://evil.invalid?connection=x', 'happy:///automation?connection=x&url=https://evil.invalid']) expect(() => parseAutomationQR(qr)).toThrow();
    });
    it('derives the fixed same-origin control URL, uses owner bearer only for consent, and sends exact approval binding', async () => {
        const request = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: { state: 'approved' } }) }));
        const api = automationApprovalApi('https://host.invalid/home-relay', () => 'Bearer fixture-owner', request as unknown as typeof fetch);
        const consent = { id: 'connection_1', digest: 'd'.repeat(64), challenge: 'challenge_1', methods: ['tasks.create'] } as AutomationConsent;
        await api.approve(consent);
        const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://host.invalid/happy-control/v1/connections/connection_1/approve');
        expect(options.credentials).toBe('omit'); expect(options.redirect).toBe('error');
        expect(JSON.parse(options.body as string)).toEqual({ digest: consent.digest, challenge: consent.challenge });
        expect(JSON.stringify(options)).not.toMatch(/accountSecret|auth_credentials|masterKey/);
        await api.revoke('connection_1'); expect((request.mock.calls[1] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
    });
    it('does not propagate untrusted response errors or accept malformed IDs', async () => {
        const request = vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'Bearer secret-value' } }) }));
        const api = automationApprovalApi('https://host.invalid/home-relay', () => 'Bearer fixture', request as unknown as typeof fetch);
        await expect(api.consent('valid')).rejects.toThrow('AUTOMATION_UNAVAILABLE');
        await expect(api.consent('../escape')).rejects.toThrow();
    });
});

it('negotiates approval compatibility and hides network error details', async () => {
    const old=automationApprovalApi('https://fixture.invalid/home-relay',()=> 'Bearer fixture',vi.fn(async()=>({ok:true,json:async()=>({ok:true,data:{protocol:0,approval:0}})})) as unknown as typeof fetch);
    await expect(old.compatibility()).rejects.toThrow('AUTOMATION_UPGRADE_REQUIRED');
    const failed=automationApprovalApi('https://fixture.invalid/home-relay',()=> 'Bearer fixture',vi.fn(async()=>{throw new Error('Bearer fixture-private-value');}) as unknown as typeof fetch);
    await expect(failed.list()).rejects.toThrow('AUTOMATION_UNAVAILABLE');
});

it('explicitly acknowledges the service credential mode without changing signed approvals', async () => {
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }));
    const api = automationApprovalApi('https://fixture.invalid/home-relay', () => 'Bearer fixture-owner', request as unknown as typeof fetch);
    await api.approve({ id: 'service_1', digest: 'd'.repeat(64), challenge: 'fixture', credentialMode: 'service-token-v1' } as AutomationConsent);
    const options = (request.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(options.body as string).credentialMode).toBe('service-token-v1');
});

it('accepts one-time delivery only for the requested connection and never propagates a malformed delivery body', async () => {
    const data = { connectionID: 'service_1', token: `hsvc1.service_1.${'a'.repeat(43)}`, expiresAt: Date.now()+60000 };
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, data }) }));
    const api = automationApprovalApi('https://fixture.invalid/home-relay', () => 'Bearer fixture-owner', request as unknown as typeof fetch);
    const issued = await api.issueServiceToken('service_1'); expect(issued.token === data.token).toBe(true);
    data.connectionID = 'different_connection';
    await expect(api.issueServiceToken('service_1')).rejects.toThrow('SERVICE_TOKEN_DELIVERY_UNKNOWN');
});

it('acknowledges the complete v2 project binding and rejects malformed or unknown scope versions before approving', async () => {
 const request=vi.fn(async()=>({ok:true,json:async()=>({ok:true,data:{}})}));
 const api=automationApprovalApi('https://fixture.invalid/home-relay',()=> 'Bearer fixture-owner',request as unknown as typeof fetch);
 const consent={id:'multi_connection',credentialMode:'service-token-v1',scopeVersion:2,projectIDs:['a','b'],projects:[{id:'a',directory:'/fixture/a'},{id:'b',directory:'/fixture/b'}],digest:'d'.repeat(64),challenge:'fixture'} as AutomationConsent;
 await api.approve(consent);
 expect(JSON.parse((request.mock.calls[0] as unknown as [string,RequestInit])[1].body as string)).toMatchObject({scopeVersion:2,credentialMode:'service-token-v1'});
 for(const patch of [{projects:[{id:'a',directory:'/fixture/a'}]},{projectIDs:['a','a']},{scopeVersion:4},{projectID:'a'}]) await expect(api.approve({...consent,...patch} as AutomationConsent)).rejects.toThrow('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
 expect(request).toHaveBeenCalledTimes(1);
});

it('acknowledges exact v3 canonical directories including a single path and rejects pre-existing session scope', async()=>{
 const request=vi.fn(async()=>({ok:true,json:async()=>({ok:true,data:{}})}));
 const api=automationApprovalApi('https://fixture.invalid/home-relay',()=> 'Bearer fixture-owner',request as unknown as typeof fetch);
 const c={id:'directory_connection',credentialMode:'service-token-v1',scopeVersion:3,projectIDs:['dir_a'],projects:[{id:'dir_a',directory:'/fixture/a'}],sessionIDs:[],digest:'d'.repeat(64),challenge:'fixture'} as unknown as AutomationConsent;
 await api.approve(c);expect(JSON.parse((request.mock.calls[0] as unknown as [string,RequestInit])[1].body as string).scopeVersion).toBe(3);
 await expect(api.approve({...c,sessionIDs:['existing']})).rejects.toThrow('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
});
