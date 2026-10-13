import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export type AgyAttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>;

export async function downloadAgyFileEventAttachment(
  session: AgyAttachmentDownloader,
  fileEvent: FileEventMessage,
): Promise<PendingAttachment | null> {
  const ev = fileEvent.content.data?.ev;
  if (!ev) {
    logger.debug('[agy] Skipping malformed file event (missing ev)');
    return null;
  }
  try {
    const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
    if (!decrypted) {
      logger.debug(`[agy] Failed to decrypt attachment: ${ev.name}`);
      return null;
    }
    logger.debug(`[agy] Attachment decrypted: ${ev.name} (${decrypted.length} bytes)`);
    return {
      data: decrypted,
      mimeType: ev.mimeType ?? 'image/jpeg',
      name: ev.name,
    };
  } catch (error) {
    logger.debug(`[agy] Failed to download attachment: ${ev.name}`, {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}
