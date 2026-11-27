import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { MetadataStore } from './store';
import { ApiError } from './schema';
import type { TaskQueue, Workspace } from './taskQueue';

type Scope = Pick<Workspace,'grantID'|'projectID'|'root'>;
const schema=z.object({
    workspaceID:z.string().regex(/^[a-f0-9]{64}$/),
    scope:z.string().regex(/^[a-f0-9]{64}$/),
    repository:z.string().startsWith('/'), directory:z.string().startsWith('/'), branch:z.string(),
    baseCommit:z.string().regex(/^[a-f0-9]{40,64}$/),
}).strict();
export type WorkspaceIdentity=z.infer<typeof schema>;
const scopeHash=({grantID,projectID,root}:Scope)=>hash(canonicalBody({grantID,projectID,root}));

function identityStore(queue:TaskQueue, create=false) {
    const directory=join(queue.directory,'workspace-identity');
    return create||existsSync(directory)?new MetadataStore(directory,32*1024,create):undefined;
}

function identityKey(queue:TaskQueue, scope:Scope, workspaceID:string) {
    return canonicalBody([queue.access.machineID,scopeHash(scope),workspaceID]);
}

/** A recovery receipt records only immutable creation facts. The main queue
 * remains authoritative for access, lifecycle and executable sessions. */
export function rememberWorkspaceIdentity(queue:TaskQueue, w:Workspace) {
    if(!w.managedBy||!w.branch||!w.baseCommit||w.execution.mode!=='worktree'||w.stage!=='ready') return;
    const store=identityStore(queue,true)!;
    const key=identityKey(queue,w,w.id);
    const identity=schema.parse({workspaceID:w.id,scope:scopeHash(w),repository:w.repository,directory:w.cwd,branch:w.branch,baseCommit:w.baseCommit});
    const previous=store.get(key);
    if(!previous){store.set(key,identity);return;}
    if(canonicalBody(previous)!==canonicalBody(identity)) throw new ApiError('WORKSPACE_METADATA_CHANGED',409);
}

export function recoverWorkspaceIdentity(queue:TaskQueue, scope:Scope, workspaceID:string):WorkspaceIdentity|undefined {
    const raw=identityStore(queue)?.get(identityKey(queue,scope,workspaceID));
    if(!raw) return undefined;
    const identity=schema.parse(raw);
    if(identity.scope!==scopeHash(scope)||identity.workspaceID!==workspaceID||identity.directory!==join(queue.directory,'worktrees',workspaceID))
        throw new ApiError('WORKSPACE_METADATA_CHANGED',409);
    return identity;
}
