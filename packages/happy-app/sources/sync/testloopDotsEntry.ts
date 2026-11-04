import { readTestloopDotsMetadata } from './testloopDots';

type EntrySession = { id: string; metadata: unknown; createdAt?: number };
export type DotsWorkspaceChoice = { sessionId: string; workspaceId: string; title: string;
    dotNames: string[]; archived: boolean };
type Reference = Pick<DotsWorkspaceChoice, 'sessionId' | 'workspaceId' | 'dotNames'>;
export type DotsWorkspaceDiscovery = { canceled: boolean; workspaces: DotsWorkspaceChoice[]; unresolved: number };
export type DotsWorkspaceDiscoveryDependencies = {
    refreshSessions: (signal?: AbortSignal) => Promise<void>;
    readSessions: () => readonly EntrySession[];
    ensureSessionReady: (sessionId: string) => Promise<void>;
    readSession: (sessionId: string) => EntrySession | null | undefined;
    isCurrent: () => boolean;
    signal?: AbortSignal;
};

function sessionTitle(session: EntrySession) {
    const metadata = session.metadata;
    const summary = metadata && typeof metadata === 'object' && 'summary' in metadata ? metadata.summary : null;
    const text = summary && typeof summary === 'object' && 'text' in summary ? summary.text : null;
    return typeof text === 'string' && text.trim() ? Array.from(text.trim()).slice(0, 120).join('') : 'Dots 工作台';
}

function explicitlyArchived(session: EntrySession) {
    const metadata = session.metadata;
    const lifecycle = metadata && typeof metadata === 'object' && 'lifecycleState' in metadata ? metadata.lifecycleState : null;
    return lifecycle === 'archived' || lifecycle === 'archiving';
}

/** Reads the raw account session collection, independent of display groups and archive filters. */
function workspaceReferences(sessions: readonly EntrySession[]) {
    const refs = new Map<string, Reference>();
    for (const session of sessions) {
        const binding = readTestloopDotsMetadata(session.metadata);
        if (!binding) continue;
        const sessionId = binding.kind === 'workspace' ? session.id : binding.workspaceSessionId;
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) continue;
        const key = `${binding.workspaceId}:${sessionId}`;
        const ref = refs.get(key) ?? { workspaceId: binding.workspaceId, sessionId, dotNames: [] };
        if (binding.kind === 'dot' && ref.dotNames.length < 3) {
            const name = sessionTitle(session);
            if (!ref.dotNames.includes(name)) ref.dotNames.push(name);
        }
        refs.set(key, ref);
    }
    return [...refs.values()];
}

export function matchesDotsWorkspace(choice: Pick<DotsWorkspaceChoice, 'sessionId' | 'workspaceId'>,
    session: EntrySession | null | undefined) {
    const binding = readTestloopDotsMetadata(session?.metadata);
    return !!session && session.id === choice.sessionId && binding?.kind === 'workspace'
        && binding.workspaceId === choice.workspaceId;
}

async function discover(deps: DotsWorkspaceDiscoveryDependencies): Promise<DotsWorkspaceDiscovery> {
    const canceled = (): DotsWorkspaceDiscovery => ({ canceled: true, workspaces: [], unresolved: 0 });
    if (!deps.isCurrent()) return canceled();
    await deps.refreshSessions();
    if (!deps.isCurrent()) return canceled();
    const refs = workspaceReferences(deps.readSessions());
    const workspaces = new Map<string, DotsWorkspaceChoice>();
    let unresolved = 0;
    for (const ref of refs) {
        if (!deps.isCurrent()) return canceled();
        try { await deps.ensureSessionReady(ref.sessionId); }
        catch {
            if (!deps.isCurrent()) return canceled();
            unresolved++; continue;
        }
        if (!deps.isCurrent()) return canceled();
        const session = deps.readSession(ref.sessionId);
        if (!matchesDotsWorkspace(ref, session)) { unresolved++; continue; }
        workspaces.set(ref.sessionId, { ...ref, title: sessionTitle(session!),
            archived: explicitlyArchived(session!) });
    }
    return { canceled: false, workspaces: [...workspaces.values()].sort((a, b) => a.title.localeCompare(b.title)), unresolved };
}

/** Sync may retry indefinitely; bound this view's wait and fence off late account results. */
export async function discoverDotsWorkspaces(deps: DotsWorkspaceDiscoveryDependencies,
    timeoutMs = 15000): Promise<DotsWorkspaceDiscovery> {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (deps.signal?.aborted) controller.abort();
    else deps.signal?.addEventListener('abort', abort, { once: true });
    const current = () => !finished && !controller.signal.aborted && deps.isCurrent();
    try {
        return await Promise.race([
            discover({ ...deps, refreshSessions: () => deps.refreshSessions(controller.signal), isCurrent: current }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => {
                reject(new Error('dots_entry_timeout')); controller.abort();
            }, timeoutMs); }),
        ]);
    } finally {
        finished = true; clearTimeout(timer); controller.abort();
        deps.signal?.removeEventListener('abort', abort);
    }
}
