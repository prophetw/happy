import type { Session } from './storageTypes';
import type { SessionAttentionRecords } from './sessionAttention';
import { resolveSessionState } from './sessionState';
import { getSessionAttentionStatus, type SessionAttentionStatus } from '@/utils/sessionListStatus';
import { getSessionName } from '@/utils/sessionUtils';
import { isRigMetadata } from './rig';

export interface MobileAttentionItem {
    id: string;
    name: string;
    status: Exclude<SessionAttentionStatus, 'running'>;
    eventId: string;
    at: number;
    errorCode?: string;
}

export function selectMobileSessionAttention(state: {
    sessions: Record<string, Session>; unreadSessionIds: ReadonlySet<string>;
    sessionAttention: SessionAttentionRecords; archivingSessionIds: ReadonlySet<string>;
    currentViewingSessionId: string | null; appIsActive: boolean;
}): MobileAttentionItem[] {
    const items: MobileAttentionItem[] = [];
    for (const session of Object.values(state.sessions)) {
        if (session.metadata?.isSideChat || session.metadata?.lifecycleState === 'archived'
            || state.archivingSessionIds.has(session.id) || (!session.active && !isRigMetadata(session.metadata))
            || (state.appIsActive && state.currentViewingSessionId === session.id)) continue;
        const record = state.sessionAttention[session.id];
        const status = getSessionAttentionStatus(resolveSessionState({ agentState: session.agentState, thinking: session.thinking, isOnline: true }), state.unreadSessionIds.has(session.id), session.attentionKind ?? record?.kind);
        if (!status || status === 'running') continue;
        items.push({ id: session.id, name: getSessionName(session), status, eventId: record?.eventId ?? `${session.id}:${status}`, at: record?.at ?? session.updatedAt,
            ...(status === 'failed' ? { errorCode: session.lastTurnErrorCode ?? record?.errorCode } : {}) });
    }
    return items.sort((a, b) => Number(a.status === 'completed') - Number(b.status === 'completed') || b.at - a.at);
}
