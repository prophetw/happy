import type { PermissionMode } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import { hashObject } from '@/utils/deterministicJson';
// The sentinel-block helpers moved to utils/happySystemBlock.ts so the
// generic ACP runner can wrap its injected instructions the same way; they
// stay re-exported for their existing importers (sessionProtocolMapper
// imports stripHappySystemBlocks from here).
export { HAPPY_SYSTEM_BLOCK_OPEN, HAPPY_SYSTEM_BLOCK_CLOSE, stripHappySystemBlocks } from '@/utils/happySystemBlock';
import { wrapHappySystem } from '@/utils/happySystemBlock';

import type { ReasoningEffort } from './codexAppServerTypes';

export interface CodexEnhancedMode {
    permissionMode: PermissionMode;
    model?: string;
    /** Happy app instructions appended to the first Codex prompt for option chips. */
    appendSystemPrompt?: string;
    /** Reasoning effort passed through to Codex's sendTurnAndWait. */
    effort?: ReasoningEffort;
}

export function hashCodexEnhancedMode(mode: CodexEnhancedMode): string {
    return hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        appendSystemPrompt: mode.appendSystemPrompt,
        effort: mode.effort,
    });
}

export function buildCodexTurnPrompt(opts: {
    message: string;
    mode: Pick<CodexEnhancedMode, 'appendSystemPrompt'>;
    includeAppendSystemPrompt: boolean;
    includeTitleInstruction: boolean;
}): string {
    const parts: string[] = [];

    if (opts.includeAppendSystemPrompt && opts.mode.appendSystemPrompt) {
        parts.push(wrapHappySystem(opts.mode.appendSystemPrompt));
    }

    parts.push(opts.message);

    if (opts.includeTitleInstruction) {
        parts.push(wrapHappySystem(CHANGE_TITLE_INSTRUCTION));
    }

    return parts.join('\n\n');
}

