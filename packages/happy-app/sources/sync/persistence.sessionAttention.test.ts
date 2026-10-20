import { beforeEach, expect, it, vi } from 'vitest';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return disk.get(key); }
    set(key: string, value: string) { disk.set(key, value); }
} }));
import { loadSessionAttention, saveSessionAttention } from './persistence';
beforeEach(() => disk.clear());

it('restores unread and pending offline receipts without leaking across accounts or servers', () => {
    const records = { a: { kind: 'done' as const, eventId: 'done:1', at: 10, read: true, version: 0, pendingRead: true } };
    saveSessionAttention('server-a|account-a', records, new Set(['b']));
    expect(loadSessionAttention('server-a|account-a')).toEqual({ records, unread: ['b'] });
    expect(loadSessionAttention('server-a|account-b')).toEqual({ records: {}, unread: [] });
    expect(loadSessionAttention('server-b|account-a')).toEqual({ records: {}, unread: [] });
});
