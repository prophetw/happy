import axios from 'axios';
import { decryptField, type RawSession } from '../../api';
import type { DecryptedMachine, DecryptedSession } from '../../api';
import { ControlError, recordMessageTransport, type Transport } from '../relay';

export type DaemonTransportBindings = {
    serverUrl: string;
    /** Existing in-process daemon identity. Never sent to the gateway or connector. */
    token: string;
    machine: () => DecryptedMachine;
    /** Only records whose per-session keys the daemon already possesses. */
    sessions: () => DecryptedSession[];
    control: (input: unknown) => Promise<unknown>;
};
/** Adapter seam for run.ts's machine, tracked/persisted session records and existing control callback. */
export function createDaemonTransport(bindings: DaemonTransportBindings): Transport {
    const records = recordMessageTransport(bindings.serverUrl, bindings.token);
    const http = axios.create({ baseURL: bindings.serverUrl, timeout: 15000, maxRedirects: 0, headers: { Authorization: `Bearer ${bindings.token}` } });
    return {
        ...records,
        machines: async () => [bindings.machine()],
        sessions: async (cursor, limit = 100) => {
            if (cursor !== undefined && !/^cursor_v1_[A-Za-z0-9_-]+$/.test(cursor)) throw new ControlError('INVALID_CURSOR');
            const { data } = await http.get<{ sessions: RawSession[]; nextCursor: string | null }>('/v2/sessions', { params: { cursor, limit } });
            const known = new Map(bindings.sessions().map(s => [s.id, s]));
            return { nextCursor: data.nextCursor, sessions: data.sessions.flatMap(raw => {
                const local = known.get(raw.id); if (!local || local.encryption.variant !== 'dataKey') return [];
                return [{ ...local, active: raw.active, activeAt: raw.activeAt, seq: raw.seq,
                    metadata: decryptField(raw.metadata, local.encryption), agentState: decryptField(raw.agentState, local.encryption) }];
            }) };

        },
        rpc: async (machine, input) => {
            if (machine.id !== bindings.machine().id || input.version !== 1 || !['capabilities', 'create', 'request', 'status', 'cancel'].includes(String(input.operation))) throw new ControlError('UNSUPPORTED_VERSION');
            const result = await bindings.control(input);
            if (!result || typeof result !== 'object' || !('version' in result) || result.version !== 1) throw new ControlError('UNSUPPORTED_VERSION');
            return result as Record<string, unknown>;
        },
    };
}
