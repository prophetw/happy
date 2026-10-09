import type { ListThreadsParams, ListThreadsResponse } from './codexAppServerTypes';

export type NativeCodexSession = {
    sessionId: string;
    cwd: string;
    gitBranch: string | null;
    firstUserMessage: string | null;
    summary: string | null;
    timestamp: number;
};

type ThreadListClient = {
    listThreads: (params: ListThreadsParams) => Promise<ListThreadsResponse>;
};

const MAX_SESSIONS = 100;

/** List the latest stored conversations, including ones created outside Happy. */
export async function listNativeCodexSessions(client: ThreadListClient, directory?: string): Promise<NativeCodexSession[]> {
    const { data } = await client.listThreads({
        limit: MAX_SESSIONS,
        sortKey: 'updated_at',
        // Codex defaults to CLI/IDE sources; include Happy's app-server threads.
        sourceKinds: ['cli', 'vscode', 'appServer'],
        archived: false,
        ...(directory ? { cwd: directory } : {}),
    });

    return data.flatMap((thread): NativeCodexSession[] => {
        if (thread.ephemeral || !thread.id || typeof thread.cwd !== 'string' || !thread.cwd.trim()) {
            return [];
        }
        const seconds = Number.isFinite(thread.updatedAt) ? thread.updatedAt : thread.createdAt;
        if (!Number.isFinite(seconds)) {
            return [];
        }
        return [{
            sessionId: thread.id,
            cwd: thread.cwd,
            gitBranch: thread.gitInfo?.branch ?? null,
            firstUserMessage: thread.preview?.trim() || null,
            summary: thread.name?.trim() || null,
            timestamp: seconds * 1000,
        }];
    }).sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_SESSIONS);
}
