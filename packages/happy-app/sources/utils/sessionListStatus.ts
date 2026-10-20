import type { SessionState } from '@/sync/sessionState';

export type SessionAttentionStatus = 'running' | 'completed' | 'permission_required' | 'input_required';

/** Running and blocked work take precedence over results from an earlier turn. */
export function getSessionAttentionStatus(state: SessionState, hasUnread: boolean): SessionAttentionStatus | null {
    if (state === 'permission_required' || state === 'input_required') return state;
    if (state === 'thinking') return 'running';
    return hasUnread ? 'completed' : null;
}

export const SESSION_ATTENTION_COLORS: Record<SessionAttentionStatus, string> = {
    running: '#007AFF',
    completed: '#34C759',
    permission_required: '#FF9500',
    input_required: '#FF9500',
};
