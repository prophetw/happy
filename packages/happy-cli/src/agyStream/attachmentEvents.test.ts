import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn() },
}));

import { downloadAgyFileEventAttachment } from './attachmentEvents';

function fileEvent(overrides?: Partial<{
  ref: string;
  name: string;
  size: number;
  mimeType: string | null;
}>) {
  return {
    content: {
      data: {
        ev: {
          t: 'file',
          ref: overrides?.ref ?? 'attachment-ref-123',
          name: overrides?.name ?? 'screenshot.png',
          size: overrides?.size ?? 1024,
          mimeType: overrides && 'mimeType' in overrides ? overrides.mimeType : 'image/png',
        },
      },
    },
  } as any;
}

describe('downloadAgyFileEventAttachment', () => {
  it('downloads and decrypts valid file event attachment', async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const session = {
      downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
    };

    await expect(downloadAgyFileEventAttachment(session, fileEvent())).resolves.toEqual({
      data,
      mimeType: 'image/png',
      name: 'screenshot.png',
    });
    expect(session.downloadAndDecryptAttachment).toHaveBeenCalledWith('attachment-ref-123');
  });

  it('defaults missing MIME type to image/jpeg', async () => {
    const data = new Uint8Array([5, 6, 7]);
    const session = {
      downloadAndDecryptAttachment: vi.fn().mockResolvedValue(data),
    };

    await expect(downloadAgyFileEventAttachment(session, fileEvent({ mimeType: null }))).resolves.toEqual({
      data,
      mimeType: 'image/jpeg',
      name: 'screenshot.png',
    });
  });

  it('returns null when decryption returns null', async () => {
    const session = {
      downloadAndDecryptAttachment: vi.fn().mockResolvedValue(null),
    };

    await expect(downloadAgyFileEventAttachment(session, fileEvent())).resolves.toBeNull();
  });

  it('returns null and logs when download throws', async () => {
    const session = {
      downloadAndDecryptAttachment: vi.fn().mockRejectedValue(new Error('Network error')),
    };

    await expect(downloadAgyFileEventAttachment(session, fileEvent())).resolves.toBeNull();
  });

  it('returns null on malformed file event lacking data.ev', async () => {
    const session = {
      downloadAndDecryptAttachment: vi.fn(),
    };

    await expect(downloadAgyFileEventAttachment(session, { content: {} } as any)).resolves.toBeNull();
    expect(session.downloadAndDecryptAttachment).not.toHaveBeenCalled();
  });
});
