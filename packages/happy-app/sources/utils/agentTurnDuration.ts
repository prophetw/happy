export type TurnDurationMessage = {
    id: string;
    kind: string;
    createdAt: number;
    text?: string;
    isThinking?: boolean;
};

/**
 * Calculates total turn/task duration for each completed assistant turn and attaches
 * it to that turn's final text block message ID.
 *
 * Messages array is newest-first.
 * Turn start time is the initiating user message's createdAt (or the oldest message in the turn).
 * Turn completion time is the final agent-text message's createdAt.
 */
export function buildAgentTurnDurationByMessageId(
    messages: readonly TurnDurationMessage[],
    options: { currentTurnComplete: boolean },
): Map<string, number> {
    const messagesByTurn = new Map<number, TurnDurationMessage[]>();
    let turn = 0;

    for (const message of messages) {
        const turnMessages = messagesByTurn.get(turn) ?? [];
        turnMessages.push(message);
        messagesByTurn.set(turn, turnMessages);

        if (message.kind === 'user-text') {
            turn++;
        }
    }

    const result = new Map<string, number>();
    for (const [turnNumber, turnMessagesNewestFirst] of messagesByTurn) {
        if (turnNumber === 0 && !options.currentTurnComplete) {
            continue;
        }

        // Find the user message in this turn
        const userMessage = turnMessagesNewestFirst.find((m) => m.kind === 'user-text');

        // Find visible agent-text messages in this turn (newest first)
        const agentTextMessages = turnMessagesNewestFirst.filter(
            (m) => m.kind === 'agent-text' && !m.isThinking && m.text?.trim(),
        );

        if (agentTextMessages.length === 0) {
            continue;
        }

        const finalAgentMessage = agentTextMessages[0]; // Newest agent text in this turn

        // Turn start time is the user message's createdAt, or the oldest message in the turn
        const oldestMessageInTurn = turnMessagesNewestFirst[turnMessagesNewestFirst.length - 1];
        const startedAt = userMessage ? userMessage.createdAt : oldestMessageInTurn.createdAt;
        const completedAt = finalAgentMessage.createdAt;

        // If there is no user message and completedAt === startedAt, we don't display duration
        if (!userMessage && completedAt <= startedAt) {
            continue;
        }

        const durationMs = Math.max(0, completedAt - startedAt);
        result.set(finalAgentMessage.id, durationMs);
    }

    return result;
}
