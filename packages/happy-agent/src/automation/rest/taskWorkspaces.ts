import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync, constants, openSync, closeSync, fstatSync, lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { ApiError } from './schema';
import { privateDirectory } from './privateFs';
import { TaskQueue, executionSchema, type Workspace, type Resource } from './taskQueue';
import { rememberWorkspaceIdentity } from './workspaceIdentity';
import { reclaimRecord, rememberReclaimCreation } from './workspaceReclaimState';
import { readReclaimRequest, reclaimRequestFenced } from './workspaceReclaimRequests';
import { workspaceIdleCloseFenced } from './workspaceIdleProof';
import { checkoutDigest, objectID, restrictedExecution } from './execution';

const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' });

const git = (cwd: string, args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C', cwd, ...args], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnvironment(),
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
export async function workspaceGit(cwd: string, args: string[], lockFD?: number, timeoutMs = 30_000, indexFile?:string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false','-C',cwd,...args], { stdio: lockFD === undefined ? ['ignore','pipe','pipe'] : ['ignore','pipe','pipe',lockFD],
            detached: true, env: {...gitEnvironment(),...(indexFile?{GIT_INDEX_FILE:indexFile}:{})} });
        let output = '', bytes = 0, timedOut = false;
        let killTimer:ReturnType<typeof setTimeout>|undefined;
        child.stdout?.on('data', data => { bytes += data.length; if (bytes <= 1024*1024) output += data; });
        child.stderr?.on('data', data => { bytes += data.length; });
        const stop=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal);}catch {/* Already exited. */}};
        const timer = setTimeout(() => { timedOut = true;stop('SIGTERM');killTimer=setTimeout(()=>stop('SIGKILL'),750); },timeoutMs);
        const clearTimers=()=>{clearTimeout(timer);clearTimeout(killTimer);};
        child.once('error', () => { clearTimers(); reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)); });
        child.once('close', code => { clearTimers(); code === 0 && !timedOut && bytes <= 1024*1024 ? resolve(output.trim()) : reject(new ApiError('WORKTREE_PREPARATION_UNCONFIRMED',503)); });
    });
}
export async function workspaceLock(directory: string, id: string): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError('WORKTREE_NOT_MANAGED');
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
const gitAsync = workspaceGit;
export async function withWorkspaceAccess<T>(queue: TaskQueue, id: string, action: () => Promise<T>): Promise<T> {
    const fd = await workspaceLock(queue.directory,id);
    try {
        const w = queue.transaction(s => s.workspaces.find(w => w.id === id),true);
        if (!w) throw new ApiError('WORKTREE_NOT_MANAGED');
        if(w.retirement)throw new ApiError(w.retirement.phase==='retired'?'WORKSPACE_RETIRED':'WORKSPACE_RETIRING',409);
        // The caller verified the checkout before entering the transport. The lease
        // prevents an owner retirement between that verification and the RPC; no
        // extra Git traversal is added to each worker status poll.
        if(w.testCleanup !== 'removed' && realpathSync(w.cwd)!==w.cwd)throw new ApiError('PROJECT_PATH_CHANGED',403);
        return await action();
    } finally { closeSync(fd); }
}

function commitTree(root: string, commit: string) {
    if (gitOptional(root, ['cat-file', '-t', commit]) !== 'commit') throw new ApiError('CANDIDATE_UNAVAILABLE', 409);
    const tree = gitOptional(root, ['rev-parse', '--verify', `${commit}^{tree}`]);
    if (!objectID.safeParse(tree).success || gitOptional(root, ['cat-file', '-t', tree!]) !== 'tree') throw new ApiError('CANDIDATE_UNAVAILABLE', 409);
    return tree!;
}

