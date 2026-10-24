import type { Session } from './storageTypes';
import { getSessionName } from '@/utils/sessionUtils';

/** Reading a session does not resolve the OS action it is waiting for. */
export function selectHumanInterventions(state: { sessions: Record<string, Session>; archivingSessionIds: ReadonlySet<string> }) {
    return Object.values(state.sessions).flatMap(session => {
        const request = session.agentState?.humanIntervention;
        if (!request || session.metadata?.isSideChat || session.metadata?.lifecycleState === 'archived'
            || state.archivingSessionIds.has(session.id)) return [];
        return [{ ...request, sessionId: session.id, name: getSessionName(session), host: session.metadata?.host,
            online: session.presence === 'online' }];
    }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
