import { z } from 'zod';
import { apiSocket } from './apiSocket';
import { dotDispatchCatalog, dotDispatchTarget, TestloopDotsSnapshotSchema, type DotDispatchTarget, type TestloopDotsSnapshot } from './testloopDots';

type ReadRequest = { schemaVersion: 1; workspaceId: string; requestId: string; archiveSessionIds?: string[] } & (
    { action: 'list' } | { action: 'inspect'; dotId: string });

async function requestWorkspaceRead<T>(sessionId: string, request: T): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([apiSocket.sessionRPC<unknown, T>(sessionId, 'testloop-dots-read', request),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dots_read_timeout')), 10000); })]);
    } finally { clearTimeout(timer); }
}

/** Read-only session RPC. Transport success alone never supplies a directory. */
export async function readDotsWorkspace(sessionId: string, request: ReadRequest): Promise<TestloopDotsSnapshot> {
    const reply = await requestWorkspaceRead(sessionId, request);
    const parsed = TestloopDotsSnapshotSchema.safeParse(reply);
    if (!parsed.success || !parsed.data.ok || parsed.data.workspaceId !== request.workspaceId
        || parsed.data.requestId !== request.requestId
        || parsed.data.deletedDots?.some(deletion => !request.archiveSessionIds?.includes(deletion.sessionId))
        || request.action === 'inspect' && parsed.data.dots.some(dot => dot.id === request.dotId)
            && parsed.data.workbench?.detail?.dotId !== request.dotId)
        throw new Error('dots_read_unconfirmed');
    return parsed.data;
}

const dispatchConnection = dotDispatchTarget.extend({ name: z.string().min(1).max(100) });
const dispatchBinding = z.object({
    schemaVersion: z.literal(1), ok: z.literal(true), workspaceId: z.string().uuid(), requestId: z.string().uuid(), dotId: z.string().uuid(),
}).strict();
const dispatchReadReply = z.union([
    dispatchBinding.extend({ targets: z.array(dispatchConnection).max(32) }),
    dispatchBinding.extend({ target: dotDispatchTarget, catalog: dotDispatchCatalog }),
]);
export type DotDispatchConnection = z.infer<typeof dispatchConnection>;
export type DotDispatchCatalog = z.infer<typeof dotDispatchCatalog>;
export type ReadDotDispatchOptions = (dotId: string, target?: DotDispatchTarget) => Promise<z.infer<typeof dispatchReadReply>>;

export async function readDotDispatchOptions(sessionId: string, workspaceId: string, requestId: string, dotId: string, target?: DotDispatchTarget) {
    const reply = await requestWorkspaceRead(sessionId, {
        schemaVersion: 1, action: 'dispatch-options', workspaceId, requestId, dotId, ...(target ? { target } : {}),
    });
    const parsed = dispatchReadReply.safeParse(reply);
    if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.requestId !== requestId || parsed.data.dotId !== dotId
        || (target ? !('target' in parsed.data) || parsed.data.target.connectionID !== target.connectionID
            || parsed.data.target.machineID !== target.machineID : !('targets' in parsed.data))) {
        throw new Error('dots_dispatch_read_unconfirmed');
    }
    return parsed.data;
}
