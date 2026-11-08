import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (globalThis as any).expo = { EventEmitter: class {} };
    (globalThis as any).__DEV__ = false;
});
const actionMocks = vi.hoisted(() => ({
    handlers: [] as Array<() => Promise<void>>,
    markArchiving: vi.fn(), unmarkArchiving: vi.fn(), sessionArchive: vi.fn(), sessionKill: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (obj: any) => obj.ios ?? obj.default },
    StyleSheet: { create: (obj: any) => obj },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
    getStringAsync: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-1' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        default: actual,
        useState: <T,>(value: T) => [value, vi.fn()] as const,
        useRef: <T,>(value: T) => ({ current: value }),
        useCallback: <T,>(callback: T) => callback,
        useMemo: <T,>(factory: () => T) => factory(),
        useEffect: (effect: () => void | (() => void)) => { effect(); },
    };
});

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (fn: any) => fn },
    useUnistyles: () => ({ theme: { colors: {} } }),
}));

vi.mock('@/components/AnimatedOverlay', () => ({
    AnimatedBlurBackdrop: () => null,
    AnimatedOverlay: () => null,
}));

vi.mock('@/components/MobileGlass', () => ({
    MobileGlass: () => null,
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn() },
}));

vi.mock('@/sync/storage', () => ({
    useMachine: () => null,
    useSetting: () => true,
    useLocalSetting: () => false,
    storage: { getState: () => ({ settings: {}, sessions: {}, markArchiving: actionMocks.markArchiving,
        unmarkArchiving: actionMocks.unmarkArchiving }) },
}));

