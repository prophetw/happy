import { HOSTED_STATE_MAX_BYTES, hostedProducerIdentity, savePrivate, type HostedState } from './hostedDotState';

/** Private writer. A failed revocation must fail-stop, never leave live stale authority. */
export function createHostedAuthorityPublisher(file: string, state: HostedState,
    producer: ReturnType<typeof hostedProducerIdentity>, write = savePrivate): () => void {
    let revision = state.authority && JSON.stringify(state.authority.producer) === JSON.stringify(producer) ? state.authority.revision : 0;
    const boundedWrite = () => {
        // Include additive authority metadata and actual UTF-8 bytes. Never replace
        // the last readable recovery journal with an oversized snapshot.
        if (Buffer.byteLength(JSON.stringify(state), 'utf8') > HOSTED_STATE_MAX_BYTES)
            throw new Error('hosted_authority_state_too_large');
        write(file, state);
    };
    return () => {
        try {
            if (!Number.isSafeInteger(revision + 1)) throw new Error('hosted_authority_revision_exhausted');
            state.authority = { version: 1, producer, revision: ++revision };
            boundedWrite();
        } catch (error) {
            state.status = 'blocked'; state.error = 'hosted_event_persistence_failed';
            // Preserve the recovery journal, while revoking its authorization.
            try { boundedWrite(); } catch { process.exit(1); }
            throw error;
        }
    };
}
