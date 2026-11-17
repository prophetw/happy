import type { Message } from '@/sync/typesMessage';

export const isToolConfirmationCommand = (text: string) =>
    /^确认工具 [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);

/** Presentation only. The host still verifies the preview, input, arguments and expiry. */
export function activeHostedToolConfirmation(messages: readonly Message[], now = Date.now()) {
    // Chat messages are newest first. Any newer user input supersedes a preview.
    for (const message of messages) {
        if (message.kind === 'user-text') return null;
        if (message.kind !== 'agent-text' || message.isThinking
            || message.meta?.sentFrom !== 'testloop-assistant'
            || !message.text.startsWith('工具操作需要确认：')) continue;
        const command = /\n<options>\n<option>([^\n<>]+)<\/option>\n<\/options>$/.exec(message.text)?.[1];
        if (command && isToolConfirmationCommand(command)) {
            // This only retires old UI. Delivery time and the client clock are not
            // authority; the host enforces its original operation.expiresAt.
            const expiresAt = message.createdAt + 10 * 60_000;
            return Number.isFinite(expiresAt) && expiresAt > now ? { messageId: message.id, command, expiresAt } : null;
        }
    }
    return null;
}
