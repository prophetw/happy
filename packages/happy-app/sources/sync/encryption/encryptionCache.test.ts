import { SESSION_MESSAGE_BATCH_BYTES } from '@slopus/happy-wire';
import { expect, it } from 'vitest';
import { EncryptionCache } from './encryptionCache';

it('bounds decrypted message cache weight and keeps the most recently used rows', () => {
    const cache = new EncryptionCache();
    const row = { id: 'one', localId: null, seq: 1, createdAt: 1, content: null };
    const halfPage = SESSION_MESSAGE_BATCH_BYTES / 2;
    cache.setCachedMessage('one', row, halfPage);
    cache.setCachedMessage('two', row, halfPage);
    expect(cache.getCachedMessage('one')).toBe(row);
    cache.setCachedMessage('three', row, halfPage);
    expect(cache.getCachedMessage('two')).toBeNull();
    expect(cache.getCachedMessage('one')).toBe(row);
    cache.setCachedMessage('oversized', row, SESSION_MESSAGE_BATCH_BYTES + 1);
    expect(cache.getCachedMessage('oversized')).toBeNull();
    cache.clearAll();
    cache.setCachedMessage('four', row, SESSION_MESSAGE_BATCH_BYTES);
    expect(cache.getCachedMessage('four')).toBe(row);
});
