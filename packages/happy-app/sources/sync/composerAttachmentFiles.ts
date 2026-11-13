/**
 * Durable composer images on iOS and Android.
 *
 * The picker (and a clipboard paste) leaves its preview in a cache directory
 * that the system may empty at any time, so each image is copied into the
 * app's document directory while it waits in the composer. The copy is deleted
 * when the image is removed or sent; a deleted session takes its directory
 * with it.
 */
import {
    copyAsync,
    deleteAsync,
    documentDirectory,
    getInfoAsync,
    makeDirectoryAsync,
} from 'expo-file-system/legacy';
import type { AttachmentPreview } from './attachmentTypes';
import {
    deleteStoredComposerAttachments,
    listStoredComposerAttachmentScopes,
    loadStoredComposerAttachments,
    previewFromStored,
    saveStoredComposerAttachments,
    storedAttachmentFromPreview,
    withComposerAttachmentLock,
    type StoredComposerAttachment,
} from './composerAttachmentStore';

const ROOT_DIRECTORY = 'composer-attachments';

function safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function directoryFor(sessionId: string): string | null {
    return documentDirectory
        ? `${documentDirectory}${ROOT_DIRECTORY}/${safeSegment(sessionId)}/`
        : null;
}

function extensionFor(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case 'image/jpeg': return '.jpg';
        case 'image/png': return '.png';
        case 'image/webp': return '.webp';
        case 'image/gif': return '.gif';
        case 'image/heic':
        case 'image/heif': return '.heic';
        default: return '.img';
    }
}

function fileNameFor(entry: StoredComposerAttachment): string {
    return `${safeSegment(entry.id)}${extensionFor(entry.mimeType)}`;
}

/**
 * Copies one preview into its session's directory. The returned preview points
 * at the copy, so a later send reads the durable file rather than a cache path
 * the system is free to reclaim. A failed copy leaves the preview untouched —
 * it can still be sent while it lives, it just will not survive a restart.
 */
export function persistComposerAttachment(
    sessionId: string,
    preview: AttachmentPreview,
): Promise<AttachmentPreview> {
    const directory = directoryFor(sessionId);
    if (!directory) return Promise.resolve(preview);
    const entry = storedAttachmentFromPreview(preview);
    const target = `${directory}${fileNameFor(entry)}`;

    return withComposerAttachmentLock(sessionId, async () => {
        try {
            await makeDirectoryAsync(directory, { intermediates: true });
            if (preview.uri !== target) {
                await copyAsync({ from: preview.uri, to: target });
            }
            const others = loadStoredComposerAttachments(sessionId)
                .filter((stored) => stored.id !== entry.id);
            saveStoredComposerAttachments(sessionId, [...others, entry]);
            return { ...preview, uri: target };
        } catch (error) {
            console.warn('Failed to persist composer attachment', error);
            return preview;
        }
    });
}

/** The session's stored images, in selection order. Records whose file is gone are dropped. */
export function loadComposerAttachments(sessionId: string): Promise<AttachmentPreview[]> {
    const directory = directoryFor(sessionId);
    if (!directory) return Promise.resolve([]);

    return withComposerAttachmentLock(sessionId, async () => {
        const stored = loadStoredComposerAttachments(sessionId);
        const previews: AttachmentPreview[] = [];
        const kept: StoredComposerAttachment[] = [];
        for (const entry of stored) {
            const uri = `${directory}${fileNameFor(entry)}`;
            try {
                const info = await getInfoAsync(uri);
                if (info.exists && !info.isDirectory) {
                    previews.push(previewFromStored(entry, uri));
                    kept.push(entry);
                }
            } catch {
                // Unreadable for any reason: forget it rather than show a broken thumbnail.
            }
        }
        if (kept.length !== stored.length) saveStoredComposerAttachments(sessionId, kept);
        return previews;
    });
}

export function forgetComposerAttachment(sessionId: string, id: string): Promise<void> {
    const directory = directoryFor(sessionId);
    if (!directory) return Promise.resolve();

    return withComposerAttachmentLock(sessionId, async () => {
        const stored = loadStoredComposerAttachments(sessionId);
        const removed = stored.find((entry) => entry.id === id);
        if (!removed) return;
        saveStoredComposerAttachments(sessionId, stored.filter((entry) => entry.id !== id));
        try {
            await deleteAsync(`${directory}${fileNameFor(removed)}`, { idempotent: true });
        } catch (error) {
            console.warn('Failed to delete composer attachment', error);
        }
    });
}

/** Removes everything stored for one session; used when its draft is sent or the session dies. */
export function forgetComposerAttachments(sessionId: string): Promise<void> {
    const directory = directoryFor(sessionId);
    return withComposerAttachmentLock(sessionId, async () => {
        deleteStoredComposerAttachments(sessionId);
        if (!directory) return;
        try {
            await deleteAsync(directory, { idempotent: true });
        } catch (error) {
            console.warn('Failed to delete composer attachments for a session', error);
        }
    });
}

/** Sign-out: MMKV is cleared by the caller, the files are cleared here. */
export function clearAllComposerAttachments(): Promise<void> {
    for (const sessionId of listStoredComposerAttachmentScopes()) {
        deleteStoredComposerAttachments(sessionId);
    }
    if (!documentDirectory) return Promise.resolve();
    return deleteAsync(`${documentDirectory}${ROOT_DIRECTORY}`, { idempotent: true })
        .catch((error) => {
            console.warn('Failed to clear composer attachments', error);
        });
}