import type { AgentState, Metadata } from './types';

export type AttentionVisibility = 'normal' | 'persistent' | 'hidden';

export function sessionAttentionVisibility(metadata: (Metadata & { client?: { id?: string }; testloopDots?: unknown }) | null | undefined): AttentionVisibility {
    if (metadata?.isSideChat || metadata?.lifecycleState === 'archived') return 'hidden';
    return metadata?.client?.id === 'rig' || metadata?.testloopDots ? 'persistent' : 'normal';
}

export function pendingAttentionKind(state: AgentState | null): 'permission' | 'question' | null {
    if (Object.keys(state?.requests ?? {}).length) return 'permission';
    return Object.keys(state?.communications ?? {}).some(id => !state?.completedCommunications?.[id]) ? 'question' : null;
}