/** Same version identity as the native project report, including untracked files. */
const candidateScript = String.raw`
import hashlib,json,os,stat,subprocess
root=os.fsencode(os.getcwd())
git=['git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null']
if subprocess.check_output(git+['rev-parse','--show-toplevel']).rstrip(b'\n')!=root: raise RuntimeError('checkout_root_changed')
head=subprocess.check_output(git+['rev-parse','HEAD']).strip().decode('ascii')
names=sorted(set(subprocess.check_output(git+['ls-files','--cached','--others','--exclude-standard','-z']).split(b'\0'))-{b''})
rows=[]
for name in names:
 if any(p in (b'.git',b'.env') or p.startswith(b'.env.') for p in name.split(b'/')): continue
 parent=os.path.dirname(os.path.join(root,name))
 if os.path.realpath(parent)!=parent: raise RuntimeError('checkout_path_changed')
 try: info=os.lstat(name)
 except FileNotFoundError: rows.append([name.hex(),'missing']);continue
 if stat.S_ISREG(info.st_mode):
  digest=hashlib.sha256()
  with os.fdopen(os.open(name,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
   for chunk in iter(lambda:f.read(1048576),b''): digest.update(chunk)
  value=digest.hexdigest()
  kind='file'
 elif stat.S_ISLNK(info.st_mode): value=hashlib.sha256(os.readlink(name)).hexdigest();kind='symlink'
 else: raise RuntimeError('unsupported_candidate_file')
 rows.append([name.hex(),kind,bool(info.st_mode&0o111),value])
value=json.dumps({'head':head,'files':rows},ensure_ascii=True,separators=(',',':')).encode('ascii')
print('sha256:'+hashlib.sha256(value).hexdigest())
`;
const exec = promisify(execFile);
export async function checkoutVersion(cwd: string) {
    try {
        const { stdout } = await exec('python3', ['-c', candidateScript], { cwd, env: gitEnvironment(), timeout: 30000, maxBuffer: 1024 });
        return checkoutDigest.parse(stdout.trim());
    } catch { throw new ApiError('CANDIDATE_UNAVAILABLE', 409); }
}

