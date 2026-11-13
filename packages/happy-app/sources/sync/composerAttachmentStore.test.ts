import { beforeEach, describe, expect, it, vi } from 'vitest';

// react-native-mmkv needs a native/web backend; back it with a plain in-memory map.
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return disk.get(key); }
        set(key: string, value: string) { disk.set(key, value); }
        delete(key: string) { disk.delete(key); }
        getAllKeys() { return [...disk.keys()]; }
    },
}));

import {
    loadStoredComposerAttachments,
    mergeComposerAttachmentPreviews,
    previewFromStored,
    saveStoredComposerAttachments,
    storedAttachmentFromPreview,
} from './composerAttachmentStore';
import type { AttachmentPreview } from './attachmentTypes';

const preview: AttachmentPreview = {
    id: 'image-1',
    uri: 'blob:https://happy.example/1234',
    width: 1200,
    height: 800,
    mimeType: 'image/png',
    size: 1_234,
    name: 'pasted.png',
    thumbhash: 'hash',
};

beforeEach(() => disk.clear());

describe('composer attachment records', () => {
    it('round-trips a preview without its temporary URI', () => {
        saveStoredComposerAttachments('session-1', [storedAttachmentFromPreview(preview)]);

        const [stored] = loadStoredComposerAttachments('session-1');
        expect(stored).toEqual({
            id: 'image-1',
            name: 'pasted.png',
            mimeType: 'image/png',
            size: 1_234,
            width: 1200,
            height: 800,
            thumbhash: 'hash',
        });
        expect(previewFromStored(stored, 'file:///documents/image-1.png')).toEqual({
            ...preview,
            uri: 'file:///documents/image-1.png',
        });
    });

    it('keeps each session strip separate', () => {
        saveStoredComposerAttachments('session-1', [storedAttachmentFromPreview(preview)]);
        saveStoredComposerAttachments('session-2', [
            storedAttachmentFromPreview({ ...preview, id: 'image-2' }),
        ]);

        expect(loadStoredComposerAttachments('session-1').map(entry => entry.id)).toEqual(['image-1']);
        expect(loadStoredComposerAttachments('session-2').map(entry => entry.id)).toEqual(['image-2']);
        expect(loadStoredComposerAttachments('session-3')).toEqual([]);
    });

    it('drops an unreadable record instead of failing the whole strip', () => {
        disk.set('composer-attachments:session-1', JSON.stringify([
            { id: 'image-1', name: 'ok.png', mimeType: 'image/png', size: 1, width: 1, height: 1 },
            { id: '', name: 'broken.png', mimeType: 'image/png', size: 1, width: 1, height: 1 },
        ]));

        expect(loadStoredComposerAttachments('session-1')).toEqual([]);
    });

    it('drops corrupt JSON rather than throwing', () => {
        disk.set('composer-attachments:session-1', '{not json');
        expect(loadStoredComposerAttachments('session-1')).toEqual([]);
    });

    it('forgets the key once the last image is gone', () => {
        saveStoredComposerAttachments('session-1', [storedAttachmentFromPreview(preview)]);
        saveStoredComposerAttachments('session-1', []);

        expect(disk.has('composer-attachments:session-1')).toBe(false);
    });
});

describe('mergeComposerAttachmentPreviews', () => {
    it('keeps the picks already on screen first and does not duplicate restored ids', () => {
        const onScreen = [{ ...preview, id: 'current', uri: 'file:///current.png' }];
        const restored = [
            preview,
            { ...preview, id: 'current', uri: 'file:///restored-current.png' },
        ];

        expect(mergeComposerAttachmentPreviews(onScreen, restored)).toEqual([
            onScreen[0],
            preview,
        ]);
    });
});