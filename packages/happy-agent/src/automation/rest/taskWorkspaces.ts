import { execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, constants, openSync, closeSync, fstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { ApiError } from './schema';
import { privateDirectory } from './privateFs';
import { TaskQueue, executionSchema, type Workspace, type Resource } from './taskQueue';

const git = (cwd: string, args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim();
/** A query whose non-zero exit is itself an answer, e.g. a detached HEAD. */
const gitOptional = (cwd: string, args: string[]) => { try { return git(cwd, args); } catch { return null; } };

export function canonicalRepository(root: string): string {
    if (realpathSync(root) !== root) throw new ApiError('PROJECT_PATH_CHANGED',403);
    try { return realpathSync(resolve(root,git(root,['rev-parse','--git-common-dir']))); }
    catch { return root; } // Non-Git projects share their canonical directory.
}

/** No checkout holds the machine queue lock or blocks the worker event loop.
 * The per-workspace flock is inherited by Git, so parent death cannot permit
 * a second checkout while the original Git process is still running.
 */
async function gitAsync(cwd: string, args: string[], lockFD?: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args], { stdio: lockFD === undefined ? ['ignore','pipe','pipe'] : ['ignore','pipe','pipe',lockFD],
            detached: true, env: {...process.env,GIT_TERMINAL_PROMPT:'0'} });
        let output = '', bytes = 0, timedOut = false;
        child.stdout?.on('data', data => { bytes += data.length; if (bytes <= 1024*1024) output += data; });
        child.stderr?.on('data', data => { bytes += data.length; });
        const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid,'SIGTERM'); } catch { /* Exit is independently observed below. */ } } },30000);
        child.once('error', () => { clearTimeout(timer); reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)); });
        child.once('close', code => { clearTimeout(timer); code === 0 && !timedOut && bytes <= 1024*1024 ? resolve(output.trim()) : reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)); });
    });
}
async function workspaceLock(directory: string, id: string): Promise<number> {
    const locks = join(directory,'workspace-locks'); privateDirectory(locks,true);
    const fd = openSync(join(locks,id),constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
    try {
        const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o077))throw new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503);
        await new Promise<void>((resolve,reject) => {
            const child = spawn('flock',['--exclusive','--timeout','30','3'],{stdio:['ignore','ignore','ignore',fd]});
            child.once('error',()=>reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)));
            child.once('close',code=>code===0?resolve():reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)));
        });
        return fd;
    } catch(e) {closeSync(fd);throw e;}
}