export async function verifyReviewCandidate(w: Workspace) {
    const candidate = w.execution.candidate;
    let checked: ReturnType<typeof verifyWorkspace>;
    try { checked = verifyWorkspace(w); }
    catch (error) {
        if (candidate && !(error instanceof ApiError)) throw new ApiError('CANDIDATE_UNAVAILABLE', 409);
        if (candidate && error instanceof ApiError && ['WORKTREE_BINDING_CHANGED', 'PROJECT_PATH_CHANGED'].includes(error.code)) throw new ApiError('CANDIDATE_CHANGED', 409);
        throw error;
    }
    if (candidate?.kind === 'checkout' && await checkoutVersion(w.cwd) !== candidate.digest) throw new ApiError('CANDIDATE_CHANGED', 409);
    if (candidate?.kind === 'test' && await gitAsync(w.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new ApiError('CANDIDATE_CHANGED', 409);
    return checked;
}

/** The caller independently confirmed exit. Remove only the exact clean detached checkout. */
export async function finishTestCheckout(queue: TaskQueue, workspace: Workspace) {
    const fd = await workspaceLock(queue.directory, workspace.id);
    try {
        const current = queue.transaction(s => s.workspaces.find(w => w.id === workspace.id), true);
        if (!current || current.testCleanup || current.cwd !== join(queue.directory, 'worktrees', current.id)
            || current.execution.candidate?.kind !== 'test' || current.sessionID !== workspace.sessionID) return;
        const save = (result: Workspace['testCleanup']) => queue.transaction(s => { s.workspaces.find(w => w.id === current.id)!.testCleanup = result; });
        if (!existsSync(current.cwd)) {
            const registered = await gitAsync(current.root, ['worktree', 'list', '--porcelain', '-z'], fd);
            if (!registered.split('\0').includes(`worktree ${current.cwd}`)) save('removed');
            else save('retained');
            return;
        }
        try {
            verifyWorkspace(current);
            if (await gitAsync(current.cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], fd)) { save('retained'); return; }
            await gitAsync(current.root, ['worktree', 'remove', '--', current.cwd], fd);
        } catch { save('retained'); return; }
        save('removed');
    } finally { closeSync(fd); }
}

/** Coordinate direct Happy starts/resumes with the Owner's final Git action. */
export async function withManagedWorkspaceLaunch<T>(directory: string, launch: () => Promise<T>,
    machines = join(userInfo().homedir,'.local/state/happy-control/machines')):Promise<T> {
    let target = resolve(directory);
    try { target=realpathSync(target); } catch { /* A reclaimed path still needs its fence checked. */ }
    const [machine, kind, id] = relative(machines,target).split('/');
    if (kind!=='worktrees' || !/^[a-f0-9]{64}$/.test(machine) || !/^[a-f0-9]{64}$/.test(id)) return launch();
    const queueDirectory=join(machines,machine);
    if (!existsSync(queueDirectory)) return launch();
    const fd=await workspaceLock(queueDirectory,id);
    try {
        const queue=new TaskQueue(queueDirectory,{}, {readOnly:true});
        const workspace=queue.transaction(state=>state.workspaces.find(w=>w.id===id),true);
        if (!workspace || (!reclaimRecord(queueDirectory,workspace) && !readReclaimRequest(queueDirectory,id))) return await launch();
        if (workspace.retirement) throw new ApiError(workspace.retirement.phase==='retired'?'WORKSPACE_RETIRED':'WORKSPACE_RETIRING',409);
        if (reclaimRequestFenced(queueDirectory,id)) throw new ApiError('WORKSPACE_RECLAIM_REQUESTED',409);
        if (workspaceIdleCloseFenced(queueDirectory,id)) throw new ApiError('WORKSPACE_IDLE_CLOSE_PENDING',409);
        return await launch();
    } finally { closeSync(fd); }
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function candidateInstruction(w: Workspace) {
    const candidate = w.execution.candidate;
    if (!candidate) return '';
    if (candidate.kind === 'checkout') return `\n\n只读验收候选为原执行目录 ${w.cwd}，内容摘要 ${candidate.digest}。读取该目录中的候选文件（含未提交和新增文件），核对摘要。候选变化或缺失时报告阻塞。`;
    if (candidate.kind === 'test') return `\n\n本次测试的候选提交为 ${candidate.commit}（tree ${w.candidateTree}）。请在隔离目录 ${w.cwd} 中运行实际测试命令 ${JSON.stringify(candidate.command)}，保留实际结果。`;
    const view = `GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1 git --git-dir=${shellQuote(w.repository)}`;
    return `\n\n请只读取绑定的提交 ${candidate.commit}（tree ${w.candidateTree}），使用如下 Git 对象查询。\n`
        + `文件列表：${view} ls-tree -r ${candidate.commit}\n`
        + `差异：${view} ${candidate.baseCommit ? `diff --no-ext-diff --no-textconv ${candidate.baseCommit} ${candidate.commit} --` : `show --no-ext-diff --no-textconv ${candidate.commit} --`}\n`
        + `文件内容：${view} cat-file blob ${candidate.commit}:<路径>（按 shell 规则引用实际路径）。对象不可读时报告阻塞。`;
}

/** Worktrees are reserved for write isolation or explicitly requested detached tests. */
export async function prepareWorkspace(queue: TaskQueue, input: { requestID: string; grantID: string; projectID: string; root: string; title?: string; execution?: unknown; options?: unknown }, authorize: () => Promise<void> = async()=>{}): Promise<Workspace> {
    const execution = executionSchema.parse(input.execution ?? {}), id = hash(`${input.grantID}\n${input.requestID}`);
    const fingerprint = hash(canonicalBody({ ...input, execution }));
    let workspace = queue.workspaces(input.grantID).find(w=>w.id===id);
    if (workspace?.retirement) throw new ApiError('WORKSPACE_RETIRED',409);
    if (workspace && workspace.fingerprint !== fingerprint) throw new ApiError('REQUEST_ID_CONFLICT',409);
    if (!workspace) {
        if (realpathSync(input.root) !== input.root) throw new ApiError('PROJECT_PATH_CHANGED',403);
        const candidate = execution.candidate;
        if (execution.mode === 'read-only' && !candidate) throw new ApiError('CANDIDATE_REQUIRED', 409);
        let repository: string = input.root, baseCommit: string | undefined, candidateTree: string | undefined;
        if (execution.mode !== 'text') try { repository = realpathSync(resolve(input.root,await gitAsync(input.root,['rev-parse','--git-common-dir']))); }
        catch { if (!['legacy','integration'].includes(execution.mode)) throw new ApiError('WORKTREE_REQUIRES_GIT'); repository = input.root; }
        if (['worktree','read-only','inspect'].includes(execution.mode)) {
            if (realpathSync(await gitAsync(input.root,['rev-parse','--show-toplevel'])) !== input.root) throw new ApiError('WORKTREE_REQUIRES_REPOSITORY_ROOT',403);
            if (candidate && candidate.kind !== 'checkout') {
                candidateTree = commitTree(input.root, candidate.commit);
                if (candidate.kind === 'commit' && candidate.baseCommit) commitTree(input.root, candidate.baseCommit);
                baseCommit = candidate.commit;
            } else if (execution.mode === 'worktree' || execution.source === 'baseline') baseCommit = await gitAsync(input.root,['rev-parse','--verify','HEAD^{commit}']);
        }
        workspace = queue.transaction(s=>{
            if (s.tasks.some(t=>t.id===id)||s.cancellations.some(c=>c.grantID===input.grantID&&c.requestID===input.requestID)) throw new ApiError('REQUEST_ID_CONFLICT',409);
            const prior=s.workspaces.find(w=>w.id===id);
            if(prior){if(prior.fingerprint!==fingerprint)throw new ApiError('REQUEST_ID_CONFLICT',409);return prior;}
            const port=20000+s.workspaces.length;if(port>60000)throw new ApiError('TASK_PORT_RANGE_EXHAUSTED');
            const temporaryDirectory = join(queue.directory, 'temporary', id);
            let cwd = input.root;
            if (execution.mode === 'worktree' || candidate?.kind === 'test') cwd = join(queue.directory, 'worktrees', id);
            if (candidate?.kind === 'commit' || restrictedExecution(execution.mode)) cwd = temporaryDirectory;
            if (candidate?.kind === 'checkout') {
                const source = s.tasks.find(t => t.grantID === input.grantID && t.requestID === candidate.requestID && t.state === 'completed');
                const w = s.workspaces.find(w => w.id === source?.workspaceID);
                if (!w || w.projectID !== input.projectID || w.root !== input.root || w.repository !== repository || w.retirement || w.execution.mode === 'read-only')
                    throw new ApiError('CANDIDATE_UNAVAILABLE', 409);
                if (reclaimRequestFenced(queue.directory,w.id)) throw new ApiError('WORKSPACE_RECLAIM_REQUESTED',409);
                if (source!.checkoutDigest && source!.checkoutDigest !== candidate.digest) throw new ApiError('CANDIDATE_CHANGED', 409);
                cwd = w.cwd;
            }
            const value: Workspace={id,fingerprint,grantID:input.grantID,projectID:input.projectID,root:input.root,repository,
                ...(queue.access.machineID ? { managedBy: { machineID: queue.access.machineID, uid: process.getuid!() } } : {}),
                cwd,branch:execution.mode === 'worktree' ? `dot-task/${id}` : undefined,baseCommit,execution,candidateTree,
                options:input.options as Record<string,unknown>|undefined,temporaryDirectory,port,stage:'preparing',preparationPID:process.pid};
            s.workspaces.push(value);return value;
        });
    }
    const fd=await workspaceLock(queue.directory,id);
    try {
        workspace=queue.workspaces(input.grantID).find(w=>w.id===id)!;
        if(workspace.stage==='preparing') {
            queue.transaction(s=>{s.workspaces.find(w=>w.id===id)!.preparationPID=process.pid;});
            const isolated = workspace.branch || workspace.execution.candidate?.kind === 'test';
            if(isolated&&!existsSync(workspace.cwd)) {
                privateDirectory(join(queue.directory,'worktrees'),true);
                await authorize();
                const mode = workspace.branch ? ['-b', workspace.branch] : ['--detach'];
                await gitAsync(input.root,['worktree','add',...mode,workspace.cwd,workspace.baseCommit!],fd);
                rememberReclaimCreation(queue.directory, workspace);
            }
            privateDirectory(workspace.temporaryDirectory,true);
            // A partially checked out/conflicting directory is retained. Never reset/force it.
            await verifyReviewCandidate(workspace);
            if(isolated && git(workspace.cwd,['status','--porcelain=v1','--untracked-files=all'])) throw new ApiError('WORKTREE_RECOVERY_REQUIRED',409);
            queue.transaction(s=>{const w=s.workspaces.find(w=>w.id===id)!;w.stage='ready';delete w.preparationError;});
        } else if (workspace.testCleanup !== 'removed') verifyWorkspace(workspace);
        const result=queue.workspaces(input.grantID).find(w=>w.id===id)!;
        rememberWorkspaceIdentity(queue,result);
        return result;
    } catch(e) {
        queue.transaction(s=>{const w=s.workspaces.find(w=>w.id===id)!;w.preparationError='WORKTREE_PREPARATION_UNCONFIRMED';});
        if (e instanceof ApiError && ['CANDIDATE_CHANGED', 'CANDIDATE_UNAVAILABLE'].includes(e.code)) queue.releaseCandidate(workspace);
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
    if (w.retirement) throw new ApiError(w.retirement.phase === 'retired' ? 'WORKSPACE_RETIRED' : 'WORKSPACE_RETIRING',409);
    if (realpathSync(w.root) !== w.root || realpathSync(w.cwd) !== w.cwd) throw new ApiError('PROJECT_PATH_CHANGED', 403);
    if (w.execution.mode === 'text') return null;
    if (canonicalRepository(w.root) !== w.repository) throw new ApiError('WORKTREE_BINDING_CHANGED',403);
    const candidate = w.execution.candidate;
    if (candidate && candidate.kind !== 'checkout' && (commitTree(w.root, candidate.commit) !== w.candidateTree
        || candidate.kind === 'commit' && candidate.baseCommit && !commitTree(w.root, candidate.baseCommit))) throw new ApiError('CANDIDATE_CHANGED', 409);
    if (candidate?.kind === 'checkout' && canonicalRepository(w.cwd) !== w.repository) throw new ApiError('CANDIDATE_CHANGED', 409);
    if (candidate?.kind === 'test' && (canonicalRepository(w.cwd) !== w.repository || gitOptional(w.cwd, ['symbolic-ref', '--quiet', 'HEAD']) !== null
        || gitOptional(w.cwd, ['rev-parse', '--verify', 'HEAD']) !== candidate.commit)) throw new ApiError('CANDIDATE_CHANGED', 409);
    if (!w.branch) return null;
    const common = realpathSync(resolve(w.cwd, git(w.cwd, ['rev-parse', '--git-common-dir'])));
    if (common !== w.repository) throw new ApiError('WORKTREE_BINDING_CHANGED', 403);
    const branch = gitOptional(w.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch === null || branch === gitOptional(w.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        || gitOptional(w.cwd, ['merge-base', '--is-ancestor', w.baseCommit!, 'HEAD']) === null)
        throw new ApiError('WORKTREE_BINDING_CHANGED', 403);
    return { branch };
}
export function workspaceResources(w?: Pick<Workspace,'repository'|'root'|'cwd'|'execution'>, sessionID?: string): Resource[] {
    // Unknown pre-queue execution remains conservative. Known executions count
    // project slots by repository and serialize writes only to the actual checkout.
    const result: Resource[] = [{ key: 'machine', mode: !w ? 'exclusive' : 'shared' }];
    if (w && w.execution.mode !== 'text') {
        // Repository identity counts project slots. Only writers sharing an actual
        // checkout exclude each other; independent worktrees can keep progressing.
        result.push({ key: `repo:${hash(w.repository)}`, mode: 'shared' });
        if (w.execution.mode === 'inspect') {
            if (w.execution.source === 'checkout') result.push({ key: `checkout:${hash(w.root)}`, mode: 'shared' });
        } else if (w.execution.candidate?.kind !== 'commit') {
            result.push({ key: `checkout:${hash(w.cwd)}`, mode: w.execution.mode === 'read-only' ? 'shared' : 'exclusive' });
        }
        result.push(...w.execution.resources.map(key => ({ key: `declared:${key}`, mode: 'exclusive' as const })));
    }
    if (sessionID) result.push({ key: `session:${sessionID}`, mode: 'exclusive' });
    return result;
}

/** @deprecated A boolean process callback is not disposition or retirement authority. */
export function cleanCompletedWorkspace(_queue: TaskQueue, _id: string, _processStopped: () => boolean = () => false): never {
    throw new ApiError('WORKTREE_LIFECYCLE_POLICY_REQUIRED',403);
}

/** The assigned branch is the creation name, not necessarily the checked-out one. Report
 * both so a reviewer is not sent to a branch the task already moved away from.
 */
export function workspaceBranch(w: Workspace) {
    return w.branch ? gitOptional(w.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) : null;
}

export function workspaceResult(w: Workspace) {
    verifyWorkspace(w);
    if (restrictedExecution(w.execution.mode) || w.repository === w.root || w.execution.candidate?.kind === 'commit') return {};
    return { resultCommit: git(w.cwd,['rev-parse','--verify','HEAD^{commit}']), worktreeDirty: Boolean(git(w.cwd,['status','--porcelain=v1','--untracked-files=all'])) };
}

// A snapshot is captured after the scheduler reserves the checkout and before
// dispatch. The session only gets a read tool for this sealed directory.
const snapshotScript = String.raw`
import contextlib, hashlib, json, os, stat, subprocess, sys
dest, commit = sys.argv[1:]
def git(*args):
 return subprocess.check_output(['git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',*args])
def allowed(name):
 return not any(p in (b'',b'.',b'..',b'.git',b'.env') or p.startswith(b'.env.') for p in name.split(b'/'))
def source_file(name):
 parts=name.split(b'/')
 fd=os.open('.',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts[:-1]:
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd)
   fd=child
  return os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 finally:
  os.close(fd)
def save(name, f, size):
 global budget
 sample_size=min(size,8192)
 sample=f.read(sample_size)
 if len(sample)!=sample_size: raise RuntimeError('snapshot_short_read')
 binary=b'\0' in sample
 if not binary:
  budget-=size
  if budget<0: raise RuntimeError('snapshot_limit')
  if not allowed(name): raise RuntimeError('snapshot_path_invalid')
  target=os.path.join(os.fsencode(dest),name)
  os.makedirs(os.path.dirname(target),exist_ok=True)
 digest=hashlib.sha256(sample)
 with contextlib.nullcontext() if binary else open(target,'xb') as out:
  if out: out.write(sample)
  remaining=size-sample_size
  while remaining:
   data=f.read(min(remaining,1048576))
   if not data: raise RuntimeError('snapshot_short_read')
   remaining-=len(data)
   digest.update(data)
   if out: out.write(data)
 return digest.hexdigest()
budget=128*1024*1024
if commit:
 names=git('ls-tree','-rz','--full-tree',commit).split(b'\0')
 if len(names)>50001: raise RuntimeError('snapshot_limit')
 with subprocess.Popen(['git','cat-file','--batch'],stdin=subprocess.PIPE,stdout=subprocess.PIPE) as child:
  for record in filter(None,names):
   meta,name=record.split(b'\t',1)
   mode,kind,oid=meta.split()
   if mode not in (b'100644',b'100755') or kind!=b'blob' or not allowed(name): continue
   child.stdin.write(oid+b'\n')
   child.stdin.flush()
   obj,typ,size=child.stdout.readline().split()
   if obj!=oid or typ!=b'blob': raise RuntimeError('snapshot_object_invalid')
   save(name,child.stdout,int(size))
   if child.stdout.read(1)!=b'\n': raise RuntimeError('snapshot_object_invalid')
  child.stdin.close()
  if child.wait()!=0: raise RuntimeError('snapshot_git_failed')
else:
 names=sorted(set(git('ls-files','--cached','--others','--exclude-standard','-z').split(b'\0'))-{b''})
 if len(names)>50000: raise RuntimeError('snapshot_limit')
 rows=[]
 for name in names:
  if not allowed(name): continue
  try: info=os.lstat(name)
  except FileNotFoundError: rows.append([name.hex(),'missing']);continue
  if stat.S_ISLNK(info.st_mode):
   rows.append([name.hex(),'symlink',bool(info.st_mode&0o111),hashlib.sha256(os.readlink(name)).hexdigest()])
   continue
  with os.fdopen(source_file(name),'rb') as f:
   info=os.fstat(f.fileno())
   if not stat.S_ISREG(info.st_mode): raise RuntimeError('snapshot_special_file')
   rows.append([name.hex(),'file',bool(info.st_mode&0o111),save(name,f,info.st_size)])
 head=git('rev-parse','HEAD').strip().decode('ascii')
 value=json.dumps({'head':head,'files':rows},ensure_ascii=True,separators=(',',':')).encode('ascii')
 print('sha256:'+hashlib.sha256(value).hexdigest())
`;

export async function prepareInspection(workspace: Workspace) {
    if (workspace.execution.mode !== 'inspect') return;
    const destination = join(workspace.cwd, 'source');
    if (existsSync(destination)) {
        if (!lstatSync(destination).isDirectory()) throw new ApiError('INSPECTION_SOURCE_UNAVAILABLE',409);
        return;
    }
    const staging = mkdtempSync(join(workspace.cwd, 'source-'));
    try {
        const baseline = workspace.execution.source === 'baseline';
        const before = baseline ? undefined : await checkoutVersion(workspace.root);
        const { stdout } = await exec('python3', ['-c', snapshotScript, staging, baseline ? workspace.baseCommit! : ''], {
            cwd: workspace.root, env: gitEnvironment(), timeout: 60000, maxBuffer: 4096,
        });
        if (!baseline && (stdout.trim() !== before || await checkoutVersion(workspace.root) !== before))
            throw new ApiError('CANDIDATE_CHANGED',409);
        renameSync(staging, destination);
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError('INSPECTION_SOURCE_UNAVAILABLE',409);
    } finally {
        rmSync(staging,{recursive:true,force:true});
    }
}
