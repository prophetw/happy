/**
 * Agy Conversation Summary & Title Synchronization
 *
 * Antigravity CLI (agy) maintains an internal summary store that summarizes
 * conversation turns using an LLM in the background. It stores these titles in
 * the local SQLite database at `~/.gemini/antigravity-cli/conversation_summaries.db`.
 *
 * This module provides safe, read-only utilities to retrieve the model-generated
 * conversation title from that database and synchronize it to Happy's session metadata,
 * replacing static input-based titles (e.g. greetings like "你好") with real summaries.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let DatabaseSyncClass: any = null;
let sqliteLoadAttempted = false;

function getDatabaseSync(): any {
  if (!sqliteLoadAttempted) {
    sqliteLoadAttempted = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqlite = require('node:sqlite');
      DatabaseSyncClass = sqlite.DatabaseSync ?? null;
    } catch {
      DatabaseSyncClass = null;
    }
  }
  return DatabaseSyncClass;
}

/**
 * Resolves the path to Antigravity's conversation_summaries.db database.
 */
export function resolveAgySummariesDbPath(customPath?: string): string | null {
  if (customPath !== undefined) {
    return fs.existsSync(customPath) ? customPath : null;
  }

  const envPath = process.env.HAPPY_AGY_SUMMARIES_DB;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const homedir = os.homedir();
  const candidates = [
    path.join(homedir, '.gemini', 'antigravity-cli', 'conversation_summaries.db'),
    path.join(homedir, '.config', 'gemini', 'conversation_summaries.db'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export interface ReadAgyConversationTitleOptions {
  dbPath?: string;
  log?: (msg: string) => void;
}

/**
 * Safely reads the model-generated title for a given agy conversation ID.
 * Returns null if not found, database unavailable, or on error.
 */
export function readAgyConversationTitle(
  conversationId: string,
  options?: ReadAgyConversationTitleOptions,
): string | null {
  if (!conversationId || typeof conversationId !== 'string') {
    return null;
  }

  const dbPath = resolveAgySummariesDbPath(options?.dbPath);
  if (!dbPath) {
    return null;
  }

  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) {
    options?.log?.('node:sqlite DatabaseSync unavailable; skipping agy title query');
    return null;
  }

  let db: any = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare('SELECT title FROM conversation_summaries WHERE conversation_id = ?');
    const row = stmt.get(conversationId) as { title?: unknown } | undefined;
    if (row && typeof row.title === 'string') {
      const trimmed = row.title.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  } catch (error) {
    options?.log?.(
      `Failed to read agy conversation title from DB: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors on read-only handles
    }
  }
}

export interface ScheduleAgyTitleSyncOptions {
  conversationId: string;
  session: {
    updateMetadata: (updater: (currentMetadata: any) => any) => void;
  };
  getCurrentTitle?: () => string | undefined;
  onTitleUpdated?: (newTitle: string) => void;
  log?: (msg: string) => void;
  delaysMs?: readonly number[];
  dbPath?: string;
}

export const DEFAULT_SYNC_DELAYS_MS: readonly number[] = [1000, 3000, 6000];

/**
 * Schedules deferred polling attempts to synchronize the model-generated title
 * from Antigravity's summary store after a turn finishes.
 * Returns a cancel function to abort pending timers.
 */
export function scheduleAgyTitleSync(options: ScheduleAgyTitleSyncOptions): () => void {
  const {
    conversationId,
    session,
    getCurrentTitle,
    onTitleUpdated,
    log,
    delaysMs = DEFAULT_SYNC_DELAYS_MS,
    dbPath,
  } = options;

  let cancelled = false;
  const timerHandles: NodeJS.Timeout[] = [];

  const cleanup = () => {
    cancelled = true;
    for (const handle of timerHandles) {
      clearTimeout(handle);
    }
    timerHandles.length = 0;
  };

  for (const delay of delaysMs) {
    const timer = setTimeout(() => {
      if (cancelled) return;

      const title = readAgyConversationTitle(conversationId, { dbPath, log });
      if (!title || cancelled) return;

      const current = getCurrentTitle?.();
      if (title !== current) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          summary: {
            text: title,
            updatedAt: Date.now(),
          },
        }));
        onTitleUpdated?.(title);
        log?.(`Updated session title from agy DB: "${title}"`);
        cleanup();
      }
    }, delay);

    timerHandles.push(timer);
  }

  return cleanup;
}
