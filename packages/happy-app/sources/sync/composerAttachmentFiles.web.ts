/**
 * Durable composer images on web (browser and the desktop web view).
 *
 * A web preview is a `blob:` URL whose bytes vanish with the page, and MMKV's
 * web backend is localStorage — far too small for pictures. The Bytes are kept
 * in IndexedDB instead; the preview record stays beside the draft in MMKV, and
 * a fresh object URL is made whenever the composer is restored.
 *
 * Every entry degrades to the old in-memory behavior when IndexedDB is not
 * available (private windows, storage disabled), so a failed write cannot
 * block picking or sending an image.
 */
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

const DATABASE_NAME = 'happy-composer-attachments';
const STORE_NAME = 'files';
const DATABASE_VERSION = 1;
// NUL cannot appear in a session id or an attachment id, so it separates the
// two halves of a key cleanly. The same NUL gives the key range that means
// "everything under this session".
const KEY_SEPARATOR = '\u0000';

let databasePromise: Promise<IDBDatabase | null> | null = null;
const objectUrls = new Map<string, string>();

function openDatabase(): Promise<IDBDatabase | null> {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        } catch {
            resolve(null);
            return;
        }
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
    return databasePromise;
}

function recordKey(sessionId: string, id: string): string {
    return `${sessionId}${KEY_SEPARATOR}${id}`;
}

function sessionKeyPrefix(sessionId: string): string {
    return `${sessionId}${KEY_SEPARATOR}`;
}

function runStoreRequest<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error ?? request.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
    });
}

function releaseObjectUrl(key: string): void {
    const uri = objectUrls.get(key);
    if (!uri) return;
    URL.revokeObjectURL(uri);
    objectUrls.delete(key);
}

async function readBlob(database: IDBDatabase, key: string): Promise<Blob | null> {
    const value = await runStoreRequest<unknown>(database, 'readonly', (store) => store.get(key));
    return value instanceof Blob ? value : null;
}

export function persistComposerAttachment(
    sessionId: string,
    preview: AttachmentPreview,
): Promise<AttachmentPreview> {
    return withComposerAttachmentLock(sessionId, async () => {
        try {
            const response = await fetch(preview.uri);
            if (!response.ok) {
                throw new Error(`Could not read the image (${response.status})`);
            }
            const blob = await response.blob();
            const database = await openDatabase();
            if (!database) return preview;
            await runStoreRequest(database, 'readwrite', (store) => (
                store.put(blob, recordKey(sessionId, preview.id))
            ));
            const entry = storedAttachmentFromPreview(preview);
            const others = loadStoredComposerAttachments(sessionId)
                .filter((stored) => stored.id !== entry.id);
            saveStoredComposerAttachments(sessionId, [...others, entry]);
            return preview;
        } catch (error) {
            console.warn('Failed to persist composer attachment', error);
            return preview;
        }
    });
}

/** The session's stored images, in selection order. Records without bytes are dropped. */
export function loadComposerAttachments(sessionId: string): Promise<AttachmentPreview[]> {
    return withComposerAttachmentLock(sessionId, async () => {
        const stored = loadStoredComposerAttachments(sessionId);
        if (stored.length === 0) return [];
        const database = await openDatabase();
        if (!database) return [];

        const previews: AttachmentPreview[] = [];
        const kept: StoredComposerAttachment[] = [];
        for (const entry of stored) {
            const key = recordKey(sessionId, entry.id);
            try {
                const blob = await readBlob(database, key);
                if (!blob) continue;
                // Reuse the URL if this preview was already restored: React
                // can re-run the restoring effect, and revoking a URL still on
                // screen would blank the thumbnail.
                let uri = objectUrls.get(key);
                if (!uri) {
                    uri = URL.createObjectURL(blob);
                    objectUrls.set(key, uri);
                }
                previews.push(previewFromStored(entry, uri));
                kept.push(entry);
            } catch {
                // Unreadable for any reason: forget it rather than show a broken thumbnail.
            }
        }
        if (kept.length !== stored.length) saveStoredComposerAttachments(sessionId, kept);
        return previews;
    });
}

export function forgetComposerAttachment(sessionId: string, id: string): Promise<void> {
    return withComposerAttachmentLock(sessionId, async () => {
        const stored = loadStoredComposerAttachments(sessionId);
        if (!stored.some((entry) => entry.id === id)) return;
        saveStoredComposerAttachments(sessionId, stored.filter((entry) => entry.id !== id));
        const key = recordKey(sessionId, id);
        releaseObjectUrl(key);
        const database = await openDatabase();
        if (!database) return;
        try {
            await runStoreRequest(database, 'readwrite', (store) => store.delete(key));
        } catch (error) {
            console.warn('Failed to delete composer attachment', error);
        }
    });
}

/** Removes everything stored for one session; used when its draft is sent or the session dies. */
export function forgetComposerAttachments(sessionId: string): Promise<void> {
    return withComposerAttachmentLock(sessionId, async () => {
        deleteStoredComposerAttachments(sessionId);
        const prefix = sessionKeyPrefix(sessionId);
        for (const key of [...objectUrls.keys()]) {
            if (key.startsWith(prefix)) releaseObjectUrl(key);
        }
        const database = await openDatabase();
        if (!database) return;
        try {
            await new Promise<void>((resolve, reject) => {
                const transaction = database.transaction(STORE_NAME, 'readwrite');
                transaction.objectStore(STORE_NAME).delete(
                    IDBKeyRange.bound(prefix, `${prefix}￿`),
                );
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted'));
            });
        } catch (error) {
            console.warn('Failed to delete composer attachments for a session', error);
        }
    });
}

/** Sign-out: MMKV is cleared by the caller, the Blobs are cleared here. */
export async function clearAllComposerAttachments(): Promise<void> {
    for (const sessionId of listStoredComposerAttachmentScopes()) {
        deleteStoredComposerAttachments(sessionId);
    }
    for (const key of [...objectUrls.keys()]) {
        releaseObjectUrl(key);
    }
    const database = await openDatabase();
    if (!database) return;
    try {
        await runStoreRequest(database, 'readwrite', (store) => store.clear());
    } catch (error) {
        console.warn('Failed to clear composer attachments', error);
    }
}