import type { Session } from './storageTypes';
import { resolveSessionState } from './sessionState';
import { isRigMetadata } from './rig';
import { isWebTabActive } from './webTabTitle';

function workState(session: Session) {
    return resolveSessionState({ agentState: session.agentState, thinking: session.thinking, isOnline: session.presence === 'online' });
}

/** Disconnects and unanswered blocking questions are not completed turns. */
export function didSessionCompleteTurn(previous: Session, next: Session): boolean {
    const before = workState(previous);
    return (before === 'thinking' || before === 'permission_required' || before === 'input_required')
        && workState(next) === 'waiting';
}

export function selectCompletedSessionIds(state: {
    sessions: Record<string, Session>;
    unreadSessionIds: ReadonlySet<string>;
    archivingSessionIds: ReadonlySet<string>;
    currentViewingSessionId: string | null;
}): string[] {
    return [...state.unreadSessionIds].reverse().filter(id => {
        const session = state.sessions[id];
        if (session?.attentionKind && session.attentionKind !== 'done') return false;
        if (!session || (id === state.currentViewingSessionId && isWebTabActive()) || state.archivingSessionIds.has(id)
            || session.metadata?.isSideChat || session.metadata?.lifecycleState === 'archived'
            || (!session.active && !isRigMetadata(session.metadata))) return false;
        // A completed result remains available if the agent disconnects afterwards.
        return resolveSessionState({ agentState: session.agentState, thinking: session.thinking, isOnline: true }) === 'waiting';
    });
}