/** Fixed committed baseline; no dependency links, dist copies, stash or main mutations. */
export async function prepareWorkspace(queue: TaskQueue, input: { requestID: string; grantID: string; projectID: string; root: string; title?: string; execution?: unknown; options?: unknown }, authorize: () => Promise<void> = async()=>{}): Promise<Workspace> {
    const execution = executionSchema.parse(input.execution ?? {}), id = hash(`${input.grantID}\n${input.requestID}`);
    const fingerprint = hash(canonicalBody({ ...input, execution }));
    let workspace = queue.workspaces(input.grantID).find(w=>w.id===id);
    if (workspace && workspace.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_CONFLICT',409);
    if (!workspace) {
        if (realpathSync(input.root) !== input.root) throw new ApiError('PROJECT_PATH_CHANGED',403);
        let repository: string, baseCommit: string | undefined;
        try { repository = realpathSync(resolve(input.root,await gitAsync(input.root,['rev-parse','--git-common-dir']))); }
        catch { if (!['legacy','integration'].includes(execution.mode)) throw new ApiError('WORKTREE_REQUIRES_GIT'); repository = input.root; }
        if (['worktree','read-only'].includes(execution.mode)) {
            if (realpathSync(await gitAsync(input.root,['rev-parse','--show-toplevel'])) !== input.root) throw new ApiError('WORKTREE_REQUIRES_REPOSITORY_ROOT',403);
            baseCommit = await gitAsync(input.root,['rev-parse','--verify','HEAD^{commit}']);
        }
        workspace = queue.transaction(s=>{
            if (s.tasks.some(t=>t.id===id)||s.cancellations.some(c=>c.grantID===input.grantID&&c.requestID===input.requestID)) throw new ApiError('REQUEST_ID_CONFLICT',409);
            const prior=s.workspaces.find(w=>w.id===id);
            if(prior){if(prior.fingerprint!==fingerprint)throw new ApiError('REQUEST_ID_CONFLICT',409);return prior;}
            const port=20000+s.workspaces.length;if(port>60000)throw new ApiError('TASK_PORT_RANGE_EXHAUSTED');
            const value: Workspace={id,fingerprint,grantID:input.grantID,projectID:input.projectID,root:input.root,repository,
                cwd:baseCommit?join(queue.directory,'worktrees',id):input.root,branch:baseCommit?`dot-task/${id}`:undefined,baseCommit,execution,
                options:input.options as Record<string,unknown>|undefined,temporaryDirectory:join(queue.directory,'temporary',id),port,stage:'preparing',preparationPID:process.pid};
            s.workspaces.push(value);return value;
        });
    }
    const fd=await workspaceLock(queue.directory,id);
    try {
        workspace=queue.workspaces(input.grantID).find(w=>w.id===id)!;
        if(workspace.stage==='preparing') {
            queue.transaction(s=>{s.workspaces.find(w=>w.id===id)!.preparationPID=process.pid;});
            if(workspace.branch&&!existsSync(workspace.cwd)) {
                privateDirectory(join(queue.directory,'worktrees'),true);
                await authorize();
                await gitAsync(input.root,['worktree','add','-b',workspace.branch,workspace.cwd,workspace.baseCommit!],fd);
            }
            // A partially checked out/conflicting directory is retained. Never reset/force it.
            verifyWorkspace(workspace);
            if(workspace.branch && git(workspace.cwd,['status','--porcelain=v1','--untracked-files=all'])) throw new ApiError('WORKTREE_RECOVERY_REQUIRED',409);
            privateDirectory(workspace.temporaryDirectory,true);
            queue.transaction(s=>{const w=s.workspaces.find(w=>w.id===id)!;w.stage='ready';delete w.preparationError;});
        } else verifyWorkspace(workspace);
        return queue.workspaces(input.grantID).find(w=>w.id===id)!;
    } catch(e) {
        queue.transaction(s=>{const w=s.workspaces.find(w=>w.id===id)!;w.preparationError='WORKTREE_PREPARATION_UNCONFIRMED';});
        throw e;
    } finally {closeSync(fd);}
}
/** The workspace must stay the same checkout of the same repository, started from the
 * recorded baseline. A task may create, rename or switch to any branch of that repository
 * — the assigned `branch` is only the creation name, not a lock — provided the recorded
 * `baseCommit` stays an ancestor of HEAD, so everything it delivers remains reachable from
 * the assigned history. A detached HEAD is rejected: nothing can be fetched or reviewed.
 * The branch the root checkout itself has checked out is also rejected, so a forced
 * `checkout -f -B <rootBranch>` inside the worktree cannot rewrite the user's branch and
 * keep progressing unnoticed. Returns the branch actually checked out.
 */
export function verifyWorkspace(w: Workspace): { branch: string } | null {
    if (realpathSync(w.root) !== w.root || realpathSync(w.cwd) !== w.cwd) throw new ApiError('PROJECT_PATH_CHANGED', 403);
    if (canonicalRepository(w.root) !== w.repository) throw new ApiError('WORKTREE_BINDING_CHANGED',403);
    if (!w.branch) return null;
    const common = realpathSync(resolve(w.cwd, git(w.cwd, ['rev-parse', '--git-common-dir'])));
    if (common !== w.repository) throw new ApiError('WORKTREE_BINDING_CHANGED', 403);
    const branch = gitOptional(w.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch === null || branch === gitOptional(w.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        || gitOptional(w.cwd, ['merge-base', '--is-ancestor', w.baseCommit!, 'HEAD']) === null)
        throw new ApiError('WORKTREE_BINDING_CHANGED', 403);
    return { branch };
}
export function workspaceResources(w?: Pick<Workspace,'repository'|'cwd'|'execution'>, sessionID?: string): Resource[] {
    // Unknown pre-queue execution remains conservative. Known executions count
    // project slots by repository and serialize writes only to the actual checkout.
    const result: Resource[] = [{ key: 'machine', mode: !w ? 'exclusive' : 'shared' }];
    if (w) {
        // Repository identity counts project slots. Only writers sharing an actual
        // checkout exclude each other; independent worktrees can keep progressing.
        result.push({ key: `repo:${hash(w.repository)}`, mode: 'shared' });
        result.push({ key: `checkout:${hash(w.cwd)}`, mode: w.execution.mode === 'read-only' ? 'shared' : 'exclusive' });
        result.push(...w.execution.resources.map(key => ({ key: `declared:${key}`, mode: 'exclusive' as const })));
    }
    if (sessionID) result.push({ key: `session:${sessionID}`, mode: 'exclusive' });
    return result;
}

/** Explicit cleanup only. Failed/cancelled/dirty worktrees and every branch are retained. */
export function cleanCompletedWorkspace(queue: TaskQueue, id: string, processStopped: () => boolean = () => false) {
    return queue.transaction(s => {
        const workspace = s.workspaces.find(w => w.id === id);
        if (!workspace?.branch) throw new ApiError('WORKTREE_NOT_MANAGED');
        const tasks = s.tasks.filter(t => t.workspaceID === id);
        if (!tasks.length || tasks.some(t => t.state !== 'completed')) throw new ApiError('WORKTREE_IN_USE');
        verifyWorkspace(workspace);
        if (git(workspace.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new ApiError('WORKTREE_DIRTY');
        if (!processStopped()) throw new ApiError('WORKTREE_PROCESS_UNCONFIRMED');
        const worktreeBranch = workspaceBranch(workspace);
        git(workspace.root, ['worktree', 'remove', workspace.cwd]);
        return { branch: workspace.branch, worktreeBranch, baseCommit: workspace.baseCommit, retained: true };
    });
}

/** The assigned branch is the creation name, not necessarily the checked-out one. Report
 * both so a reviewer is not sent to a branch the task already moved away from.
 */
export function workspaceBranch(w: Workspace) {
    return w.branch ? gitOptional(w.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : null;
}

export function workspaceResult(w: Workspace) {
    verifyWorkspace(w);
    if (w.repository === w.root) return {};
    return { resultCommit: git(w.cwd,['rev-parse','--verify','HEAD^{commit}']), worktreeDirty: Boolean(git(w.cwd,['status','--porcelain=v1','--untracked-files=all'])) };
}
