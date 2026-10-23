import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveAgySummariesDbPath,
  readAgyConversationTitle,
  scheduleAgyTitleSync,
} from './conversationSummary';

// Use require because @types/node in the repo does not yet include node:sqlite declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');

describe('conversationSummary', () => {
  let tmpDir: string;
  let testDbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-summary-test-'));
    testDbPath = path.join(tmpDir, 'conversation_summaries.db');

    const db = new DatabaseSync(testDbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        last_modified_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const insert = db.prepare(
      'INSERT INTO conversation_summaries (conversation_id, title, preview) VALUES (?, ?, ?)',
    );
    insert.run('cid-greeting', 'Friendly Greeting', '你好');
    insert.run('cid-chinese', '五言绝句创作', '请写一首五言绝句');
    insert.run('cid-empty-title', '   ', 'some preview');
    db.close();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HAPPY_AGY_SUMMARIES_DB;
  });

  describe('resolveAgySummariesDbPath', () => {
    it('returns customPath if it exists', () => {
      expect(resolveAgySummariesDbPath(testDbPath)).toBe(testDbPath);
    });

    it('returns env path when HAPPY_AGY_SUMMARIES_DB exists', () => {
      process.env.HAPPY_AGY_SUMMARIES_DB = testDbPath;
      expect(resolveAgySummariesDbPath()).toBe(testDbPath);
    });

    it('returns null if customPath does not exist', () => {
      const nonExistent = path.join(tmpDir, 'missing.db');
      expect(resolveAgySummariesDbPath(nonExistent)).toBeNull();
    });

    it('returns null if default candidates do not exist and customPath is omitted', () => {
      const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
      expect(resolveAgySummariesDbPath()).toBeNull();
      homedirSpy.mockRestore();
    });
  });

  describe('readAgyConversationTitle', () => {
    it('reads model-generated titles correctly', () => {
      expect(readAgyConversationTitle('cid-greeting', { dbPath: testDbPath })).toBe(
        'Friendly Greeting',
      );
      expect(readAgyConversationTitle('cid-chinese', { dbPath: testDbPath })).toBe('五言绝句创作');
    });

    it('returns null for unknown conversationId', () => {
      expect(readAgyConversationTitle('cid-non-existent', { dbPath: testDbPath })).toBeNull();
    });

    it('returns null if title is blank or whitespace', () => {
      expect(readAgyConversationTitle('cid-empty-title', { dbPath: testDbPath })).toBeNull();
    });

    it('returns null safely if database does not exist', () => {
      const badPath = path.join(tmpDir, 'does-not-exist.db');
      expect(readAgyConversationTitle('cid-greeting', { dbPath: badPath })).toBeNull();
    });

    it('returns null if conversationId is invalid', () => {
      expect(readAgyConversationTitle('', { dbPath: testDbPath })).toBeNull();
    });
  });

  describe('scheduleAgyTitleSync', () => {
    it('updates metadata and calls onTitleUpdated when new title is found', () => {
      vi.useFakeTimers();

      const updateMetadata = vi.fn();
      const onTitleUpdated = vi.fn();
      let currentTitle = '你好';

      const cancel = scheduleAgyTitleSync({
        conversationId: 'cid-greeting',
        session: { updateMetadata },
        getCurrentTitle: () => currentTitle,
        onTitleUpdated: (newTitle) => {
          currentTitle = newTitle;
          onTitleUpdated(newTitle);
        },
        delaysMs: [100, 300],
        dbPath: testDbPath,
      });

      expect(updateMetadata).not.toHaveBeenCalled();

      // Advance by first delay (100ms)
      vi.advanceTimersByTime(100);

      expect(updateMetadata).toHaveBeenCalledTimes(1);
      const updater = updateMetadata.mock.calls[0][0];
      const result = updater({ otherProp: 123 });
      expect(result.summary.text).toBe('Friendly Greeting');
      expect(typeof result.summary.updatedAt).toBe('number');
      expect(onTitleUpdated).toHaveBeenCalledWith('Friendly Greeting');

      // Subsequent timer (300ms) should not trigger again because it was cleaned up
      vi.advanceTimersByTime(300);
      expect(updateMetadata).toHaveBeenCalledTimes(1);

      cancel();
    });

    it('does not update metadata if title is already identical to current', () => {
      vi.useFakeTimers();

      const updateMetadata = vi.fn();

      scheduleAgyTitleSync({
        conversationId: 'cid-greeting',
        session: { updateMetadata },
        getCurrentTitle: () => 'Friendly Greeting', // Already up to date
        delaysMs: [100],
        dbPath: testDbPath,
      });

      vi.advanceTimersByTime(100);
      expect(updateMetadata).not.toHaveBeenCalled();
    });

    it('cancels pending timers when cancel() is called before delay', () => {
      vi.useFakeTimers();

      const updateMetadata = vi.fn();

      const cancel = scheduleAgyTitleSync({
        conversationId: 'cid-greeting',
        session: { updateMetadata },
        getCurrentTitle: () => '你好',
        delaysMs: [200],
        dbPath: testDbPath,
      });

      cancel();
      vi.advanceTimersByTime(500);

      expect(updateMetadata).not.toHaveBeenCalled();
    });
  });
});
