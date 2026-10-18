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
}): Promise<void> {
    const serverUrl = normalizeServerUrl(options.serverUrl);
    const token = await options.authenticate(serverUrl);
    const call = async (participant: RelaySwitchParticipant, phase: RelaySwitchRequest['phase']) => {
        const result = await participant.call({ id: options.id, phase, serverUrl, token });
        if (!result?.success) throw new Error(`${participant.name}: ${result?.error || 'Relay switch is not supported'}`);
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
        try {
            await phase('rollback');
        } catch {
            throw new Error('Relay switch failed; some devices could not confirm rollback. Keep the original relay available.');
        }
        throw error;
    }
}
