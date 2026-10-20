import { describe, expect, it, vi } from 'vitest';
import { listNativeCodexSessions } from './codexListNativeSessions';
import { wrapHappySystem } from '@/utils/happySystemBlock';

describe('listNativeCodexSessions', () => {
    it('lists native and Happy conversations newest first with recognizable previews', async () => {
        const client = {
            listThreads: vi.fn().mockResolvedValue({
                data: [
                    { id: 'older', cwd: '/project/a', preview: ' Fix the parser ', name: ' Parser bug ', createdAt: 10, updatedAt: 20, gitInfo: { branch: 'fix/parser' } },
                    { id: 'newer', cwd: '/project/b', preview: 'Build a dashboard', createdAt: 15, updatedAt: 30 },
                ],
                nextCursor: 'more',
            }),
        };

        expect(await listNativeCodexSessions(client)).toEqual([
            { sessionId: 'newer', cwd: '/project/b', gitBranch: null, firstUserMessage: 'Build a dashboard', summary: null, timestamp: 30_000 },
            { sessionId: 'older', cwd: '/project/a', gitBranch: 'fix/parser', firstUserMessage: 'Fix the parser', summary: 'Parser bug', timestamp: 20_000 },
        ]);
        expect(client.listThreads).toHaveBeenCalledWith({
            limit: 100,
            sortKey: 'updated_at',
            sourceKinds: ['cli', 'vscode', 'appServer'],
            archived: false,
        });
    });

    it('scopes the listing to the requested directory and excludes unresumable records', async () => {
        const client = {
            listThreads: vi.fn().mockResolvedValue({
                data: [
                    { id: 'temporary', cwd: '/project', preview: 'temp', createdAt: 10, updatedAt: 20, ephemeral: true },
                    { id: 'no-cwd', preview: 'missing path', createdAt: 10, updatedAt: 20 },
                    { id: 'blank-cwd', cwd: ' ', preview: 'blank path', createdAt: 10, updatedAt: 20 },
                    { id: 'image-only', cwd: '/project', preview: '', name: ' ', createdAt: 10 },
                ],
                nextCursor: null,
            }),
        };

        expect(await listNativeCodexSessions(client, '/project')).toEqual([
            { sessionId: 'image-only', cwd: '/project', gitBranch: null, firstUserMessage: null, summary: null, timestamp: 10_000 },
        ]);
        expect(client.listThreads).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/project' }));
    });

    it.each(['before', 'after'])('removes Happy instructions %s the user message from native previews', async (position) => {
        const userMessage = '修复登录超时\n\n保留现有登录方式';
        const instructions = wrapHappySystem('# Options\n\n' + 'Choose an option. '.repeat(100));
        const preview = position === 'before'
            ? `${instructions}\n\n${userMessage}`
            : `${userMessage}\n\n${instructions}`;
        const client = {
            listThreads: vi.fn().mockResolvedValue({
                data: [{
                    id: 'happy-thread', cwd: '/project', createdAt: 10, updatedAt: 20,
                    preview: `${preview}\n\n${wrapHappySystem('Change the chat title.')}`,
                }],
                nextCursor: null,
            }),
        };

        expect(await listNativeCodexSessions(client)).toEqual([
            { sessionId: 'happy-thread', cwd: '/project', gitBranch: null, firstUserMessage: userMessage, summary: null, timestamp: 20_000 },
        ]);
    });

    it('returns no preview for instruction-only messages', async () => {
        const client = {
            listThreads: vi.fn().mockResolvedValue({
                data: [{
                    id: 'image-only', cwd: '/project', createdAt: 10, updatedAt: 20,
                    preview: wrapHappySystem('Choose an option.'),
                }],
                nextCursor: null,
            }),
        };

        expect(await listNativeCodexSessions(client)).toEqual([
            { sessionId: 'image-only', cwd: '/project', gitBranch: null, firstUserMessage: null, summary: null, timestamp: 20_000 },
        ]);
    });

    it('propagates backend failures instead of reporting an empty list', async () => {
        const client = { listThreads: vi.fn().mockRejectedValue(new Error('unsupported thread/list')) };
        await expect(listNativeCodexSessions(client)).rejects.toThrow('unsupported thread/list');
    });
});
