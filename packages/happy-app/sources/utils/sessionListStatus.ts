import type { SessionState } from '@/sync/sessionState';

export type SessionAttentionStatus = 'running' | 'completed' | 'permission_required' | 'input_required' | 'failed' | 'intervention_required';

/** Running and blocked work take precedence over results from an earlier turn. */
export function getSessionAttentionStatus(state: SessionState, hasUnread: boolean, kind?: 'done' | 'permission' | 'question' | 'failed' | 'intervention'): SessionAttentionStatus | null {
    if (state === 'permission_required' || state === 'input_required' || state === 'intervention_required') return state;
    if (state === 'thinking') return 'running';
    if (hasUnread && kind === 'failed') return 'failed';
    if (hasUnread && kind === 'permission') return 'permission_required';
    if (hasUnread && kind === 'question') return 'input_required';
    // A resolved request must not reappear just because its push remains unread.
    if (kind === 'intervention') return null;
    return hasUnread ? 'completed' : null;
}

export const SESSION_ATTENTION_COLORS: Record<SessionAttentionStatus, string> = {
    running: '#007AFF',
    completed: '#34C759',
    permission_required: '#FF9500',
    input_required: '#FF9500',
    intervention_required: '#FF9500',
    failed: '#FF453A',
};
