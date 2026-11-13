/**
 * What the composer remembers about an image between reloads.
 *
 * The bytes live somewhere platform-specific (a file under `documentDirectory`
 * on iOS and Android, a Blob in IndexedDB on web) and are addressed only by
 * rebuilding a URI in the current platform's store. Kept here is the small
 * preview record beside the session draft in MMKV, plus the per-session lock
 * that keeps a save and a removal from interleaving.
 */
import { MMKV } from 'react-native-mmkv';
import { z } from 'zod';
import { AsyncLock } from '@/utils/lock';
import type { AttachmentPreview } from './attachmentTypes';

const mmkv = new MMKV();
const KEY_PREFIX = 'composer-attachments:';

export const StoredComposerAttachmentSchema = z.object({
    id: z.string().min(1),
    name: z.string(),
    mimeType: z.string(),
    size: z.number().finite().nonnegative(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    thumbhash: z.string().optional(),
});
export type StoredComposerAttachment = z.infer<typeof StoredComposerAttachmentSchema>;

const StoredComposerAttachmentsSchema = z.array(StoredComposerAttachmentSchema);

/** The durable half of a preview: everything except the temporary URI. */
export function storedAttachmentFromPreview(preview: AttachmentPreview): StoredComposerAttachment {
    return {
        id: preview.id,
        name: preview.name,
        mimeType: preview.mimeType,
        size: preview.size,
        width: preview.width,
        height: preview.height,
        ...(preview.thumbhash ? { thumbhash: preview.thumbhash } : {}),
    };
}

/** Rebuilds a preview around whatever URI the platform store hands back. */
export function previewFromStored(entry: StoredComposerAttachment, uri: string): AttachmentPreview {
    return { ...entry, uri };
}

export function loadStoredComposerAttachments(sessionId: string): StoredComposerAttachment[] {
    const raw = mmkv.getString(KEY_PREFIX + sessionId);
    if (!raw) return [];
    try {
        const parsed = StoredComposerAttachmentsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch (error) {
        console.warn('Failed to parse composer attachments', error);
        return [];
    }
}

export function saveStoredComposerAttachments(
    sessionId: string,
    entries: readonly StoredComposerAttachment[],
): void {
    const key = KEY_PREFIX + sessionId;
    if (entries.length === 0) mmkv.delete(key);
    else mmkv.set(key, JSON.stringify(entries));
}

export function deleteStoredComposerAttachments(sessionId: string): void {
    mmkv.delete(KEY_PREFIX + sessionId);
}

export function listStoredComposerAttachmentScopes(): string[] {
    return mmkv.getAllKeys()
        .filter((key) => key.startsWith(KEY_PREFIX))
        .map((key) => key.slice(KEY_PREFIX.length));
}

const locks = new Map<string, AsyncLock>();

export function withComposerAttachmentLock<T>(
    sessionId: string,
    body: () => Promise<T> | T,
): Promise<T> {
    let lock = locks.get(sessionId);
    if (!lock) {
        lock = new AsyncLock();
        locks.set(sessionId, lock);
    }
    return lock.inLock(body);
}

/** Current picks first; restored ones fill in behind them. */
export function mergeComposerAttachmentPreviews(
    current: readonly AttachmentPreview[],
    restored: readonly AttachmentPreview[],
): AttachmentPreview[] {
    const seen = new Set(current.map((preview) => preview.id));
    return [...current, ...restored.filter((preview) => !seen.has(preview.id))];
}