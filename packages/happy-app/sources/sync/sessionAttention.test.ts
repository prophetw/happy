import { describe, expect, it, vi } from 'vitest';
import { decodeAttentionItem, encodeAttentionValue, mergeAttentionRecord, readAttentionRecord, type SessionAttentionRecord } from './sessionAttention';

const record = (patch: Partial<SessionAttentionRecord> = {}): SessionAttentionRecord => ({ kind: 'done', eventId: 'done:1:1', seq: 1, at: 10, read: false, version: 0, ...patch });

describe('attention event reconciliation', () => {
    it('synchronizes only event metadata and strips local retry fields from the wire value', () => {
        const value = encodeAttentionValue(record({ pendingRead: true }));
        expect(decodeAttentionItem({ key: 'session-attention-v1:s', value, version: 2 })).toEqual(['s', record({ version: 2 })]);
        expect(decodeAttentionItem({ key: 'unrelated', value, version: 1 })).toBeNull();
    });
    it('keeps an offline read while retrying the same event but exposes a newer completion', () => {
        const read = readAttentionRecord(record());
        expect(mergeAttentionRecord(read, record({ version: 1 }))).toMatchObject({ read: true, pendingRead: true, version: 1 });
        expect(mergeAttentionRecord(read, record({ version: 2, eventId: 'done:2:1', seq: 2 }))).toMatchObject({ read: false, eventId: 'done:2:1' });
        expect(mergeAttentionRecord(record({ version: 3 }), record({ version: 2, read: true }))).toMatchObject({ version: 3, read: false });
    });
    it('retains an offline failure until published without hiding the next turn', () => {
        const pending = record({ kind: 'failed', eventId: 'failed:1', pendingEvent: true });
        expect(mergeAttentionRecord(pending, record({ version: 1 }))).toMatchObject({ kind: 'failed', pendingEvent: true, version: 1 });
        expect(mergeAttentionRecord(pending, record({ seq: 2, eventId: 'done:2:1', version: 2 }))).toMatchObject({ kind: 'done', read: false });
    });
    it('does not let an older turn with a newer KV version replace a newer result', () => {
        expect(mergeAttentionRecord(record({ seq: 7, eventId: 'done:7:1' }), record({ kind: 'failed', seq: 3, eventId: 'failed:3', version: 1 })))
            .toMatchObject({ kind: 'done', seq: 7, version: 1, pendingEvent: true });
    });
    it('rejects malformed optional metadata without replacing valid session state', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(decodeAttentionItem({ key: 'session-attention-v1:s', value: 'invalid', version: 0 })).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
});
