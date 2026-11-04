/** Dedicated automation consent. Never uses the account-link QR or account secret. */
export interface AutomationConsent {
    id: string; userID: string; clientID: string; clientName: string; clientFingerprint: string; workerFingerprint: string;
    workerID: string; workerName: string; machineID: string; projectID?: string; projectDirectory?: string;
    scopeVersion?: 2 | 3; projectIDs?: string[]; projects?: { id: string; directory: string }[];
    methods: string[]; sessionIDs: string[]; expiresAt: number; pendingUntil: number;
    externalIdentity?: { issuer: string; subject: string; tenant: string; oauthClientID: string };
    credentialMode?: 'service-token-v1';
    serviceToken?: { issued: boolean; issuedAt?: number; expiresAt?: number };
    state: string; digest: string; challenge: string; disclosure: string;
}
export interface ServiceConnectionOptions {
    protocol: 1; maxGrantMs: number; projectScopes?: 1; directoryScopes?: 1; maxProjects?: number; clients: { id: string; name: string; fingerprint: string }[];
    workers: { id: string; name: string; machineID: string; projectScopes?: 1; directoryScopes?: 1; directorySelection?: { roots: string[] }; methods: string[]; projects: { id: string; directory: string; sessionIDs: string[] }[] }[];
}
export type ServiceConnectionRequest = {
    clientID: string; workerID: string; machineID: string; methods: string[]; sessionIDs: string[]; expiresAt: number;
} & ({ projectID: string } | { scopeVersion: 2; projectIDs: string[] } | { scopeVersion: 3; projectIDs: string[]; projects: { id: string; directory: string }[]; selectionID: string });
/** Do not approve a multi-project shape that this page cannot fully display. */
export function consentProjects(consent: AutomationConsent): { id: string; directory: string }[] {
    if (consent.scopeVersion === undefined) {
        if (consent.projectIDs !== undefined || consent.projects !== undefined) throw new Error('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
        return [{ id: consent.projectID ?? '', directory: consent.projectDirectory ?? '' }];
    }
    const ids = consent.projectIDs, projects = consent.projects;
    if (consent.scopeVersion === 3 && consent.sessionIDs?.length) throw new Error('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
    if ((consent.scopeVersion !== 2 && consent.scopeVersion !== 3) || consent.credentialMode !== 'service-token-v1' || consent.projectID !== undefined || consent.projectDirectory !== undefined
        || !Array.isArray(ids) || ids.length < (consent.scopeVersion === 3 ? 1 : 2) || ids.length > 32 || new Set(ids).size !== ids.length
        || !Array.isArray(projects) || projects.length !== ids.length
        || projects.some((p, i) => !p || p.id !== ids[i] || !/^[A-Za-z0-9_-]{1,128}$/.test(p.id) || typeof p.directory !== 'string' || !p.directory.startsWith('/'))) throw new Error('PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED');
    return projects;
}
export function automationConnectionQR(id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid connection ID');
    return `happy:///automation?connection=${id}`;
}
export function parseAutomationQR(value: string) {
    const match = /^happy:\/\/\/automation\?connection=([A-Za-z0-9_-]{1,128})$/.exec(value);
    if (!match) throw new Error('This is not an automation connection QR'); return match[1];
}
export function automationApprovalApi(relayUrl: string, getOwnerAuthorization: () => string, request: typeof fetch = fetch) {
    const origin = new URL(relayUrl).origin, base = `${origin}/happy-control/v1`;
    if (new URL(origin).protocol !== 'https:' && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) throw new Error('HTTPS required');
    async function call(route: string, method = 'GET', body?: unknown) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
        try {
        const response = await request(base + route, { method, credentials: 'omit', redirect: 'error', signal: controller.signal,
            headers: { Authorization: getOwnerAuthorization(), Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error(typeof result.error?.code === 'string' && /^[A-Z_]+$/.test(result.error.code) ? result.error.code : 'AUTOMATION_UNAVAILABLE');
        return result.data;
        } catch (error) {
            if (error instanceof Error && /^[A-Z_]{1,64}$/.test(error.message)) throw error;
            throw new Error('AUTOMATION_UNAVAILABLE');
        } finally { clearTimeout(timer); }
    }
    const path = (id: string) => { automationConnectionQR(id); return `/connections/${id}`; };
    return {
        compatibility: async () => { const value = await call('/compatibility'); if (value.protocol !== 1 || value.approval !== 1 || value.worker !== 1) throw new Error('AUTOMATION_UPGRADE_REQUIRED'); return value; },
        list: () => call('/connections') as Promise<AutomationConsent[]>,
        consent: async (id: string): Promise<AutomationConsent> => { const value = await call(`${path(id)}/consent`); consentProjects(value); return value; },
        approve: async (consent: AutomationConsent) => {
            if (consent.scopeVersion !== undefined || consent.projectIDs !== undefined || consent.projects !== undefined) consentProjects(consent);
            return call(`${path(consent.id)}/approve`, 'POST', { digest: consent.digest, challenge: consent.challenge, ...(consent.credentialMode ? { credentialMode: consent.credentialMode } : {}), ...(consent.scopeVersion ? { scopeVersion: consent.scopeVersion } : {}) });
        },
        revoke: async (id: string) => call(path(id), 'DELETE'),
        serviceOptions: () => call('/service-connections/options') as Promise<ServiceConnectionOptions>,
        resolveDirectories: (input: { clientID: string; workerID: string; machineID: string; directories: string[] }) => call('/service-connections/resolve-directories', 'POST', input) as Promise<{ selectionID: string; projects: { id: string; directory: string }[]; expiresAt: number }>,
        createService: (scope: ServiceConnectionRequest) => call('/service-connections', 'POST', scope) as Promise<AutomationConsent>,
        issueServiceToken: async (id: string): Promise<{ connectionID: string; token: string; expiresAt: number }> => {
            const value = await call(`${path(id)}/service-token`, 'POST');
            if (value.connectionID !== id || typeof value.token !== 'string' || !new RegExp(`^hsvc1\\.${id}\\.[A-Za-z0-9_-]{43}$`).test(value.token) || !Number.isSafeInteger(value.expiresAt)) throw new Error('SERVICE_TOKEN_DELIVERY_UNKNOWN');
            return value;
        },
    };
}
