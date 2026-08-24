import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (globalThis as any).expo = { EventEmitter: class {} };
});

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
    storage: { getState: () => ({ settings: {} }) },
}));

vi.mock('@/sync/ops', () => ({
    machineResumeSession: vi.fn(),
    sessionArchive: vi.fn(),
    sessionKill: vi.fn(),
    sessionSetAgentModes: vi.fn(),
    forkAndSpawn: vi.fn(),
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshSessions: vi.fn() },
}));

vi.mock('@/sync/agentDefaults', () => ({
    resolveMessageModeMeta: () => ({}),
}));

vi.mock('@/hooks/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
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

import { getResumeAvailability } from './useSessionQuickActions';
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
    } as unknown as Machine;
}

describe('getResumeAvailability', () => {
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
});
