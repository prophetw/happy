import axios from 'axios';
import { decryptField, type RawSession } from '../../api';
import type { DecryptedMachine, DecryptedSession } from '../../api';
import { ControlError, recordMessageTransport, type Transport } from '../relay';
import type { Connection } from './schema';

export type DaemonTransportBindings = {
    serverUrl: string;
    /** Existing in-process daemon identity. Never sent to the gateway or connector. */
    token: string;
    machine: () => DecryptedMachine;
    /** Only records whose per-session keys the daemon already possesses. */
    sessions: () => DecryptedSession[];
    localSessionStopped?: (sessionID: string) => boolean;
    control: (input: unknown, grant?: Pick<Connection, 'options' | 'codebuddyLaunch'>) => Promise<unknown>;
};
function sessionProcessID(localMetadata: unknown, relayMetadata: unknown, machineID: string): number | undefined {
    const local = localMetadata as { machineId?: unknown; path?: unknown; hostPid?: unknown; startedBy?: unknown; startedFromDaemon?: unknown } | null;
    const relay = relayMetadata as { machineId?: unknown; path?: unknown } | null;
    if (local?.startedBy === 'daemon' && local.startedFromDaemon === true && local.machineId === machineID
        && relay?.machineId === machineID && typeof local.path === 'string' && local.path === relay.path
        && typeof local.hostPid === 'number' && Number.isSafeInteger(local.hostPid) && local.hostPid > 0) return local.hostPid;
    return undefined;
}
/** Adapter seam for run.ts's machine, tracked/persisted session records and existing control callback. */
export function createDaemonTransport(bindings: DaemonTransportBindings): Transport {
    const records = recordMessageTransport(bindings.serverUrl, bindings.token);
    const http = axios.create({ baseURL: bindings.serverUrl, timeout: 15000, maxRedirects: 0, headers: { Authorization: `Bearer ${bindings.token}` } });
    return {
        ...records,
        machines: async () => [bindings.machine()],
        localSessions: () => bindings.sessions().filter(s => s.encryption.variant === 'dataKey'),
        localSessionStopped: bindings.localSessionStopped,
        sessions: async (cursor, limit = 100) => {
            if (cursor !== undefined && !/^cursor_v1_[A-Za-z0-9_-]+$/.test(cursor)) throw new ControlError('INVALID_CURSOR');
            const { data } = await http.get<{ sessions: RawSession[]; nextCursor: string | null }>('/v2/sessions', { params: { cursor, limit } });
            const known = new Map(bindings.sessions().map(s => [s.id, s]));
            const machineID = bindings.machine().id;
            return { nextCursor: data.nextCursor, sessions: data.sessions.flatMap(raw => {
                const local = known.get(raw.id); if (!local || local.encryption.variant !== 'dataKey') return [];
                const metadata = decryptField(raw.metadata, local.encryption);
                return [{ ...local, active: raw.active, activeAt: raw.activeAt, seq: raw.seq,
                    metadata, daemonProcessID: sessionProcessID(local.metadata, metadata, machineID),
                    agentState: decryptField(raw.agentState, local.encryption) }];
            }) };

        },
        rpc: async (machine, input, grant) => {
            if (machine.id !== bindings.machine().id || input.version !== 1 || !['capabilities', 'create', 'withdraw-create', 'request', 'status', 'cancel', 'options'].includes(String(input.operation))) throw new ControlError('UNSUPPORTED_VERSION');
            const result = await bindings.control(input, grant);
            if (!result || typeof result !== 'object' || !('version' in result) || result.version !== 1) throw new ControlError('UNSUPPORTED_VERSION');
            return result as Record<string, unknown>;
        },
    };
}
