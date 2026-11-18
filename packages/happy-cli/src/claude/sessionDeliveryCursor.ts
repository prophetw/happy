import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

/**
 * Last app message handed to Claude's input stream. This is deliberately
 * separate from the Relay receive cursor: a received prompt may still be
 * pending in Happy's queue and must be routed again after a process restart.
 */
function cursorPath(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        throw new Error('Invalid Happy session ID for Claude delivery cursor');
    }
    return join(configuration.happyHomeDir, 'session-delivery-cursors', `${sessionId}.json`);
}

function writeCursor(sessionId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('Invalid Claude delivery cursor');
    }
    const file = cursorPath(sessionId);
    mkdirSync(join(configuration.happyHomeDir, 'session-delivery-cursors'), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify({ seq }), { mode: 0o600 });
        renameSync(temporary, file);
    } finally {
        rmSync(temporary, { force: true });
    }
}

/** Null means a legacy/unknown session, whose history must not be replayed. */
export function readSessionDeliveryCursor(sessionId: string): number | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(cursorPath(sessionId), 'utf8'));
        const seq = (parsed as { seq?: unknown })?.seq;
        if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
            throw new Error('Invalid Claude delivery cursor');
        }
        return seq as number;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug('[Claude] Unable to read session delivery cursor; using legacy resume policy', error);
        }
        return null;
    }
}

export function ensureSessionDeliveryCursor(sessionId: string): number {
    const existing = readSessionDeliveryCursor(sessionId);
    if (existing !== null) return existing;
    writeCursor(sessionId, 0);
    return 0;
}

export function recordSessionDeliveryCursor(sessionId: string, seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('Invalid Claude delivery cursor');
    }
    const existing = readSessionDeliveryCursor(sessionId);
    if (existing !== null && existing >= seq) return;
    writeCursor(sessionId, seq);
}
