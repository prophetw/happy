/**
 * Enumerate the host machine's native Claude Code conversations so the app
 * can offer a `claude --resume <uuid>` picker that reaches beyond Happy's
 * own session history — including conversations that never went through
 * Happy (typed directly in a terminal on the host).
 *
 * Sessions live in $CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl.
 * Each list row carries just enough to recognize the conversation: the
 * summary line (present in resumed files), the first user-typed prompt,
 * cwd, git branch, and last-activity time (the JSONL file mtime).
 */

import { createReadStream } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProjectPath } from './path';
import { logger } from '@/ui/logger';

export type NativeClaudeSession = {
    /** Claude session UUID — passed to `claude --resume <uuid>`. */
    sessionId: string;
    /** Working directory the conversation belongs to (from JSONL rows). */
    cwd: string;
    gitBranch: string | null;
    /** First user-typed prompt — the recognizable preview. */
    firstUserMessage: string | null;
    /** `summary` line Claude Code writes at the top of resumed files. */
    summary: string | null;
    /** Last activity — JSONL file mtime. */
    timestamp: number;
};

// --resume only accepts UUID-named sessions (agent-* are excluded).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The first user prompt always lands within the first lines (resumed files
// replay history right after the summary line), so a bounded scan is enough
// and keeps cross-project listings cheap.
const MAX_SCAN_LINES_PER_FILE = 200;
const MAX_SESSIONS = 100;

function getProjectsRoot(): string {
    return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

function listProjectDirs(directory: string | undefined): string[] {
    if (directory) {
        return [getProjectPath(directory)];
    }
    try {
        return readdirSync(getProjectsRoot(), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(getProjectsRoot(), entry.name));
    } catch {
        return [];
    }
}

/**
 * True for non-sidechain user-typed prompts — string content, top-level
 * conversation. Tool_result follow-ups (also `type: 'user'` but with array
 * content) and sidechain entries don't count.
 */
function isUserPrompt(parsed: any): boolean {
    if (!parsed || parsed.type !== 'user') return false;
    if (parsed.isSidechain) return false;
    const content = parsed.message?.content;
    return typeof content === 'string' && content.trim().length > 0;
}

async function scanSessionFile(path: string, sessionId: string): Promise<NativeClaudeSession | null> {
    const readStream = createReadStream(path, { encoding: 'utf-8' });
    const rl = createInterface({ input: readStream, crlfDelay: Infinity });

    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let firstUserMessage: string | null = null;
    let summary: string | null = null;

    try {
        let scanned = 0;
        for await (const line of rl) {
            if (++scanned > MAX_SCAN_LINES_PER_FILE) break;
            if (line.length === 0) continue;
            let parsed: any = null;
            try { parsed = JSON.parse(line); } catch { continue; }

            if (!cwd && typeof parsed.cwd === 'string') cwd = parsed.cwd;
            if (!gitBranch && typeof parsed.gitBranch === 'string' && parsed.gitBranch.length > 0) gitBranch = parsed.gitBranch;
            if (!summary && parsed.type === 'summary' && typeof parsed.summary === 'string') summary = parsed.summary;
            if (!firstUserMessage && isUserPrompt(parsed)) firstUserMessage = parsed.message.content.trim();

            if (firstUserMessage && cwd && gitBranch && summary) break;
        }
    } finally {
        rl.close();
        readStream.destroy();
    }

    // Without a user prompt there is nothing meaningful to resume into the
    // picker, and nothing to show as a preview. Without cwd the app cannot
    // spawn a session in the right directory — the project-dir slug is
    // lossy, so it cannot be reconstructed backwards.
    if (!firstUserMessage || !cwd) return null;

    const timestamp = statSync(path).mtime.getTime();
    return {
        sessionId,
        cwd,
        gitBranch,
        firstUserMessage,
        summary,
        timestamp,
    };
}

/**
 * List native Claude sessions, newest activity first. Pass `directory` to
 * scope the listing to one project (Claude Code's own /resume semantics);
 * omit it to list every project on the machine. Results are capped at
 * MAX_SESSIONS to keep the RPC payload bounded.
 */
export async function listNativeClaudeSessions(directory?: string): Promise<NativeClaudeSession[]> {
    const sessions: NativeClaudeSession[] = [];

    for (const projectDir of listProjectDirs(directory)) {
        let files: string[];
        try {
            files = readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
        } catch {
            continue;
        }

        for (const file of files) {
            const sessionId = file.replace('.jsonl', '');
            if (!UUID_PATTERN.test(sessionId)) continue;
            try {
                const session = await scanSessionFile(join(projectDir, file), sessionId);
                if (session) sessions.push(session);
            } catch (error) {
                logger.debug(`[claudeListNativeSessions] Failed to scan ${file}:`, error);
            }
        }
    }

    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions.slice(0, MAX_SESSIONS);
}
