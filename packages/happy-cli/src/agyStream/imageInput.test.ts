import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

vi.mock('@/configuration', () => ({
  configuration: { happyHomeDir: '/home/test/.happy' },
}));

import {
  detectSupportedImageType,
  formatAgyPromptWithAttachments,
  prepareAgyImageAttachments,
  resolveAgyImageCacheDir,
  sanitizeCachePathSegment,
} from './imageInput';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happy-agy-image-input-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('detectSupportedImageType', () => {
  it('detects PNG, JPEG, GIF, and WebP by magic bytes', () => {
    expect(
      detectSupportedImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toEqual({ mimeType: 'image/png', extension: 'png' });

    expect(detectSupportedImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mimeType: 'image/jpeg',
      extension: 'jpg',
    });

    expect(detectSupportedImageType(new TextEncoder().encode('GIF89a123'))).toEqual({
      mimeType: 'image/gif',
      extension: 'gif',
    });

    expect(
      detectSupportedImageType(
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toEqual({ mimeType: 'image/webp', extension: 'webp' });
  });

  it('rejects unsupported or text data', () => {
    expect(detectSupportedImageType(new TextEncoder().encode('plain text content'))).toBeNull();
    expect(detectSupportedImageType(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });
});

describe('resolveAgyImageCacheDir', () => {
  it('sanitizes session ID and builds path within cache root', () => {
    const dir = resolveAgyImageCacheDir({
      sessionId: 'session/../123:abc',
      cacheRootDir: '/tmp/cache',
    });
    expect(dir).toBe('/tmp/cache/session_123_abc');
  });

  it('falls back to invalid-session on traversal escapes', () => {
    const dir = resolveAgyImageCacheDir({
      sessionId: '../../../etc',
      cacheRootDir: '/tmp/cache',
    });
    expect(dir).toBe('/tmp/cache/etc');
  });
});

describe('prepareAgyImageAttachments', () => {
  it('returns empty when attachments list is undefined or empty', async () => {
    await expect(
      prepareAgyImageAttachments(undefined, { sessionId: 'test-session' }),
    ).resolves.toEqual({ savedFiles: [], skipped: 0 });

    await expect(
      prepareAgyImageAttachments([], { sessionId: 'test-session' }),
    ).resolves.toEqual({ savedFiles: [], skipped: 0 });
  });

  it('writes valid image attachments to disk with secure permissions', async () => {
    const cacheRoot = await makeTempDir();
    const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

    const result = await prepareAgyImageAttachments(
      [
        { data: pngData, mimeType: 'image/png', name: 'my-drawing.png' },
      ],
      { sessionId: 'session-xyz', cacheRootDir: cacheRoot },
    );

    expect(result.skipped).toBe(0);
    expect(result.savedFiles.length).toBe(1);
    expect(result.savedFiles[0].name).toBe('my-drawing.png');
    expect(result.savedFiles[0].path.endsWith('.png')).toBe(true);

    const savedBytes = await readFile(result.savedFiles[0].path);
    expect(savedBytes).toEqual(Buffer.from(pngData));

    const fileStat = await stat(result.savedFiles[0].path);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it('skips attachments that are not supported image formats', async () => {
    const cacheRoot = await makeTempDir();
    const txtData = new TextEncoder().encode('not an image');

    const result = await prepareAgyImageAttachments(
      [{ data: txtData, mimeType: 'text/plain', name: 'doc.txt' }],
      { sessionId: 'session-xyz', cacheRootDir: cacheRoot },
    );

    expect(result.skipped).toBe(1);
    expect(result.savedFiles).toEqual([]);
  });
});

describe('formatAgyPromptWithAttachments', () => {
  it('returns original text unchanged when no files attached', () => {
    expect(formatAgyPromptWithAttachments('hello world', [])).toBe('hello world');
  });

  it('formats prompt with inspection instruction when text is empty', () => {
    const formatted = formatAgyPromptWithAttachments('', [
      { path: '/tmp/img1.png', name: 'photo.png' },
    ]);
    expect(formatted).toContain('/tmp/img1.png');
    expect(formatted).toContain('photo.png');
    expect(formatted).toContain('view_file');
  });

  it('appends attachment details to user text when text is non-empty', () => {
    const formatted = formatAgyPromptWithAttachments('What is in this picture?', [
      { path: '/tmp/chart.jpg', name: 'chart.jpg' },
    ]);
    expect(formatted.startsWith('What is in this picture?')).toBe(true);
    expect(formatted).toContain('/tmp/chart.jpg');
    expect(formatted).toContain('view_file');
  });
});
