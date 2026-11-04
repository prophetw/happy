import type { Session } from './storageTypes';
import type { SessionListViewItem, SessionRowData } from './storage';
import { readTestloopDotsMetadata } from './testloopDots';

/** Dots are hosted conversations, independent of development machines. */
export function testloopDotsKind(session: Pick<Session, 'metadata'>): 'workspace' | 'dot' | null {
    return readTestloopDotsMetadata(session.metadata)?.kind ?? null;
}

export function buildTestloopDotsListItem(
    sessions: readonly Session[],
    toRow: (session: Session) => SessionRowData,
): Extract<SessionListViewItem, { type: 'dots' }> | null {
    const rows = sessions.filter(session => testloopDotsKind(session) !== null).map(toRow);
    if (rows.length === 0) return null;
    rows.sort((left, right) => Number(right.testloopDotsKind === 'workspace') - Number(left.testloopDotsKind === 'workspace')
        || right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id));
    return { type: 'dots', sessions: rows };
}
