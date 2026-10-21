import * as React from 'react';
import { Platform } from 'react-native';
import { storage, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { MachineChoice } from '@/sync/machineChoices';
import type { Session } from '@/sync/storageTypes';
import { mergeRecentProjects, projectName, recentProjectsFromSessions, type RecentProject } from '@/sync/recentProjects';

function supportsRecentProjects(): boolean {
    return Platform.OS === 'web' || Platform.OS === 'ios';
}

/** Web and the Expo iOS client share encrypted project history. */
export function useRecentProjects(sessions: readonly Session[], choices: readonly MachineChoice[]): readonly RecentProject[] {
    const saved = useSetting('recentProjects');
    const projects = React.useMemo(() => supportsRecentProjects()
        ? mergeRecentProjects(saved, recentProjectsFromSessions(sessions, choices))
        : [], [saved, sessions, choices]);
    React.useEffect(() => {
        if (supportsRecentProjects() && JSON.stringify(saved) !== JSON.stringify(projects)) {
            const current = storage.getState().settings.recentProjects;
            const merged = mergeRecentProjects(current, projects);
            if (JSON.stringify(current) !== JSON.stringify(merged)) sync.applySettings({ recentProjects: merged });
        }
    }, [projects, saved]);
    return projects;
}

/** Called after a successful start, including a start whose session has no first message. */
export function rememberRecentProject(project: Omit<RecentProject, 'name' | 'lastUsedAt'> & { name?: string }): void {
    if (!supportsRecentProjects()) return;
    const state = storage.getState();
    const entry: RecentProject = {
        ...project,
        name: project.name || (project.projectId ? state.projects[project.projectId]?.name : null)
            || projectName(project.path ?? 'Project'),
        lastUsedAt: Date.now(),
    };
    sync.applySettings({ recentProjects: mergeRecentProjects(state.settings.recentProjects, [entry]) });
}
