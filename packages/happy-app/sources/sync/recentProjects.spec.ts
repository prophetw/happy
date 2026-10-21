import { describe, expect, it } from 'vitest';
import type { Session } from './storageTypes';
import type { MachineChoice } from './machineChoices';
import {
    addRecentProjectPlaces,
    collectProjectSearchOptions,
    mergeRecentProjects,
    RECENT_PROJECT_LIMIT,
    recentProjectsFromSessions,
    type RecentProject,
} from './recentProjects';
import { searchDirectoryOptions } from '@/utils/directorySearch';
import { settingsParse, settingsToSyncPayload } from './settings';

const choice = (id: string, online = true, machineIds = [id]): MachineChoice => ({
    id, name: id, machineIds, online, activeAt: 0, happyMachine: null, rigMachine: null,
});
const project = (overrides: Partial<RecentProject> = {}): RecentProject => ({
    machineId: 'linux', path: '/code/happy', name: 'happy', lastUsedAt: 1, ...overrides,
});
const session = (metadata: Record<string, unknown>, createdAt = 10): Session => ({
    id: 'session', createdAt, updatedAt: createdAt, metadata,
} as unknown as Session);

describe('durable recent projects', () => {
    it('keeps a project after its last session is archived or missing from the next snapshot', () => {
        const active = session({ machineId: 'linux', path: '/code/happy' });
        const history = recentProjectsFromSessions([active], [choice('linux')]);
        const archived = { ...active, metadata: { ...active.metadata!, lifecycleState: 'archived' as const } };
        const restored = mergeRecentProjects(history, recentProjectsFromSessions([archived], [choice('linux')]));
        expect(restored).toEqual(history);
        expect(mergeRecentProjects(restored, recentProjectsFromSessions([], [choice('linux')]))).toEqual(history);
        expect(addRecentProjectPlaces([], restored, ['linux'])).toEqual([
            { key: '/code/happy', path: '/code/happy', name: 'happy' },
        ]);
    });

    it('retains history across a settings serialization and older settings default to an empty history', () => {
        expect(settingsParse({}).recentProjects).toEqual([]);
        const history = [project(), project({ machineId: 'windows', path: 'D:\\code\\happy' })];
        const saved = settingsToSyncPayload(settingsParse({ recentProjects: history }));
        expect(settingsParse(JSON.parse(JSON.stringify(saved))).recentProjects).toEqual(history);
    });

    it('only evicts the oldest entries at the history limit and never lets an old snapshot downgrade recency', () => {
        const history = Array.from({ length: RECENT_PROJECT_LIMIT }, (_, index) => project({ path: `/repo/${index}`, lastUsedAt: index + 1 }));
        const updated = mergeRecentProjects(history, [project({ path: '/repo/0', lastUsedAt: 200 }), project({ path: '/repo/new', lastUsedAt: 201 })]);
        expect(updated).toHaveLength(RECENT_PROJECT_LIMIT);
        expect(updated[0].path).toBe('/repo/new');
        expect(updated[1].path).toBe('/repo/0');
        expect(updated.some((entry) => entry.path === '/repo/1')).toBe(false);
        expect(mergeRecentProjects(updated, history)[1].lastUsedAt).toBe(200);
    });

    it('normalizes Windows path spelling while preserving distinct POSIX paths and computers', () => {
        const merged = mergeRecentProjects([], [
            project({ path: 'D:\\code\\happy' }), project({ path: 'd:/CODE/happy/', lastUsedAt: 2 }),
            project({ path: '/code/Happy' }), project({ path: '/code/happy' }),
            project({ machineId: 'other', path: '/code/happy' }),
        ]);
        expect(merged).toHaveLength(4);
    });

    it('learns the computer identity from either daemon and stores a CLI worktree under its repository', () => {
        const history = recentProjectsFromSessions([
            session({ machineId: 'rig', path: '/code/happy/.dev/worktree/fix' }),
            session({ machineId: 'other', path: '/not-this-computer' }),
            session({ path: '/unknown-machine' }),
            session({ machineId: 'cli', path: '/bot', bot: { id: 'bot' } }),
        ], [choice('cli', true, ['cli', 'rig'])]);
        expect(history).toEqual([project({ machineId: 'cli', lastUsedAt: 10 })]);
    });

    it('keeps catalog-only projects by identity and replaces that row when the main path becomes known', () => {
        const history = recentProjectsFromSessions([
            session({ machineId: 'linux', path: '/workspace', project: { id: 'p', name: 'happy' }, workspace: { id: 'w' } }),
        ], [choice('linux')]);
        expect(history[0]).toMatchObject({ path: null, projectId: 'p', name: 'happy' });
        const withPath = mergeRecentProjects(history, [project({ projectId: 'p', lastUsedAt: 20 })]);
        expect(withPath).toHaveLength(1);
        expect(withPath[0].path).toBe('/code/happy');
        expect(mergeRecentProjects(withPath, [{ ...history[0], lastUsedAt: 30 }])[0]).toMatchObject({ path: '/code/happy', lastUsedAt: 30 });
    });

    it('does not revive archived workspace paths while first seeding history', () => {
        expect(recentProjectsFromSessions([
            session({ machineId: 'linux', path: '/removed/workspace', lifecycleState: 'archived' }),
        ], [choice('linux')])).toEqual([]);
    });

    it('adds only this computer’s saved places and preserves live names', () => {
        const live = [{ key: '/code/happy', path: '/code/happy', name: 'Current name', projectId: 'p' }];
        expect(addRecentProjectPlaces(live, [project({ projectId: 'p' }), project({ machineId: 'other', path: '/elsewhere' })], ['linux'])).toEqual(live);
        expect(addRecentProjectPlaces([{ key: '/code/happy', path: '/code/happy', name: '/code/happy' }], [project({ name: 'Named project', projectId: 'p' })], ['linux'])[0])
            .toMatchObject({ name: 'Named project', projectId: 'p' });
    });
});

describe('cross-machine project search', () => {
    it('returns same-name projects separately, including offline machines, with online recent matches first', () => {
        const options = collectProjectSearchOptions([
            project({ machineId: 'offline', lastUsedAt: 100 }),
            project({ machineId: 'windows', path: 'D:\\code\\happy', lastUsedAt: 20 }),
            project({ lastUsedAt: 10 }),
        ], [choice('linux'), choice('windows'), choice('offline', false)]);
        expect(searchDirectoryOptions(options, 'happy').map((entry) => entry.machineId)).toEqual(['windows', 'linux', 'offline']);
        expect(options.find((entry) => entry.machineId === 'offline')?.online).toBe(false);
        expect(searchDirectoryOptions(options, 'D:\\code\\happy')[0].machineId).toBe('windows');
    });

    it('ranks an exact project name above an online prefix match', () => {
        const options = collectProjectSearchOptions([
            project({ machineId: 'offline' }),
            project({ name: 'happy-server', path: '/code/happy-server' }),
        ], [choice('linux'), choice('offline', false)]);
        expect(searchDirectoryOptions(options, 'happy')[0].machineId).toBe('offline');
    });

    it('coalesces paired daemons but does not expose saved projects from unregistered machines', () => {
        const options = collectProjectSearchOptions([
            project({ machineId: 'rig' }), project({ machineId: 'cli' }), project({ machineId: 'removed' }),
        ], [choice('cli', true, ['cli', 'rig'])]);
        expect(options).toHaveLength(1);
        expect(options[0].machineId).toBe('cli');
    });
});
