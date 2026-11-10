import { apiSocket } from './apiSocket';
import { TestloopDotsSnapshotSchema, type TestloopDotsSnapshot } from './testloopDots';

type ReadRequest = { schemaVersion: 1; workspaceId: string; requestId: string } & (
    { action: 'list' } | { action: 'inspect'; dotId: string });

/** Read-only session RPC. Transport success alone never supplies a directory. */
export async function readDotsWorkspace(sessionId: string, request: ReadRequest): Promise<TestloopDotsSnapshot> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: unknown;
    try {
        reply = await Promise.race([apiSocket.sessionRPC<unknown, ReadRequest>(sessionId, 'testloop-dots-read', request),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dots_read_timeout')), 10000); })]);
    } finally { clearTimeout(timer); }
    const parsed = TestloopDotsSnapshotSchema.safeParse(reply);
    if (!parsed.success || !parsed.data.ok || parsed.data.workspaceId !== request.workspaceId
        || parsed.data.requestId !== request.requestId
        || request.action === 'inspect' && parsed.data.workbench?.detail?.dotId !== request.dotId)
        throw new Error('dots_read_unconfirmed');
    return parsed.data;
}
