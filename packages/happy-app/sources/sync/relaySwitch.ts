import type { RelaySwitchRequest, RelaySwitchResult } from '@slopus/happy-wire';
import { normalizeServerUrl } from '@slopus/happy-wire/serverUrl';

export interface RelaySwitchParticipant {
    name: string;
    call: (request: RelaySwitchRequest) => Promise<RelaySwitchResult>;
}

/** Keep the old connection until all devices have confirmed the new one. */
export async function switchRelay(options: {
    id: string;
    serverUrl: string;
    participants: RelaySwitchParticipant[];
    authenticate: (serverUrl: string) => Promise<string>;
    save: (serverUrl: string, token: string) => Promise<void>;
    messages?: { unavailable: string; rollbackUnconfirmed: string; keepOriginal: string };
}): Promise<void> {
    const serverUrl = normalizeServerUrl(options.serverUrl);
    const token = await options.authenticate(serverUrl);
    const rollbackParticipants = new Set<RelaySwitchParticipant>();
    const call = async (participant: RelaySwitchParticipant, phase: RelaySwitchRequest['phase']) => {
        if (phase === 'prepare') rollbackParticipants.add(participant);
        try {
            const result = await participant.call({ id: options.id, phase, serverUrl, token });
            if (!result?.success) {
                // An explicit prepare rejection never installed a transaction.
                // A missing/malformed acknowledgement remains uncertain.
                if (phase === 'prepare' && (typeof result?.error === 'string' || result?.success === false)) {
                    rollbackParticipants.delete(participant);
                }
                throw new Error(result?.error || 'Relay switch is not supported');
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : 'Relay switch failed';
            const unavailable = /^(RPC method not available|RPC method not found|Method not found)$/.test(reason);
            // These responses mean the request was never dispatched to a
            // prepare handler. In particular, an old CLI cannot roll it back.
            if (phase === 'prepare' && unavailable) rollbackParticipants.delete(participant);
            const hint = unavailable
                ? `${options.messages?.unavailable || 'Relay switching is unavailable. Check this device is online, update its CLI/daemon, and reopen older sessions.'} (${reason})`
                : reason;
            throw new Error(`${participant.name}: ${hint}`);
        }
    };
    const phase = async (name: RelaySwitchRequest['phase']) => {
        const results = await Promise.allSettled(options.participants.map(participant => call(participant, name)));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
    };
    try {
        await phase('prepare');
        await phase('commit');
        await phase('finish');
        await options.save(serverUrl, token);
    } catch (error) {
        const participants = [...rollbackParticipants];
        const results = await Promise.allSettled(participants.map(participant => call(participant, 'rollback')));
        const unconfirmed = participants.filter((_, index) => results[index].status === 'rejected');
        if (unconfirmed.length > 0) {
            const reason = error instanceof Error ? error.message : 'Relay switch failed';
            throw new Error([
                reason,
                `${options.messages?.rollbackUnconfirmed || 'Rollback could not be confirmed for'}: ${unconfirmed.map(participant => participant.name).join(', ')}.`,
                options.messages?.keepOriginal || 'Keep the original relay available.',
            ].join('\n'));
        }
        throw error;
    }
}
