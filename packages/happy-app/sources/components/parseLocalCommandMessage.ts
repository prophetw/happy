/**
 * Parses Claude Agent SDK's local-slash-command wrapper messages.
 *
 * When a `/foo` command runs, the SDK injects synthetic user messages whose
 * content is XML-like tags such as:
 *   <local-command-caveat>...</local-command-caveat>
 *   <command-message>foo</command-message><command-name>/foo</command-name>
 *   <command-message>foo</command-message><command-name>/foo</command-name><command-args>the args</command-args>
 *
 * Rendered through markdown unchanged they look like raw HTML in the chat —
 * and because the old parser only stripped <command-message>/<command-name>,
 * any command WITH arguments left a non-empty <command-args> tag behind, so
 * it fell through to plain text instead of collapsing to a chip (looked like
 * the user's message duplicated, and the "command ran" chip never showed).
 *
 * We strip / collapse them into structured intents the renderer can show
 * (or hide) cleanly, carrying the args out separately so the renderer can
 * display them as the user's actual prompt.
 */

export type LocalCommandMessage =
    | { kind: 'caveat' }
    | { kind: 'command-run'; commandName: string; args?: string }
    | { kind: 'goal-run'; goal: string }
    | { kind: 'goal-confirmation'; goal: string }
    | { kind: 'text'; text: string };

const CAVEAT_RE = /^\s*<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*$/;
const STDOUT_RE = /^\s*<local-command-stdout>\s*([\s\S]*?)\s*<\/local-command-stdout>\s*$/;
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<]+?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/;
const COMMAND_MESSAGE_RE = /<command-message>[\s\S]*?<\/command-message>/g;
const COMMAND_NAME_TAG_RE = /<command-name>[\s\S]*?<\/command-name>/g;
const COMMAND_ARGS_TAG_RE = /<command-args>[\s\S]*?<\/command-args>/g;
const RAW_SLASH_COMMAND_TOKEN_RE = /(^|\s)\/([a-zA-Z][\w:-]*)(?=$|\s)/g;
const GOAL_STDOUT_RE = /^Goal set:\s*([\s\S]*?)\s*$/i;

function rawSlashCommand(text: string, commands: readonly string[]): { commandName: string; args?: string } | undefined {
    // Syntax alone cannot distinguish a command from a single-segment path.
    // Use the same command names the composer offers for this session.
    const knownCommands = new Set(commands.map(command => command.replace(/^\//, '')));
    for (const match of text.matchAll(RAW_SLASH_COMMAND_TOKEN_RE)) {
        if (!knownCommands.has(match[2])) {
            continue;
        }
        const commandStart = match.index + match[1].length;
        const commandEnd = commandStart + match[2].length + 1;
        const before = text.slice(0, commandStart).trim();
        const after = text.slice(commandEnd).trim();
        const args = [before, after].filter(Boolean).join(' ');
        return {
            commandName: match[2],
            args: args && args.length > 0 ? args : undefined,
        };
    }
    return undefined;
}

function goalFromStdout(text: string): string | undefined {
    const match = text.trim().match(GOAL_STDOUT_RE);
    const goal = match?.[1]?.trim();
    return goal && goal.length > 0 ? goal : undefined;
}

export function parseLocalCommandMessage(text: string, commands: readonly string[] = []): LocalCommandMessage {
    if (CAVEAT_RE.test(text)) {
        return { kind: 'caveat' };
    }

    const stdoutMatch = text.match(STDOUT_RE);
    if (stdoutMatch) {
        const stdout = stdoutMatch[1].trim();
        const goal = goalFromStdout(stdout);
        if (goal) {
            return { kind: 'goal-confirmation', goal };
        }
        return { kind: 'text', text: stdout };
    }

    const nameMatch = text.match(COMMAND_NAME_RE);
    if (nameMatch) {
        const argsMatch = text.match(COMMAND_ARGS_RE);
        const args = argsMatch?.[1].trim();
        const commandName = nameMatch[1].trim();

        // If the message is just the command wrappers (after stripping all of
        // them only whitespace remains), collapse to a chip. The args, if any,
        // are surfaced separately so the renderer can show them as the user's
        // actual prompt rather than as raw XML.
        const stripped = text
            .replace(COMMAND_MESSAGE_RE, '')
            .replace(COMMAND_NAME_TAG_RE, '')
            .replace(COMMAND_ARGS_TAG_RE, '')
            .trim();
        if (stripped.length === 0) {
            if (commandName.toLowerCase() === 'goal' && args && args.length > 0) {
                return {
                    kind: 'goal-run',
                    goal: args,
                };
            }
            return {
                kind: 'command-run',
                commandName,
                args: args && args.length > 0 ? args : undefined,
            };
        }
        // Mixed content: keep the surrounding text, drop the tags.
        return { kind: 'text', text: stripped };
    }

    const rawCommand = rawSlashCommand(text, commands);
    if (rawCommand) {
        if (rawCommand.commandName.toLowerCase() === 'goal' && rawCommand.args) {
            return { kind: 'goal-run', goal: rawCommand.args };
        }
        return {
            kind: 'command-run',
            commandName: rawCommand.commandName,
            args: rawCommand.args,
        };
    }

    return { kind: 'text', text };
}

/**
 * True when this user-text message is the user's OWN echoed slash-command
 * input (e.g. `/superpowers:brainstorming do the thing`) that the Claude
 * Agent SDK will re-emit as a `<command-message>/<command-name>` wrapper.
 *
 * Happy shows the user's sent message optimistically (it carries a
 * `localId`); the SDK then injects the canonical wrapper (no `localId`,
 * rendered as a chip). Showing both looks like a duplicate, so we hide
 * the raw echo and let the wrapper chip stand in — matching how the
 * Claude Code terminal renders slash commands.
 *
 * Gated on `hasLocalId` so we only ever hide a message the user actually
 * sent from Happy, never an agent/SDK-originated one.
 */
export function isUserSlashCommandEcho(text: string, hasLocalId: boolean, commands: readonly string[] = []): boolean {
    // SDK wrappers are authoritative even when their args mention another command.
    if (!hasLocalId || COMMAND_NAME_RE.test(text)) {
        return false;
    }
    const parsed = parseLocalCommandMessage(text, commands);
    return parsed.kind === 'command-run' || parsed.kind === 'goal-run';
}
