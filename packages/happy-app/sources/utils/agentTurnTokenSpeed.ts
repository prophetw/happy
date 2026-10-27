import { assignTurns, type TurnAssignable } from './agentTurns';
import type { GenerationMetrics, TokenSpeedSample } from '@/sync/typesMessage';

type TurnSpeedMessage = TurnAssignable & {
    id: string;
    createdAt: number;
    sortAt?: number;
    text?: string;
    isThinking?: boolean;
};

export type OutputSpeedSample = {
    createdAt: number;
    turn?: string;
    tokensPerSecond?: number;
    /** Tokens and duration that produced the rate, for the explanation modal. */
    sample?: TokenSpeedSample;
    generationMetrics?: GenerationMetrics;
};

/** Rate and its underlying totals assigned to one turn's final visible reply. */
export type TurnSpeedAssignment = {
    tokensPerSecond?: number;
    sample?: TokenSpeedSample;
    generationMetrics?: GenerationMetrics;
};

/** Associates usage snapshots with each turn's last visible reply, never a session-wide rate. */
export function buildAgentTurnTokenSpeedByMessageId(
    messages: readonly TurnSpeedMessage[], // newest-first, in chat order
    samples: readonly OutputSpeedSample[],
): Map<string, TurnSpeedAssignment | undefined> {
    const turns = assignTurns(messages);
    const finalByTurn = new Map<number, string>();
    const finalByTurnId = new Map<string, string>();
    messages.forEach((message, i) => {
        if (message.kind === 'agent-text' && !message.isThinking && message.text?.trim()) {
            if (!finalByTurn.has(turns[i])) finalByTurn.set(turns[i], message.id);
        }
    });
    messages.forEach((message, i) => {
        const final = finalByTurn.get(turns[i]);
        if (message.turn !== undefined && final) finalByTurnId.set(message.turn, final);
    });

    // Older CLIs emit usage without turn ids, including after turn-end. Join
    // those snapshots to the preceding chat row, then to that row's turn.
    // Pending/rejected sends never interrupt an agent's running turn.
    const timeline = messages.map((message, i) => ({ message, turn: turns[i] }))
        .filter(({ message }) => !(message.kind === 'user-text' && (message.pending || message.sendError !== undefined)))
        .reverse()
        .sort((a, b) => (a.message.sortAt ?? a.message.createdAt) - (b.message.sortAt ?? b.message.createdAt));
    const result = new Map<string, TurnSpeedAssignment | undefined>();
    let row = -1;
    for (const sample of [...samples].sort((a, b) => a.createdAt - b.createdAt)) {
        while (row + 1 < timeline.length
            && (timeline[row + 1].message.sortAt ?? timeline[row + 1].message.createdAt) <= sample.createdAt) {
            row++;
        }
        const preceding = timeline[row];
        const final = sample.turn !== undefined
            ? finalByTurnId.get(sample.turn)
            : preceding && preceding.message.kind !== 'user-text'
                ? finalByTurn.get(preceding.turn)
                : undefined;
        const speed = sample.tokensPerSecond;
        const valid = typeof speed === 'number' && Number.isFinite(speed) && speed > 0;
        if (final) result.set(final, valid || sample.generationMetrics
            ? {
                ...(valid ? { tokensPerSecond: speed, ...(sample.sample ? { sample: sample.sample } : {}) } : {}),
                ...(sample.generationMetrics ? { generationMetrics: sample.generationMetrics } : {}),
            }
            : undefined);
    }
    return result;
}
