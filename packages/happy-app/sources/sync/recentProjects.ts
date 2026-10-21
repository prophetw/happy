import { z } from 'zod';
import type { Session } from './storageTypes';
import type { MachineChoice } from './machineChoices';
import type { SessionPlace } from './agentSessionPlaces';
import { projectPlaceKey } from './agentSessionPlaces';
import { getSessionActivityAt } from '@/utils/sessionActivity';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';

export const RECENT_PROJECT_LIMIT = 100;
export const RecentProjectSchema = z.object({
    machineId: z.string(),
    path: z.string().nullable(),
    projectId: z.string().optional(),
    name: z.string(),
    lastUsedAt: z.number(),
});
export type RecentProject = z.infer<typeof RecentProjectSchema>;

export interface ProjectSearchOption extends RecentProject {
    key: string;
    description: string;
    machineName: string;
    online: boolean;
}

function normalizedPath(path: string): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    return /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function recentProjectKey(project: Pick<RecentProject, 'machineId' | 'path' | 'projectId'>): string {
    return JSON.stringify([project.machineId, project.path === null
        ? projectPlaceKey(project.projectId ?? '')
        : normalizedPath(project.path)]);
}

export function projectName(path: string): string {
    return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

/** History survives the chats it was learned from; only the size limit evicts it. */
export function mergeRecentProjects(history: readonly RecentProject[], incoming: readonly RecentProject[]): RecentProject[] {
    const entries = new Map<string, RecentProject>();
    for (const project of [...history, ...incoming]) {
        if (!project.machineId || (!project.path && !project.projectId)) continue;
        const key = recentProjectKey(project);
        const previous = entries.get(key);
        const merged = previous && previous.lastUsedAt > project.lastUsedAt
            ? { ...project, ...previous } : { ...previous, ...project };
        // A named catalog record enriches a legacy path even when its chat is older.
        if (previous?.projectId && !project.projectId) merged.name = previous.name;
        if (project.projectId && !previous?.projectId) merged.name = project.name;
        entries.set(key, merged);
    }
    // A catalog project learned first through a workspace may later publish its main directory.
    const withPath = new Map([...entries.values()].filter((entry) => entry.path && entry.projectId)
        .map((entry) => [JSON.stringify([entry.machineId, entry.projectId]), entry] as const));
    for (const entry of entries.values()) {
        if (entry.path !== null) continue;
        const known = withPath.get(JSON.stringify([entry.machineId, entry.projectId]));
        if (known && entry.lastUsedAt > known.lastUsedAt) {
            entries.set(recentProjectKey(known), { ...known, name: entry.name, lastUsedAt: entry.lastUsedAt });
        }
    }
    return [...entries.values()]
        .filter((entry) => entry.path !== null || !withPath.has(JSON.stringify([entry.machineId, entry.projectId])))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .slice(0, RECENT_PROJECT_LIMIT);
}

/** Seed known projects without reviving archived workspaces or borrowing paths from other machines. */
export function recentProjectsFromSessions(sessions: readonly Session[], choices: readonly MachineChoice[]): RecentProject[] {
    const byMachine = new Map(choices.flatMap((choice) => choice.machineIds.map((id) => [id, choice] as const)));
    const projects: RecentProject[] = [];
    for (const session of sessions) {
        const metadata = session.metadata;
        if (!metadata?.machineId || !metadata.path?.trim() || metadata.bot || metadata.isSideChat
            || metadata.lifecycleState === 'archived') continue;
        const choice = byMachine.get(metadata.machineId);
        if (!choice) continue;
        const projectId = metadata.project?.id || undefined;
        if (metadata.workspace && !projectId) continue;
        const sessionPath = metadata.path.trim();
        const portablePath = sessionPath.replace(/\\/g, '/');
        const path = metadata.workspace ? null : isWorktreePath(portablePath)
            ? sessionPath.slice(0, getRepoPath(portablePath).length)
            : sessionPath;
        projects.push({
            machineId: choice.id,
            path,
            ...(projectId ? { projectId } : {}),
            name: metadata.project?.name || projectName(path ?? sessionPath),
            lastUsedAt: getSessionActivityAt(session) || session.updatedAt || 0,
        });
    }
    return mergeRecentProjects([], projects);
}

export function collectProjectSearchOptions(history: readonly RecentProject[], choices: readonly MachineChoice[]): ProjectSearchOption[] {
    const byMachine = new Map(choices.flatMap((choice) => choice.machineIds.map((id) => [id, choice] as const)));
    const canonical = history.flatMap((entry) => {
        const choice = byMachine.get(entry.machineId);
        return choice ? [{ ...entry, machineId: choice.id }] : [];
    });
    return mergeRecentProjects([], canonical).map((entry) => {
        const choice = byMachine.get(entry.machineId)!;
        return {
            ...entry,
            key: recentProjectKey(entry),
            description: `${entry.path ?? ''} ${choice.name}`.trim(),
            machineName: choice.name,
            online: choice.online,
        };
    }).sort((a, b) => Number(b.online) - Number(a.online) || b.lastUsedAt - a.lastUsedAt);
}

/** Add durable history to an existing machine-scoped picker, preserving live project names. */
export function addRecentProjectPlaces(places: readonly SessionPlace[], history: readonly RecentProject[], machineIds: readonly string[]): SessionPlace[] {
    const ids = new Set(machineIds);
    const result = [...places];
    for (const entry of history) {
        if (!ids.has(entry.machineId)) continue;
        const existingIndex = result.findIndex((place) => (entry.path !== null && place.path !== null && normalizedPath(place.path) === normalizedPath(entry.path))
            || (entry.projectId && place.projectId === entry.projectId));
        if (existingIndex >= 0) {
            if (!result[existingIndex].projectId && entry.projectId) {
                result[existingIndex] = { ...result[existingIndex], name: entry.name, projectId: entry.projectId };
            }
            continue;
        }
        result.push({
            key: entry.path ?? projectPlaceKey(entry.projectId!),
            name: entry.name,
            path: entry.path,
            ...(entry.projectId ? { projectId: entry.projectId } : {}),
        });
    }
    return result;
}
