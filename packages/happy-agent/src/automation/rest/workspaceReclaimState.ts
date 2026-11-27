import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Workspace } from './taskQueue';
import { MetadataStore } from './store';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const reclaimStatusSchema = z.object({
    state: z.enum(['waiting', 'attention', 'released']),
    reason: z.string().regex(/^[A-Za-z0-9_]{1,128}$/).optional(),
    operationID: identifier.optional(),
}).strict();
export type ReclaimStatus = z.infer<typeof reclaimStatusSchema>;
const record = z.object({
    workspaceID: digest,
    creation: digest,
    projectID: identifier,
    grantID: identifier,
    status: reclaimStatusSchema,
    attempt: z.number().int().nonnegative().default(0),
    nextAt: z.number().int().nonnegative().default(0),
}).strict();
export type ReclaimRecord = z.infer<typeof record>;

export function reclaimRecords(directory: string, create = false) {
    const path = join(directory, 'workspace-reclamation');
    if (create || existsSync(path)) return new MetadataStore(path, 8192, create);
    return undefined;
}

function releasedRecords(directory:string, create = false) {
    const path = join(directory,'workspace-reclamation-receipts');
    if (create || existsSync(path)) return new MetadataStore(path,8192,create);
    return undefined;
}

export function saveReclaimStatus(directory:string, value:ReclaimRecord) {
    const pending = reclaimRecords(directory)!;
    if (value.status.state !== 'released') { pending.set(value.workspaceID,value);return; }
    const receipts=releasedRecords(directory,true)!;
    receipts.set(value.workspaceID,value);
    if (record.parse(receipts.get(value.workspaceID)).status.state==='released') pending.delete(value.workspaceID);
}

export function rememberReclaimCreation(directory: string, workspace: Workspace) {
    if (workspace.execution.mode !== 'worktree' || workspace.execution.candidate || !workspace.managedBy) return;
    reclaimRecords(directory, true)!.claim(workspace.id, record.parse({
        workspaceID: workspace.id, creation: workspace.fingerprint, projectID: workspace.projectID,
        grantID: workspace.grantID, status: { state: 'waiting', reason: 'task_running' },
    }));
}

export function reclaimRecord(directory: string, workspace: Workspace) {
    const raw = releasedRecords(directory)?.get(workspace.id) ?? reclaimRecords(directory)?.get(workspace.id);
    if (raw === null || raw === undefined) return;
    const value = record.parse(raw);
    if (!workspace.managedBy || workspace.execution.mode !== 'worktree' || workspace.execution.candidate
        || value.workspaceID !== workspace.id || value.creation !== workspace.fingerprint
        || value.projectID !== workspace.projectID || value.grantID !== workspace.grantID) return;
    return value;
}

export function dueReclaimProjects(directory: string, now: number) {
    const records = reclaimRecords(directory)?.list<unknown>('') ?? [];
    return new Set(records.map(value => record.parse(value)).filter(r => r.status.state !== 'released' && r.nextAt <= now).map(r => r.projectID));
}

/** Don't generate known rebuildable Node/tsx caches in the task artifact
 * directory. The directory may also contain user files and is never purged. */
export function managedWorkspaceCacheEnvironment(cwd: string, workspaceID: string | undefined): Record<string,string> {
    if (!workspaceID || !digest.safeParse(workspaceID).success
        || cwd !== join(dirname(dirname(cwd)),'worktrees',workspaceID)) return {};
    const saved = record.safeParse(reclaimRecords(dirname(dirname(cwd)))?.get(workspaceID));
    return saved.success && saved.data.workspaceID === workspaceID
        ? {NODE_DISABLE_COMPILE_CACHE:'1',TSX_DISABLE_CACHE:'1'} : {};
}
