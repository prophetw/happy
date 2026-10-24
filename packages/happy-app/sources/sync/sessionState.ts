import { selectPendingCommunications } from './agentCommunications';
import type { AgentState } from './storageTypes';

export type SessionState =
    | 'disconnected'
    | 'thinking'
    | 'waiting'
    | 'permission_required'
    | 'intervention_required'
    | 'input_required';

/**
 * One precedence order for every place that presents session state.
 *
 * A pending local OS action takes precedence until explicitly handled.
 * Permission requests win over questions because they block the tool before it
 * can run. Blocking questions come next. Asynchronous questions remain
 * answerable while the agent continues its work, and require input once idle.
 */
export function resolveSessionState({
    agentState,
    thinking,
    isOnline,
}: {
    agentState: AgentState | null | undefined;
    thinking: boolean;
    isOnline: boolean;
}): SessionState {
    if (!isOnline) return 'disconnected';

    if (agentState?.humanIntervention) return 'intervention_required';

    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
        return 'permission_required';
    }

    const communications = selectPendingCommunications(agentState ?? null);
    if (communications.some(communication => !thinking || communication.isBlocking !== false)) {
        return 'input_required';
    }

    return thinking ? 'thinking' : 'waiting';
}
