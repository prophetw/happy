/** Existing authenticated client preflight: two GETs, public identity fields only, no daemon/login. */
export async function inspectAutomationMetadata(expectedRelay: string, deps: {
    relayURL: string;
    credentials: () => Promise<{ token: string; encryption: { type: string } } | null>;
    settings: () => Promise<{ machineId?: string }>;
    request: (url: string, authorization: string) => Promise<unknown>;
}) {
    const approved = new URL(expectedRelay);
    if (approved.protocol !== 'https:' || approved.username || approved.password || approved.search || approved.hash
        || expectedRelay.replace(/\/$/, '') !== deps.relayURL.replace(/\/$/, '')) throw new Error('AUTOMATION_RELAY_BINDING_MISMATCH');
    const [credentials, settings] = await Promise.all([deps.credentials(), deps.settings()]);
    if (!credentials || credentials.encryption.type !== 'dataKey' || !settings.machineId) throw new Error('AUTOMATION_EXISTING_AUTH_REQUIRED');
    try {
        const root = expectedRelay.replace(/\/$/, '');
        const [profile, machines] = await Promise.all([
            deps.request(root + '/v1/account/profile', 'Bearer ' + credentials.token),
            deps.request(root + '/v1/machines', 'Bearer ' + credentials.token),
        ]);
        const id = (profile as { id?: unknown })?.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Array.isArray(machines)
            || !machines.some(machine => machine?.id === settings.machineId)) throw new Error();
        return { userID: id, machineID: settings.machineId, relayURL: root, encryptionType: 'dataKey' };
    } catch { throw new Error('AUTOMATION_EXISTING_IDENTITY_UNVERIFIED'); }
}
