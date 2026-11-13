import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

vi.mock('@/text', () => ({ t: (key: string) => key }));

import { getSessionName } from './sessionUtils';

function session(metadata: Record<string, unknown>): Session {
    return { metadata } as unknown as Session;
}

describe('getSessionName Happy Task fallback', () => {
    it('keeps an explicit summary ahead of the initial task title', () => {
        expect(getSessionName(session({
            happyTask: { schemaVersion: 1, taskId: 'a', origin: { path: '/repo' }, displayTitle: '初始标题' },
            summary: { text: '重命名后的任务', updatedAt: 1 },
        }))).toBe('重命名后的任务');
    });

    it('uses the task title before falling back to a new chat', () => {
        expect(getSessionName(session({
            happyTask: { schemaVersion: 1, taskId: 'a', origin: { path: '/repo' }, displayTitle: '可读任务' },
        }))).toBe('可读任务');
        expect(getSessionName(session({}))).toBe('session.newChat');
    });
});
