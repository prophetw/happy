import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '@/sync/recentProjects';
import type { MachineChoice } from '@/sync/machineChoices';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({ saved: [] as RecentProject[], platform: 'web', applySettings: vi.fn() }));
vi.mock('react', () => ({ useMemo: (factory: () => unknown) => factory(), useEffect: (effect: () => void) => effect() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.platform; } } }));
vi.mock('@/sync/storage', () => ({
    useSetting: () => mocks.saved,
    storage: { getState: () => ({ settings: { recentProjects: mocks.saved }, projects: { catalog: { name: 'Catalog project' } } }) },
}));
vi.mock('@/sync/sync', () => ({ sync: { applySettings: mocks.applySettings } }));

import { rememberRecentProject, useRecentProjects } from './useRecentProjects';
const choice = { id: 'computer', machineIds: ['computer'], name: 'Computer', online: true } as MachineChoice;
const session = { id: 's', createdAt: 10, metadata: { machineId: 'computer', path: '/code/happy' } } as Session;

describe.each(['web', 'ios'])('%s recent project recording', (platform) => {
    beforeEach(() => {
        mocks.saved = [];
        mocks.platform = platform;
        mocks.applySettings.mockReset();
        mocks.applySettings.mockImplementation(({ recentProjects }) => { mocks.saved = recentProjects; });
    });

    it('saves known projects once and restores them when the session snapshot becomes empty', () => {
        useRecentProjects([session], [choice]);
        expect(mocks.applySettings).toHaveBeenCalledOnce();
        expect(useRecentProjects([], [choice])).toMatchObject([{ path: '/code/happy' }]);
        expect(mocks.applySettings).toHaveBeenCalledOnce();
    });

    it('records a successful empty session and a catalog-only project without inventing a path', () => {
        rememberRecentProject({ machineId: 'computer', path: '/code/happy' });
        rememberRecentProject({ machineId: 'computer', path: null, projectId: 'catalog' });
        expect(mocks.saved).toHaveLength(2);
        expect(mocks.saved.find((entry) => entry.projectId === 'catalog')).toMatchObject({ path: null, name: 'Catalog project' });
    });

    it('leaves the Android client behavior unchanged', () => {
        mocks.platform = 'android';
        expect(useRecentProjects([session], [choice])).toEqual([]);
        rememberRecentProject({ machineId: 'computer', path: '/code/happy' });
        expect(mocks.applySettings).not.toHaveBeenCalled();
    });
});
