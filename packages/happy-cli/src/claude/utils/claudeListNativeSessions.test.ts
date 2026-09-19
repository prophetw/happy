import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listNativeClaudeSessions } from './claudeListNativeSessions';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect the directory-scoped listing into the test dir.
vi.mock('./path', () => ({
    getProjectPath: (path: string) => path
}));

function userLine(text: string, extra: Record<string, unknown> = {}) {
    return JSON.stringify({
        uuid: `uuid-${Math.random().toString(36).slice(2)}`,
        type: 'user',
        cwd: '/repo/app',
        gitBranch: 'main',
        timestamp: '2025-06-01T10:00:00.000Z',
        message: { role: 'user', content: text },
        ...extra,
    });
}

describe('listNativeClaudeSessions', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = join(tmpdir(), `test-native-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it('extracts preview fields from a session file', async () => {
        const sessionId = '12345678-1234-1234-1234-123456789abc';
        writeFileSync(
            join(testDir, `${sessionId}.jsonl`),
            [
                JSON.stringify({ type: 'summary', summary: 'Listing directory files', cwd: '/repo/app', gitBranch: 'main' }),
                userLine('list files in this directory'),
                JSON.stringify({ type: 'assistant', cwd: '/repo/app', message: { role: 'assistant', content: 'ok' } }),
            ].join('\n') + '\n'
        );

        const result = await listNativeClaudeSessions(testDir);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            sessionId,
            cwd: '/repo/app',
            gitBranch: 'main',
            firstUserMessage: 'list files in this directory',
            summary: 'Listing directory files',
        });
        expect(result[0].timestamp).toBeGreaterThan(0);
    });

    it('skips files without a user prompt and non-UUID files', async () => {
        const emptyId = '11111111-1111-1111-1111-111111111111';
        writeFileSync(join(testDir, `${emptyId}.jsonl`), JSON.stringify({ type: 'assistant' }) + '\n');
        writeFileSync(join(testDir, 'agent-abc.jsonl'), userLine('agent prompt') + '\n');

        expect(await listNativeClaudeSessions(testDir)).toEqual([]);
    });

    it('skips sidechain and tool_result user entries when picking the preview', async () => {
        const sessionId = '22222222-2222-2222-2222-222222222222';
        writeFileSync(
            join(testDir, `${sessionId}.jsonl`),
            [
                userLine('sidechain draft', { isSidechain: true }),
                JSON.stringify({
                    uuid: 'tool-result-1', type: 'user', cwd: '/repo/app',
                    message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] },
                }),
                userLine('the real first prompt'),
            ].join('\n') + '\n'
        );

        const result = await listNativeClaudeSessions(testDir);
        expect(result).toHaveLength(1);
        expect(result[0].firstUserMessage).toBe('the real first prompt');
    });

    it('sorts by mtime descending and caps at 100 sessions', async () => {
        for (let i = 0; i < 105; i++) {
            const sessionId = `${String(i).padStart(8, '0')}-3333-3333-3333-333333333333`;
            const file = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(file, userLine(`prompt ${i}`) + '\n');
            const time = new Date(2025, 0, 1 + i);
            utimesSync(file, time, time);
        }

        const result = await listNativeClaudeSessions(testDir);
        expect(result).toHaveLength(100);
        expect(result[0].sessionId).toBe('00000104-3333-3333-3333-333333333333');
    });

    describe('cross-project listing', () => {
        let projectsRoot: string;
        const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

        beforeEach(() => {
            projectsRoot = join(tmpdir(), `test-projects-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            mkdirSync(projectsRoot, { recursive: true });
            process.env.CLAUDE_CONFIG_DIR = join(projectsRoot, 'claude-config');
            mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
            mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true });
        });

        afterEach(() => {
            if (originalConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
            }
            if (existsSync(projectsRoot)) {
                rmSync(projectsRoot, { recursive: true, force: true });
            }
        });

        it('lists sessions from every project directory when no directory is given', async () => {
            const projectA = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-repo-a');
            const projectB = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', '-repo-b');
            mkdirSync(projectA, { recursive: true });
            mkdirSync(projectB, { recursive: true });

            const idA = 'aaaaaaaa-1111-1111-1111-111111111111';
            const idB = 'bbbbbbbb-2222-2222-2222-222222222222';
            writeFileSync(join(projectA, `${idA}.jsonl`), userLine('prompt in repo A') + '\n');
            writeFileSync(join(projectB, `${idB}.jsonl`), userLine('prompt in repo B', { cwd: '/repo/b' }) + '\n');

            const result = await listNativeClaudeSessions();
            expect(result.map((s) => s.sessionId).sort()).toEqual([idA, idB].sort());
        });

        it('returns an empty list when the projects root does not exist', async () => {
            rmSync(join(process.env.CLAUDE_CONFIG_DIR!, 'projects'), { recursive: true, force: true });
            expect(await listNativeClaudeSessions()).toEqual([]);
        });
    });
});
