/**
 * Happy system instruction blocks
 *
 * Happy wraps its own injected instructions (option-chips system prompt,
 * change-title instruction) in these sentinel markers inside a user turn.
 * Agents still read the instructions normally, but the markers let the
 * protocol mappers strip this scaffolding back out when a conversation is
 * reconstructed from a provider thread (fork / duplicate / side-chat
 * backfill) — otherwise the raw instructions would leak into the chat as if
 * the user had typed them. See `stripHappySystemBlocks`.
 *
 * Shared by the Codex prompt builder and the generic ACP runner (dsh,
 * OpenCode); exported from codexPrompt.ts for historical import paths.
 */

export const HAPPY_SYSTEM_BLOCK_OPEN = '<happy-system>';
export const HAPPY_SYSTEM_BLOCK_CLOSE = '</happy-system>';

export function wrapHappySystem(text: string): string {
    return `${HAPPY_SYSTEM_BLOCK_OPEN}\n${text}\n${HAPPY_SYSTEM_BLOCK_CLOSE}`;
}

/**
 * Remove any `<happy-system>…</happy-system>` blocks (and the blank lines that
 * join them to the user's text) from a turn string, leaving only what the
 * user actually wrote. Safe to call on text that has no markers.
 */
export function stripHappySystemBlocks(text: string): string {
    const open = HAPPY_SYSTEM_BLOCK_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const close = HAPPY_SYSTEM_BLOCK_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, 'g');
    return text.replace(re, '\n\n').trim();
}
