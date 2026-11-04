import { join } from 'node:path';
import axios from 'axios';
import { createDaemonTransport, HTTPWorkerRunner, ProofClient, type ProofIdentity, type WorkerRegistration } from 'happy-agent/automation';
import type { Machine } from '@/api/types';
import type { TrackedSession } from './types';

export type DaemonAutomationOptions = {
    endpoint: string; identity: ProofIdentity; registration: WorkerRegistration;
    report: (event: { state: string; code?: string }) => void;
};
/** Explicit opt-in only: no key-file discovery, login, public listener, or automatic grant. */
export async function startDaemonAutomation(options: DaemonAutomationOptions, bindings: {
    machine: Machine; token: string; serverUrl: string; happyHomeDir: string;
    sessions: () => TrackedSession[]; control: (input: unknown) => Promise<unknown>;
}) {
    if (options.registration.id !== options.identity.id || options.registration.machineID !== bindings.machine.id
        || bindings.machine.encryptionVariant !== 'dataKey') throw new Error('AUTOMATION_WORKER_IDENTITY_MISMATCH');
    try {
        const profile = await axios.get(`${bindings.serverUrl}/v1/account/profile`, { headers: { Authorization: `Bearer ${bindings.token}` }, timeout: 10000, maxRedirects: 0 });
        if (profile.data.id !== options.registration.userID) throw new Error('mismatch');
    } catch { throw new Error('AUTOMATION_WORKER_OWNER_UNVERIFIED'); }
    const machine = bindings.machine;
    const transport = createDaemonTransport({ ...bindings,
        machine: () => ({ ...machine, seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: Date.now(), daemonState: null, dataEncryptionKey: null,
            encryption: { key: machine.encryptionKey, variant: machine.encryptionVariant } }),
        sessions: () => bindings.sessions().flatMap(s => s.happySessionId && s.encryption?.encryptionVariant === 'dataKey' ? [{
            id: s.happySessionId, seq: s.encryption.seq, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
            metadata: s.happySessionMetadataFromLocalWebhook, agentState: null, dataEncryptionKey: null,
            encryption: { key: s.encryption.encryptionKey, variant: s.encryption.encryptionVariant },
        }] : []),
    });
    const controller = new AbortController();
    const client = new ProofClient(options.endpoint, options.identity, 'worker', { signal: controller.signal });
    const runner = new HTTPWorkerRunner(client, options.registration, transport, join(bindings.happyHomeDir, 'automation-worker'));
    const running = runner.run(controller.signal, 250, options.report);
    return { stop: async () => { controller.abort(); await running; } };
}