vi.mock('@/sync/ops', () => ({
    machineResumeSession: vi.fn(),
    sessionArchive: actionMocks.sessionArchive,
    sessionKill: actionMocks.sessionKill,
    sessionSetAgentModes: vi.fn(),
    forkAndSpawn: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

vi.mock('@/sync/agentDefaults', () => ({
    resolveMessageModeMeta: () => ({}),
    CLI_VERSION_WITH_AUTO: '1.2.1-beta.2',
}));

vi.mock('@/hooks/useHappyAction', () => ({
    useHappyAction: (fn: () => Promise<void>) => {
        actionMocks.handlers.push(fn);
        return [false, fn];
    },
}));

vi.mock('@/hooks/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/machineUtils', () => ({
    isMachineOnline: (machine: { active?: boolean } | null | undefined) => machine?.active ?? false,
}));

vi.mock('@/utils/sessionUtils', () => ({
    isRigMetadata: () => false,
    useSessionStatus: () => ({ isConnected: false }),
}));

vi.mock('@/utils/sessionMetadata', () => ({
    copySessionMetadataAndLogsToClipboard: vi.fn(),
    copySessionMetadataToClipboard: vi.fn(),
}));

vi.mock('@/utils/worktree', () => ({
    maybeCleanupWorktree: vi.fn(),
}));

vi.mock('@/utils/sessionFork', () => ({
    getSessionForkSource: () => null,
}));

import { getResumeAvailability, useSessionQuickActions } from './useSessionQuickActions';
import type { Machine, Session } from '@/sync/storageTypes';

function createMockSession(metadata: Partial<NonNullable<Session['metadata']>> = {}): Session {
    return {
        id: 'session-123',
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: false,
        archived: false,
        metadata: {
            path: '/home/dev/project',
            machineId: 'machine-1',
            ...metadata,
        },
    } as unknown as Session;
}

function createMockMachine(active = true): Machine {
    return {
        id: 'machine-1',
        active,
        metadata: {
            resumeSupport: { rpcAvailable: true },
        },
    } as unknown as Machine;
}

beforeEach(() => {
    actionMocks.handlers.length = 0;
    actionMocks.markArchiving.mockClear();
    actionMocks.unmarkArchiving.mockClear();
    actionMocks.sessionArchive.mockReset();
    actionMocks.sessionKill.mockReset();
});

describe('getResumeAvailability', () => {
    it('routes a hosted Dot through host recovery instead of ordinary CLI resume', () => {
        const session = createMockSession({ flavor: 'codex', codexThreadId: 'thread-12345', testloopDots: {
            schemaVersion: 1, kind: 'dot', workspaceId: '11111111-1111-4111-8111-111111111111',
            workspaceSessionId: 'workspace', dotId: '22222222-2222-4222-8222-222222222222',
        } } as any);
        expect(getResumeAvailability(session, createMockMachine(true), false).canShowResume).toBe(false);
    });
    it('returns canResume: true for agy sessions with agyConversationId and online machine', () => {
        const session = createMockSession({
            flavor: 'agy',
            agyConversationId: 'ff7de001-44eb-4736-9d05-8b8dac3a8281',
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(true);
        expect(result.canShowResume).toBe(true);
        expect(result.message).toBe('sessionInfo.resumeSessionSubtitle');
    });

    it('returns canResume: true for claude sessions with claudeSessionId and online machine', () => {
        const session = createMockSession({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(true);
        expect(result.canShowResume).toBe(true);
        expect(result.message).toBe('sessionInfo.resumeSessionSubtitle');
    });

    it('returns canResume: true for codex sessions with codexThreadId and online machine', () => {
        const session = createMockSession({
            flavor: 'codex',
            codexThreadId: 'thread-12345',
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(true);
        expect(result.canShowResume).toBe(true);
        expect(result.message).toBe('sessionInfo.resumeSessionSubtitle');
    });

    it('returns canResume: false when backend resume ID is missing', () => {
        const session = createMockSession({
            flavor: 'agy',
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(false);
        expect(result.canShowResume).toBe(true);
        expect(result.message).toBe('sessionInfo.resumeSessionMissingBackendId');
    });

    it('returns canResume: false when machine is offline', () => {
        const session = createMockSession({
            flavor: 'agy',
            agyConversationId: 'ff7de001-44eb-4736-9d05-8b8dac3a8281',
        });
        const machine = createMockMachine(false);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(false);
        expect(result.canShowResume).toBe(true);
        expect(result.message).toBe('sessionInfo.resumeSessionMachineOffline');
    });

    it('returns canResume: false when session is already connected', () => {
        const session = createMockSession({
            flavor: 'agy',
            agyConversationId: 'ff7de001-44eb-4736-9d05-8b8dac3a8281',
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, true);
        expect(result.canResume).toBe(false);
        expect(result.canShowResume).toBe(false);
    });

    it('returns canResume: false when capabilities.resume is false', () => {
        const session = createMockSession({
            flavor: 'agy',
            agyConversationId: 'ff7de001-44eb-4736-9d05-8b8dac3a8281',
            capabilities: { resume: false } as any,
        });
        const machine = createMockMachine(true);

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(false);
        expect(result.canShowResume).toBe(false);
    });

    it('hides resume when the daemon does not publish resumeSupport', () => {
        const session = createMockSession({
            flavor: 'agy',
            agyConversationId: 'ff7de001-44eb-4736-9d05-8b8dac3a8281',
        });
        const machine = {
            id: 'machine-1',
            active: true,
            metadata: {},
        } as unknown as Machine;

        const result = getResumeAvailability(session, machine, false);
        expect(result.canResume).toBe(false);
        expect(result.canShowResume).toBe(false);
    });
});

describe('Testloop Dots lifecycle guards', () => {
    it.each(['dot', 'workspace'] as const)('hides and rejects generic archive for a valid %s before any visible effect', async kind => {
        const session = createMockSession({ testloopDots: {
            schemaVersion: 1, kind, workspaceId: '11111111-1111-4111-8111-111111111111',
            ...(kind === 'dot' ? { workspaceSessionId: 'workspace-session', dotId: '55555555-5555-4555-8555-555555555555' } : {}),
        } } as any);
        const onBeforeArchive = vi.fn();
        const actions = useSessionQuickActions(session, { onBeforeArchive });

        expect(actions.canArchive).toBe(false);
        expect(actions.actionItems.some(item => item.id === 'archive')).toBe(false);
        expect(actions.actionItems.some(item => item.id === 'details')).toBe(true);
        expect(actionMocks.handlers).toHaveLength(3);
        await expect(actionMocks.handlers[1]()).rejects.toThrow('Dots 工作台');
        expect(onBeforeArchive).not.toHaveBeenCalled();
        expect(actionMocks.markArchiving).not.toHaveBeenCalled();
        expect(actionMocks.sessionKill).not.toHaveBeenCalled();
        expect(actionMocks.sessionArchive).not.toHaveBeenCalled();
    });
});
