import type { Session } from './storageTypes';
import { isRigMetadata } from './rig';
import { testloopDotsKind } from './testloopDotsList';

/**
 * A session the agent retired, or a Happy CLI session that has ended. Rig
 * sessions that merely lost their connection are still live work. Hosted
 * Dots do not own a native CLI heartbeat; only explicit archive applies.
 *
 * Archived sessions never sit inside a project card: they trail the list as
 * flat, date-grouped rows, so revealing the archive appends to the bottom
 * instead of reshaping the groups above it.
 *
 * A chat the user is in the middle of archiving counts as archived here. The
 * machine has not agreed yet — that is several round trips away — but the
 * answer is not what the press was about, and nothing else on this screen
 * makes the user wait for one.
 */
export function isSessionArchived(session: Session, archiving: ReadonlySet<string>): boolean {
    return archiving.has(session.id)
        || session.metadata?.lifecycleState === 'archived'
        || (!isRigMetadata(session.metadata) && !testloopDotsKind(session) && !session.active);
}
