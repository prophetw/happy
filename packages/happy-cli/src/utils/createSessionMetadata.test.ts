import { execSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import { createSessionMetadata, happyTaskMetadataFromEnvironment } from './createSessionMetadata';

vi.mock('node:child_process', () => ({
    execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

function createSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/Developer',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('createSessionMetadata', () => {
    beforeEach(() => {
        mockedExecSync.mockReset();
        mockedExecSync.mockReturnValue('main\n');
    });

    it('sets metadata.sandbox to the config when enabled', () => {
        const sandbox = createSandboxConfig();
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sandbox,
        });

        expect(metadata.sandbox).toEqual(sandbox);
    });

    it('sets metadata.sandbox to null when sandbox is disabled', () => {
        const sandbox = createSandboxConfig({ enabled: false });
        const { metadata } = createSessionMetadata({
            flavor: 'gemini',
            machineId: 'machine-2',
            startedBy: 'daemon',
            sandbox,
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.sandbox to null when sandbox is not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-3',
        });

        expect(metadata.sandbox).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions to null when not provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-4',
        });

        expect(metadata.dangerouslySkipPermissions).toBeNull();
    });

    it('sets metadata.dangerouslySkipPermissions when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-5',
            dangerouslySkipPermissions: true,
        });

        expect(metadata.dangerouslySkipPermissions).toBe(true);
    });

    it('sets fork lineage metadata when provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-6',
            parentSessionId: 'happy-source',
            forkedFromMessageId: 'message-2',
        });

        expect(metadata.parentSessionId).toBe('happy-source');
        expect(metadata.forkedFromMessageId).toBe('message-2');
    });

    it('sets metadata.isSideChat when the session is a side chat', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-side',
            parentSessionId: 'happy-parent',
            isSideChat: true,
        });

        expect(metadata.isSideChat).toBe(true);
        expect(metadata.parentSessionId).toBe('happy-parent');
    });

    it('omits metadata.isSideChat for a normal session', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-normal',
        });

        expect(metadata.isSideChat).toBeUndefined();
    });

    it('maps only complete, bounded task environment metadata', () => {
        const environment = { HAPPY_TASK_ID: 'task-a', HAPPY_TASK_ROOT: '/project', HAPPY_TASK_TITLE: ' 可读任务 ' };
        const happyTask = { schemaVersion: 1 as const, taskId: 'task-a', origin: { path: '/project' }, displayTitle: '可读任务' };
        expect(happyTaskMetadataFromEnvironment(environment)).toEqual(happyTask);
        expect(happyTaskMetadataFromEnvironment({ ...environment, HAPPY_TASK_ROOT: 'relative' })).toBeUndefined();
        expect(happyTaskMetadataFromEnvironment({ HAPPY_TASK_ID: 'task-a' })).toBeUndefined();

        vi.stubEnv('HAPPY_TASK_ID', 'task-a'); vi.stubEnv('HAPPY_TASK_ROOT', '/project'); vi.stubEnv('HAPPY_TASK_TITLE', '可读任务');
        try {
            expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-task', startedBy: 'daemon' }).metadata.happyTask).toEqual(happyTask);
            expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-terminal', startedBy: 'terminal' }).metadata.happyTask).toBeUndefined();
            vi.stubEnv('HAPPY_RECONNECT_SESSION_ID', 'session-a');
            expect(createSessionMetadata({ flavor: 'codex', machineId: 'machine-resume', startedBy: 'terminal' }).metadata.happyTask).toEqual(happyTask);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('sets metadata.gitBranch when a git branch is detected', () => {
        mockedExecSync.mockReturnValue('fix/session-status\n');

        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-7',
        });

        expect(metadata.gitBranch).toBe('fix/session-status');
        expect(mockedExecSync).toHaveBeenCalledWith('git rev-parse --abbrev-ref HEAD', expect.objectContaining({
            cwd: process.cwd(),
        }));
    });

    it('omits metadata.gitBranch when git is unavailable or detached', () => {
        mockedExecSync.mockReturnValue('HEAD\n');

        const detached = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-8',
        });

        expect(detached.metadata.gitBranch).toBeUndefined();

        mockedExecSync.mockImplementation(() => {
            throw new Error('not a git repository');
        });

        const unavailable = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-9',
        });

        expect(unavailable.metadata.gitBranch).toBeUndefined();
    });
});
