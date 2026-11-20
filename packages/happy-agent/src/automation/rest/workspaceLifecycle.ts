import { closeSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { workspacePlanSchema, workspaceDispositionSchema, workspaceOperationSchema, type WorkspaceItem } from '@slopus/happy-wire';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { ApiError } from './schema';
import { MetadataStore } from './store';
import { privateDirectory } from './privateFs';
import { TaskQueue, terminalTask, holdsReviewCheckout, type Workspace, type QueueTask } from './taskQueue';
import { workspaceGit, workspaceLock } from './taskWorkspaces';
import { retirementProcessProof } from './sessionProcessProofs';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const absolute = z.string().max(4096).refine(s => isAbsolute(s) && resolve(s) === s && !/[\x00-\x1f]/.test(s));
export const workspacePolicySchema = z.object({ version: z.literal(1), id, machineID: id, grantID: id, projectID: id,
    root: absolute, mainRef: z.literal('refs/heads/main'), remote: id.optional(),
    protectedDirectories: z.array(absolute).max(100).default([]), allowApply: z.boolean().default(false),
    allowArchive: z.boolean().default(false), allowDiscard: z.boolean().default(false),
}).strict();
export type WorkspacePolicy = z.input<typeof workspacePolicySchema>;
export type Activity = { confirmed: boolean; blockers: string[]; fingerprint: string };
export type ActivityProbe = (workspace: Workspace, tasks: Pick<QueueTask,'processID'|'sessionID'>[]) => Promise<Activity>;
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
const overlaps = (a: string, b: string) => inside(a,b) || inside(b,a);
const fingerprint = (value: unknown) => hash(canonicalBody(value));
function error(code: string): never { throw new ApiError(code,409); }

/** Cold, local operator probe. An unreadable process/namespace is uncertainty, not absence.
 * No argv, environment, process name or unrelated task data is returned to callers.
 */
export async function linuxWorkspaceActivity(workspace:Workspace,tasks:Pick<QueueTask,'processID'|'sessionID'>[],queueDirectory?:string,machineID?:string):Promise<Activity> {
    const blockers = new Set<string>(), identities: string[] = [];
    if (process.platform !== 'linux') return { confirmed: false, blockers: ['activity_platform_unconfirmed'], fingerprint: '' };
    try {
        const names = readdirSync('/proc').filter(n => /^\d+$/.test(n));
        if (names.length > 32768) throw Error();
        const mounts = new Set<string>(), knownPids = new Set(tasks.map(t=>t.processID).filter(Boolean)), groups = new Set<number>();
        const sessions=new Set([...tasks.map(t=>t.sessionID),...(workspace.sessionID?[workspace.sessionID]:[])]);
        for(const sessionID of sessions) {
            const proof=queueDirectory&&machineID?retirementProcessProof(join(queueDirectory,'session-process-proofs'),machineID,sessionID,workspace):null;
            if(!proof)blockers.add('session_mapping_unconfirmed');
            else {knownPids.add(proof.pid);groups.add(proof.processGroup!);}
        }
        if(!sessions.size||blockers.has('session_mapping_unconfirmed'))return {confirmed:false,blockers:['session_mapping_unconfirmed'],fingerprint:''};
        let inspected=0;
        for (const name of names) {
            if(++inspected%64===0)await new Promise<void>(resolve=>setImmediate(resolve));
            try {
                const path = `/proc/${name}`, first = readFileSync(path+'/stat','utf8');
                const fields = first.slice(first.lastIndexOf(')')+2).split(/\s+/);
                if (['Z','X'].includes(fields[0])) continue;
                const cwd = readlinkSync(path+'/cwd');
                if (inside(cwd,workspace.cwd) || knownPids.has(Number(name)) || groups.has(Number(fields[2]))) blockers.add('live_session_or_process');
                const args = readFileSync(path+'/cmdline');
                if (args.includes(Buffer.from(workspace.cwd))) blockers.add('process_entrypoint_reference');
                if([...sessions].some(sessionID=>args.toString('utf8').split('\0').includes(sessionID)))blockers.add('live_session_or_process');
                for (const fd of readdirSync(path+'/fd')) {
                    try { if (inside(readlinkSync(path+'/fd/'+fd).replace(/ \(deleted\)$/,''),workspace.cwd)) blockers.add('open_file_reference'); }
                    catch (e) { if (!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
                }
                const namespace = readlinkSync(path+'/ns/mnt');
                if (!mounts.has(namespace)) {
                    mounts.add(namespace);
                    for (const line of readFileSync(path+'/mountinfo','utf8').split('\n').filter(Boolean)) {
                        const parts = line.split(' '), decode = (s: string) => s.replace(/\\([0-7]{3})/g,(_,oct)=>String.fromCharCode(parseInt(oct,8)));
                        const source = decode(parts[3]), target = decode(parts[4]);
                        if (inside(target,workspace.cwd) || source !== '/' && overlaps(source,workspace.cwd)) blockers.add('mount_reference');
                    }
                }
                const last = readFileSync(path+'/stat','utf8');
                if (last.slice(last.lastIndexOf(')')+2).split(/\s+/)[19] !== fields[19]) throw Error();
                identities.push(`${name}:${fields[19]}:${cwd}:${namespace}`);
            } catch (e) {
                if (!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) blockers.add('process_visibility_unconfirmed');
            }
        }
        return { confirmed: !blockers.has('process_visibility_unconfirmed')&&!blockers.has('session_mapping_unconfirmed'), blockers: [...blockers].sort(), fingerprint: fingerprint(identities.sort()) };
    } catch { return { confirmed: false, blockers: ['activity_visibility_unconfirmed'], fingerprint: '' }; }
}

const dispositionSchema = workspaceDispositionSchema.extend({ retainedRef: z.string().max(256), source: z.string().min(1).max(200) });
const operationSchema = workspaceOperationSchema;
const recordSchema = z.object({ version: z.literal(1), binding: digest, revision: z.number().int().nonnegative(),
    disposition: dispositionSchema.optional(), operations: z.array(operationSchema).max(16), checkedAt: z.number().optional(),
}).strict();
type Record = z.infer<typeof recordSchema>;
const planSchema = workspacePlanSchema;
export type WorkspacePlan = z.infer<typeof planSchema>;
type Snapshot = { workspace: Workspace; tasks: QueueTask[]; related: QueueTask[]; others: Workspace[] };
type GitState = { head: string; branch: string; mainCommit: string; remoteCommit?: string; dirty: boolean; ignored: boolean;
    registry: string; identity: string; digest: string; checkout:string };

/** One owner-authoritative lifecycle record per workspace, with bounded operation receipts.
 * This interface does not commit, merge, push, stop sessions or grant remote deletion rights.
 */
export class WorkspaceLifecycle {
    readonly policy: z.infer<typeof workspacePolicySchema>;
    private readonly policyHash: string;
    private readonly activity: ActivityProbe;
    constructor(readonly queue: TaskQueue, policy: WorkspacePolicy,
        activity?: ActivityProbe, private now = Date.now,
        private git = workspaceGit, private authorize: () => void | Promise<void> = () => {}, private authorizationCurrent: () => void = () => {}) {
        this.policy = workspacePolicySchema.parse(policy); this.policyHash = fingerprint(this.policy);
        this.activity=activity??((w,t)=>linuxWorkspaceActivity(w,t,queue.directory,this.policy.machineID));
        if (queue.access.machineID !== this.policy.machineID) error('WORKSPACE_MACHINE_MISMATCH');
    }
    private snapshot(workspaceID: string): Snapshot {
        digest.parse(workspaceID);
        return this.queue.transaction(s => {
            const w = s.workspaces.find(w=>w.id===workspaceID);
            if (!w || w.grantID!==this.policy.grantID || w.projectID!==this.policy.projectID || w.root!==this.policy.root) error('WORKSPACE_SCOPE_DENIED');
            return { workspace: w!, tasks: s.tasks.filter(t=>t.workspaceID===workspaceID),
                related: s.tasks.filter(t=>(!terminalTask(t) || holdsReviewCheckout(t)) && (t.sessionID===w!.sessionID || t.resources.some(r=>r.key===`checkout:${hash(w!.cwd)}`
                    || r.mode==='exclusive'&&(r.key==='machine'||r.key===`repo:${hash(w!.repository)}`)))),
                others: s.workspaces.filter(other=>other.id!==workspaceID && other.retirement?.phase!=='retired'
                    && other.execution.candidate?.kind !== 'checkout' && overlaps(other.cwd,w!.cwd)) };
        },true);
    }
    private binding(w: Workspace) { return fingerprint({ id:w.id, grant:w.grantID, project:w.projectID, root:w.root, cwd:w.cwd,
        repository:w.repository, base:w.baseCommit, creationBranch:w.branch, fingerprint:w.fingerprint, session:w.sessionID, manager:w.managedBy }); }
    private store(create = false) {
        const directory = join(this.queue.directory,'workspace-lifecycle');
        if (!create && !lstatSync(directory,{throwIfNoEntry:false})) return null;
        return new MetadataStore(directory,128*1024,create);
    }
    private read(w: Workspace): Record {
        const raw = this.store()?.get<unknown>(`workspace:${w.id}`);
        const present=lstatSync(join(this.queue.directory,'workspace-lifecycle',hash(`workspace:${w.id}`)+'.json'),{throwIfNoEntry:false});
        const value = present || raw!==null&&raw!==undefined ? recordSchema.parse(raw) : { version:1 as const, binding:this.binding(w),revision:0,operations:[] };
        if (value.binding!==this.binding(w)) error('WORKSPACE_METADATA_CHANGED');
        return value;
    }
    private write(w: Workspace, record: Record) { this.store(true)!.set(`workspace:${w.id}`,recordSchema.parse(record)); }
    private receipt(record: Record, operationID: string, fp: string) {
        const previous = record.operations.find(op=>op.id===operationID);
        if (previous && previous.fingerprint!==fp) error('WORKSPACE_OPERATION_CONFLICT');
        return previous;
    }
    private add(record: Record, operation: z.infer<typeof operationSchema>) {
        if (record.operations.length>=16) error('WORKSPACE_OPERATION_LIMIT');
        record.operations.push(operation); record.checkedAt=this.now();
    }
    private ownership(w: Workspace, legacy = false) {
        absolute.parse(this.queue.directory);
        privateDirectory(this.queue.directory);
        if (realpathSync(this.queue.directory)!==this.queue.directory || w.cwd!==join(this.queue.directory,'worktrees',w.id)
            || !w.branch || !w.baseCommit || w.repository===w.root || w.stage!=='ready') error('WORKTREE_NOT_MANAGED');
        if (!legacy && (!w.managedBy || w.managedBy.machineID!==this.policy.machineID || w.managedBy.uid!==process.getuid!())) error('WORKSPACE_OWNER_UNCONFIRMED');
        if (w.managedBy && (w.managedBy.machineID!==this.policy.machineID || w.managedBy.uid!==process.getuid!())) error('WORKSPACE_OWNER_MISMATCH');
        if (realpathSync(w.root)!==w.root || realpathSync(w.repository)!==w.repository) error('WORKSPACE_PATH_CHANGED');
        if (overlaps(w.cwd,w.root) || overlaps(w.cwd,w.repository) || inside(realpathSync(process.cwd()),w.cwd)
            || this.policy.protectedDirectories.some(p=>overlaps(w.cwd,existsSync(p)?realpathSync(p):p))) error('WORKSPACE_PROTECTED_DIRECTORY');
        if (w.temporaryDirectory!==join(this.queue.directory,'temporary',w.id)) error('WORKSPACE_TEMP_BINDING_CHANGED');
        if (existsSync(w.temporaryDirectory)) {
            privateDirectory(w.temporaryDirectory);
            if (readdirSync(w.temporaryDirectory).length) error('WORKSPACE_TEMPORARY_ARTIFACTS');
        }
    }
    private async registry(w: Workspace) {
        const common = realpathSync(resolve(w.root,await this.git(w.root,['rev-parse','--git-common-dir'])));
        if (common!==w.repository || realpathSync(join(common,'objects'))!==join(common,'objects')
            ||lstatSync(join(common,'objects','info','alternates'),{throwIfNoEntry:false})) error('WORKSPACE_OBJECT_STORE_UNCONFIRMED');
        return this.git(w.root,['worktree','list','--porcelain']);
    }
    private entry(registry: string, cwd: string) {
        const entries=registry.split('\n\n').filter(block=>block.split('\n')[0]===`worktree ${cwd}`);
        if(entries.length>1)error('WORKSPACE_REGISTRY_CHANGED');return entries[0];
    }
    private async inspectGit(w: Workspace, legacy = false): Promise<GitState> {
        this.ownership(w,legacy);
        if (realpathSync(w.cwd)!==w.cwd || lstatSync(w.cwd).uid!==process.getuid!() || !lstatSync(w.cwd).isDirectory()
            || !lstatSync(join(w.cwd,'.git')).isFile()) error('WORKSPACE_PATH_CHANGED');
        const registry = await this.registry(w), entry=this.entry(registry,w.cwd);
        if (!entry || /\n(?:locked|prunable)(?: |$)/.test(entry)) error('WORKSPACE_REGISTRY_CHANGED');
        const common = realpathSync(resolve(w.cwd,await this.git(w.cwd,['rev-parse','--git-common-dir'])));
        if (common!==w.repository || realpathSync(await this.git(w.cwd,['rev-parse','--show-toplevel']))!==w.cwd) error('WORKSPACE_REGISTRY_CHANGED');
        const gitdir=await this.git(w.cwd,['rev-parse','--absolute-git-dir']);
        if(realpathSync(gitdir)!==gitdir||resolve(gitdir,'..')!==join(w.repository,'worktrees')
            ||readFileSync(join(gitdir,'gitdir'),'utf8').trim()!==join(w.cwd,'.git'))error('WORKSPACE_REGISTRY_CHANGED');
        const ordinary=new Set(['HEAD','index','commondir','gitdir','ORIG_HEAD','COMMIT_EDITMSG','logs']);
        if(readdirSync(gitdir).some(name=>!ordinary.has(name))
            ||existsSync(join(gitdir,'logs'))&&readdirSync(join(gitdir,'logs')).some(name=>name!=='HEAD'))error('WORKSPACE_GITDIR_ARTIFACTS');
        let branch:string;try{branch=await this.git(w.cwd,['symbolic-ref','--quiet','--short','HEAD']);}catch{error('WORKSPACE_HEAD_UNREFERENCED');}
        let rootBranch='';try {rootBranch=await this.git(w.root,['symbolic-ref','--quiet','--short','HEAD']);}catch { /* Detached root is allowed. */ }
        if (branch===rootBranch||`refs/heads/${branch}`===this.policy.mainRef) error('WORKSPACE_ROOT_BRANCH');
        const head=await this.git(w.cwd,['rev-parse','--verify','HEAD^{commit}']);
        if(!entry!.split('\n').includes(`HEAD ${head}`)||!entry!.split('\n').includes(`branch refs/heads/${branch}`))error('WORKSPACE_REGISTRY_CHANGED');
        await this.git(w.cwd,['merge-base','--is-ancestor',w.baseCommit!,head]);
        await this.git(w.cwd,['cat-file','-e',head+'^{tree}']);
        // Worktree-local HEAD reflogs disappear with the directory. Do not lose a
        // dropped/rebased result that exists only there, even if today's HEAD is main.
        const reflog=(await this.git(w.cwd,['reflog','show','--format=%H','-n','1001','HEAD'])).split('\n').filter(Boolean);
        if(reflog.length>1000)error('WORKSPACE_REFLOG_UNCONFIRMED');
        if(reflog.length&&await this.git(w.cwd,['rev-list','--max-count=1',...new Set(reflog),'--not','--single-worktree','--all']))error('WORKSPACE_REFLOG_ONLY_RESULTS');
        const messageHeads=new Set([head,...reflog]);
        if(existsSync(join(gitdir,'ORIG_HEAD'))){
            const original=readFileSync(join(gitdir,'ORIG_HEAD'),'utf8');
            if(!/^[a-f0-9]{40,64}\n?$/.test(original))error('WORKSPACE_GITDIR_ARTIFACTS');
            if(await this.git(w.cwd,['rev-list','--max-count=1',original.trim(),'--not','--single-worktree','--all']))error('WORKSPACE_GITDIR_ONLY_RESULTS');
            messageHeads.add(original.trim());
        }
        if(existsSync(join(gitdir,'COMMIT_EDITMSG'))
            &&!(await this.git(w.cwd,['show','-s','--format=%B%x00',...messageHeads])).split('\0').map(text=>text.trim())
                .includes(readFileSync(join(gitdir,'COMMIT_EDITMSG'),'utf8').trim()))error('WORKSPACE_GITDIR_ARTIFACTS');
        const mainCommit=await this.git(w.root,['rev-parse','--verify',this.policy.mainRef+'^{commit}']);
        let remoteCommit: string|undefined;
        if (this.policy.remote) {
            let rows:string;try{rows=await this.git(w.root,['ls-remote','--heads','--',this.policy.remote,this.policy.mainRef]);}catch{error('WORKSPACE_REMOTE_UNCONFIRMED');}
            if (!rows || rows.split('\n').length!==1) error('WORKSPACE_REMOTE_UNCONFIRMED');
            remoteCommit=rows.split(/\s+/)[0];commit.parse(remoteCommit);
            await this.git(w.root,['cat-file','-e',remoteCommit+'^{commit}']);
        }
        const indexFlags=await this.git(w.cwd,['ls-files','-v']);
        if(indexFlags.split('\n').some(line=>/^[a-zS] /.test(line)))error('WORKSPACE_INDEX_FLAGS_UNCONFIRMED');
        if((await this.git(w.cwd,['ls-files','--stage'])).split('\n').some(line=>line.startsWith('160000 ')))error('WORKSPACE_SUBMODULES_RETAINED');
        const status=await this.git(w.cwd,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']);
        const ignored=await this.git(w.cwd,['ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory']);
        const st=lstatSync(w.cwd), identity=`${st.dev}:${st.ino}:${lstatSync(join(w.cwd,'.git')).ino}`;
        const result={head,branch,mainCommit,remoteCommit,dirty:Boolean(status),ignored:Boolean(ignored),registry:entry!,identity};
        return {...result,digest:fingerprint({...result,status,ignored}),checkout:fingerprint({head,branch,status,ignored,entry,identity})};
    }
    private taskDigest(s: Snapshot) {
        return fingerprint({tasks:s.tasks.map(t=>({id:t.id,state:t.state,dispatched:t.dispatched,session:t.sessionID,process:t.processID,
            result:t.resultCommit,dirty:t.worktreeDirty,seq:t.seq,turn:t.turnID})), related:s.related.map(t=>({id:t.id,state:t.state})), others:s.others.map(w=>w.id)});
    }
    private runtimeReasons(s: Snapshot) {
        const reasons:string[]=[];
        if (!s.tasks.length || s.tasks.some(t=>!terminalTask(t)) || s.related.length || s.others.length) reasons.push('queued_running_or_recovery_reference');
        if (s.tasks.some(t=>t.dispatched&&!t.resultCommit)) reasons.push('result_unconfirmed');
        return reasons;
    }
    async inventory(limit = 20, after = '') {
        if (!Number.isInteger(limit)||limit<1||limit>50) error('WORKSPACE_PAGE_LIMIT');
        const registered=this.queue.transaction(s=>s.workspaces.filter(w=>w.grantID===this.policy.grantID&&w.projectID===this.policy.projectID&&w.root===this.policy.root
            && !w.execution.candidate).sort((a,b)=>a.id.localeCompare(b.id)),true);
        const rows=[...new Map(registered.map(w=>[w.cwd,w])).values()].sort((a,b)=>a.id.localeCompare(b.id));
        const page=rows.filter(w=>w.id>after).slice(0,limit);
        const items=page.map(w=>{const r=this.read(w);return {id:w.id,projectID:w.projectID,directory:w.cwd,baseCommit:w.baseCommit,
            branch:w.branch,revision:r.revision,state:w.retirement?.phase??(!w.managedBy?'legacy_unconfirmed':r.disposition?'resolved':'pending_disposition'),
            disposition:r.disposition, lastVerification:r.checkedAt, lastOperation:r.operations.at(-1)};});
        const pageCounts: {[state:string]:number}={};for(const item of items)pageCounts[item.state]=(pageCounts[item.state]??0)+1;
        return {total:rows.length,returned:items.length,pageCounts,items,next:rows.filter(w=>w.id>after).length>limit?page.at(-1)!.id:null};
    }
    /** Owner UI projection: identifiers/status only, never task text or credentials. */
    overview(workspaceID: string): WorkspaceItem {
        const s = this.snapshot(workspaceID), w = s.workspace, r = this.read(w);
        return { id: w.id, projectID: w.projectID, directory: w.cwd, branch: w.branch, baseCommit: w.baseCommit,
            revision: r.revision, managed: !!w.managedBy, state: w.retirement?.phase ?? (!w.managedBy ? 'legacy_unconfirmed' : r.disposition ? 'resolved' : 'pending_disposition'),
            reasons: [...this.runtimeReasons(s), ...(!w.managedBy ? ['WORKSPACE_OWNER_UNCONFIRMED'] : [])],
            taskCount: s.tasks.length, tasks: s.tasks.slice(-20).map(t => ({ id: t.id, sessionID: t.sessionID, state: t.state, resultCommit: t.resultCommit })),
            disposition: r.disposition, lastVerification: r.checkedAt, lastOperation: r.operations.at(-1) };
    }
    async detail(workspaceID: string) {
        const item = this.overview(workspaceID), plan = await this.plan(workspaceID);
        let inspectedHead = plan.head, adoptionVerified = false;
        if (!item.managed && plan.workspaceState === 'active') {
            try { inspectedHead = (await this.inspectGit(this.snapshot(workspaceID).workspace, true)).head; adoptionVerified = true; }
            catch { /* Missing/unsafe legacy ownership remains unconfirmed, never auto-adopted. */ }
        }
        return { item: { ...item, reasons: plan.reasons }, plan, inspectedHead, adoptionVerified, result: this.result(workspaceID, undefined, true) };
    }
    async plan(workspaceID: string): Promise<WorkspacePlan> {
        const s=this.snapshot(workspaceID),w=s.workspace,r=this.read(w),reasons=this.runtimeReasons(s);
        let state:GitState|undefined;
        try {
            state=await this.inspectGit(w);
            if(state.dirty)reasons.push('staged_unstaged_or_untracked');
            if(state.ignored)reasons.push('ignored_artifacts');
            if(!r.disposition||r.disposition.head!==state.head)reasons.push(state.head===w.baseCommit?'no_change_needs_resolution':'result_needs_disposition');
            else {
                if(r.disposition.policy!==this.policyHash)reasons.push('policy_changed_reverify_disposition');
                if(r.disposition.mainCommit!==state.mainCommit||r.disposition.remoteCommit!==state.remoteCommit)reasons.push('target_main_changed_reverify_disposition');
                if(r.disposition.taskDigest!==this.taskDigest(s))reasons.push('result_changed_reverify_disposition');
                if(await this.git(w.root,['rev-parse','--verify',r.disposition.retainedRef])!==state.head)reasons.push('retained_ref_changed');
            }
            const activity=await this.activity(w,s.tasks);
            if(!activity.confirmed)reasons.push('activity_unconfirmed');reasons.push(...activity.blockers);
        } catch(e) {reasons.push(e instanceof ApiError?e.code:'git_or_path_unconfirmed');}
        if(w.retirement)reasons.push(w.retirement.phase==='retired'?'already_retired':'retirement_in_progress');
        if(!this.policy.allowApply)reasons.push('policy_apply_disabled');
        const checkedAt=this.now();
        const body:Omit<WorkspacePlan,'id'>={version:1 as const,policy:this.policyHash,workspaceID,revision:r.revision,checkedAt,expiresAt:checkedAt+60000,
            workspaceState:w.retirement?.phase??'active',
            outcome:(!state?'unknown':state.dirty||state.ignored?'pending_commit':r.disposition?.head===state.head?'resolved':state.head===w.baseCommit?'no_change_unreviewed':'pending_integration') as WorkspacePlan['outcome'],
            eligible:reasons.length===0,reasons:[...new Set(reasons)].sort(),binding:this.binding(w),git:state?.digest??fingerprint(null),tasks:this.taskDigest(s),
            head:state?.head,branch:state?.branch,mainCommit:state?.mainCommit,remoteCommit:state?.remoteCommit,checkout:state?.checkout};
        return {...body,id:fingerprint(body)};
    }
    private async locked<T>(workspaceID:string,action:(fd:number)=>Promise<T>) {
        const fd=await workspaceLock(this.queue.directory,workspaceID);
        try {return await action(fd);} finally {closeSync(fd);}
    }
    async adopt(workspaceID:string,operationID:string,expectedRevision:number,expectedHead:string) {
        if(this.queue.access.readOnly)error('WORKSPACE_READ_ONLY');
        id.parse(operationID);commit.parse(expectedHead);
        return this.locked(workspaceID,async()=>{
            await this.authorize();
            const s=this.snapshot(workspaceID),w=s.workspace,r=this.read(w),fp=fingerprint({action:'adopt',policy:this.policyHash,workspaceID,expectedRevision,expectedHead});
            const old=this.receipt(r,operationID,fp);if(old)return old;
            if(r.operations.length>=16)error('WORKSPACE_OPERATION_LIMIT');
            if(r.revision!==expectedRevision||w.retirement)error('WORKSPACE_REVISION_CHANGED');
            const state=await this.inspectGit(w,true);if(state.head!==expectedHead)error('WORKSPACE_HEAD_CHANGED');
            await this.authorize();
            const next={...w,managedBy:{machineID:this.policy.machineID,uid:process.getuid!()}};
            // Persist ownership first under the existing queue authority; no task state is rewritten.
            this.queue.transaction(q=>{const current=q.workspaces.find(x=>x.id===w.id)!;if(this.binding(current)!==this.binding(w))error('WORKSPACE_REVISION_CHANGED');current.managedBy=next.managedBy;});
            r.binding=this.binding(next);r.revision++;const receipt={id:operationID,fingerprint:fp,state:'adopted' as const,revision:r.revision};this.add(r,receipt);this.write(next,r);return receipt;
        });
    }
    async resolve(workspaceID:string,input:{operationID:string;expectedRevision:number;head:string;kind:z.infer<typeof dispositionSchema>['kind'];source:string}) {
        if(this.queue.access.readOnly)error('WORKSPACE_READ_ONLY');
        id.parse(input.operationID);commit.parse(input.head);z.string().min(1).max(200).parse(input.source);
        return this.locked(workspaceID,async()=>{
            await this.authorize();
            const s=this.snapshot(workspaceID),w=s.workspace,r=this.read(w),fp=fingerprint({action:'resolve',policy:this.policyHash,workspaceID,...input});
            const old=this.receipt(r,input.operationID,fp);if(old)return old;
            if(r.operations.length>=16)error('WORKSPACE_OPERATION_LIMIT');
            if(r.revision!==input.expectedRevision||w.retirement)error('WORKSPACE_REVISION_CHANGED');
            const state=await this.inspectGit(w);
            if(state.head!==input.head)error('WORKSPACE_HEAD_CHANGED');
            if(state.dirty||state.ignored)error('WORKSPACE_UNSAVED_ARTIFACTS');
            if(this.runtimeReasons(s).length)error('WORKSPACE_RESULT_UNCONFIRMED');
            if(state.remoteCommit&&state.remoteCommit!==state.mainCommit)error('WORKSPACE_MAIN_REMOTE_DIVERGED');
            for(const task of s.tasks)if(task.resultCommit){
                try{await this.git(w.root,['merge-base','--is-ancestor',task.resultCommit,state.head]);}
                catch{error('WORKSPACE_RESULT_HISTORY_UNCONFIRMED');}
            }
            let proof:z.infer<typeof dispositionSchema>['proof']='retained-ref';
            if(input.kind==='no-change'&&state.head!==w.baseCommit)error('WORKSPACE_NOT_UNCHANGED');
            if(['integrated','no-change'].includes(input.kind)) {
                const target=state.remoteCommit??state.mainCommit;
                try {await this.git(w.root,['merge-base','--is-ancestor',state.head,target]);proof='ancestor';}
                catch {
                    if(input.kind==='no-change')error('WORKSPACE_NOT_IN_MAIN');
                    await this.git(w.root,['merge-base','--is-ancestor',w.baseCommit!,target]);
                    if(await this.git(w.root,['rev-list','--merges',`${target}..${state.head}`]))error('WORKSPACE_EQUIVALENCE_UNCONFIRMED');
                    const cherry=await this.git(w.root,['cherry',target,state.head,w.baseCommit!]);
                    const count=Number(await this.git(w.root,['rev-list','--count',`${target}..${state.head}`]));
                    if(!cherry||cherry.split('\n').length!==count||cherry.split('\n').some(line=>!line.startsWith('- ')))error('WORKSPACE_NOT_IN_MAIN');
                    proof='patch-equivalent';
                }
            } else if(input.kind==='archived'?!this.policy.allowArchive:input.kind==='discarded'?!this.policy.allowDiscard:true)error('WORKSPACE_DISPOSITION_NOT_AUTHORIZED');
            const retainedRef=`refs/happy/workspaces/${w.id}/${state.head}`;
            await this.authorize();
            let previous='';try{previous=await this.git(w.root,['rev-parse','--verify',retainedRef]);}catch{/* New recovery ref. */}
            if(previous&&previous!==state.head)error('WORKSPACE_RETAINED_REF_CHANGED');
            if(!previous)await this.git(w.root,['update-ref',retainedRef,state.head,'0'.repeat(state.head.length)]);
            const latest=[...s.tasks].sort((a,b)=>b.order-a.order)[0];
            r.disposition=dispositionSchema.parse({kind:input.kind,head:state.head,mainCommit:state.mainCommit,remoteCommit:state.remoteCommit,
                retainedRef,proof,policy:this.policyHash,source:input.source,recordedAt:this.now(),taskDigest:this.taskDigest(s),sourceTaskID:latest.id,sourceRequestID:latest.requestID});
            r.revision++;const receipt={id:input.operationID,fingerprint:fp,state:'resolved' as const,revision:r.revision,head:state.head,retainedRef};this.add(r,receipt);this.write(w,r);return receipt;
        });
    }
    async apply(raw:WorkspacePlan,operationID:string) {
        if(this.queue.access.readOnly)error('WORKSPACE_READ_ONLY');
        id.parse(operationID);const parsed=planSchema.safeParse(raw);if(!parsed.success)error('WORKSPACE_PLAN_INVALID');
        const plan=parsed.data!,{id:planID,...body}=plan;
        if(planID!==fingerprint(body)||plan.policy!==this.policyHash)error('WORKSPACE_PLAN_INVALID');
        return this.locked(plan.workspaceID,async(fd)=>{
            await this.authorize();
            const s=this.snapshot(plan.workspaceID),w=s.workspace,r=this.read(w),fp=fingerprint({action:'apply',policy:this.policyHash,planID,operationID});
            let op=this.receipt(r,operationID,fp);
            if(op&&op.state!=='applying'){
                if(op.state==='failed'&&w.retirement?.operationID===operationID)return this.fail(w,r,op,op.reason??'WORKTREE_REMOVE_REFUSED');
                return op;
            }
            if(!this.policy.allowApply)error('WORKSPACE_APPLY_DISABLED');
            this.ownership(w);
            if(op&&w.retirement?.operationID===operationID&&!existsSync(w.cwd)&&!this.entry(await this.registry(w),w.cwd)) {
                if(!r.disposition||await this.git(w.root,['rev-parse','--verify',r.disposition.retainedRef])!==op.head)error('WORKSPACE_RECOVERY_UNCONFIRMED');
                return this.finish(w,r,op,'absence-after-intent');
            }
            if(this.now()>plan.expiresAt||this.now()<plan.checkedAt||!plan.eligible){
                if(op)return this.fail(w,r,op,'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');
                error('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');
            }
            const check=await this.plan(plan.workspaceID);
            if(op) {
                // Only our own persisted fence/revision may differ while recovering an interrupted command.
                check.revision=plan.revision;check.reasons=check.reasons.filter(x=>x!=='retirement_in_progress');check.eligible=check.reasons.length===0;
            }
            if(!check.eligible||check.binding!==plan.binding||check.git!==plan.git||check.tasks!==plan.tasks||check.revision!==plan.revision){
                if(op)return this.fail(w,r,op,'WORKSPACE_PLAN_CHANGED');
                error('WORKSPACE_PLAN_CHANGED');
            }
            if(!op) {
                if(r.revision!==plan.revision||w.retirement)error('WORKSPACE_REVISION_CHANGED');
                r.revision++;op={id:operationID,fingerprint:fp,state:'applying',revision:r.revision,planID,head:plan.head!,branch:plan.branch,retainedRef:r.disposition!.retainedRef,checkout:plan.checkout};this.add(r,op);this.write(w,r);
            }
            if(w.retirement&&(w.retirement.operationID!==operationID||w.retirement.phase!=='retiring'))error('WORKSPACE_RECOVERY_UNCONFIRMED');
            if(!w.retirement) {
                try {this.queue.transaction(q=>{
                    const current=q.workspaces.find(x=>x.id===w.id)!;
                    if(current.retirement||this.binding(current)!==plan.binding||q.tasks.some(t=>(!terminalTask(t) || holdsReviewCheckout(t))&&(t.workspaceID===w.id||t.sessionID===w.sessionID||t.resources.some(x=>x.key===`checkout:${hash(w.cwd)}`
                        ||x.mode==='exclusive'&&(x.key==='machine'||x.key===`repo:${hash(w.repository)}`)))))error('WORKSPACE_IN_USE');
                    current.retirement={operationID,phase:'retiring',retainedRef:op!.retainedRef!,retainedCommit:op!.head!};
                });} catch {return this.fail(w,r,op,'WORKSPACE_IN_USE');}
            }
            // Network authorization precedes the last filesystem/activity probe.
            // It must not open an extra async gap after that safety snapshot.
            try { await this.authorize(); } catch { return this.fail(w,r,op,'WORKSPACE_AUTHORIZATION_CHANGED'); }
            // Recheck after the durable fence; heavy work is outside the queue transaction.
            const latest=await this.plan(w.id);
            if(latest.git!==plan.git||latest.tasks!==plan.tasks||latest.reasons.some(reason=>reason!=='retirement_in_progress'))return this.fail(w,r,op,'WORKSPACE_PLAN_CHANGED');
            try { this.authorizationCurrent(); } catch { return this.fail(w,r,op,'WORKSPACE_AUTHORIZATION_CHANGED'); }
            if(this.now()>plan.expiresAt||this.now()<plan.checkedAt)return this.fail(w,r,op,'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');
            try {
                await this.git(w.root,['worktree','remove','--',w.cwd],fd);
            } catch {
                if(!existsSync(w.cwd)){op.reason='WORKSPACE_REMOVAL_UNCONFIRMED';this.write(w,r);error('WORKSPACE_REMOVAL_UNCONFIRMED');}
                return this.fail(w,r,op,'WORKTREE_REMOVE_REFUSED');
            }
            if(existsSync(w.cwd)||this.entry(await this.registry(w),w.cwd))error('WORKSPACE_REMOVAL_UNCONFIRMED');
            return this.finish(w,r,op,'git-confirmed');
        });
    }
    private async fail(w:Workspace,r:Record,op:z.infer<typeof operationSchema>,reason:string) {
        let intact=false;
        if(existsSync(w.cwd)&&op.checkout){try{intact=(await this.inspectGit(w)).checkout===op.checkout;}catch{/* Unknown keeps the fence. */}}
        if(!intact){op.state='applying';op.reason='WORKSPACE_RECOVERY_UNCONFIRMED';this.write(w,r);return op;}
        op.state='failed';op.reason=reason;r.revision++;op.revision=r.revision;this.write(w,r);
        // Clear only this operation's fence, only while the original path still exists.
        if(existsSync(w.cwd))this.queue.transaction(q=>{const current=q.workspaces.find(x=>x.id===w.id)!;if(current.retirement?.operationID===op.id&&current.retirement.phase==='retiring')delete current.retirement;});
        return op;
    }
    private finish(w:Workspace,r:Record,op:z.infer<typeof operationSchema>,removal:'git-confirmed'|'absence-after-intent') {
        this.queue.transaction(q=>{const current=q.workspaces.find(x=>x.id===w.id)!;if(current.retirement?.operationID!==op.id)error('WORKSPACE_RECOVERY_UNCONFIRMED');current.retirement!.phase='retired';});
        op.state='removed';op.removal=removal;r.revision++;op.revision=r.revision;r.checkedAt=this.now();this.write(w,r);return op;
    }
    result(workspaceID:string,operationID?:string,history=false) {
        const w=this.snapshot(workspaceID).workspace,r=this.read(w),last=operationID?r.operations.find(op=>op.id===operationID):r.operations.at(-1);
        return {workspaceID,revision:r.revision,workspaceState:w.retirement?.phase??'active',disposition:r.disposition,operation:last,
            ...(history?{operations:r.operations}:{}),
            rebuild:r.disposition?{command:'git',args:['-C',w.root,'worktree','add','-b',`recovered/${w.id}/${r.disposition.head.slice(0,12)}`,
                join(this.queue.directory,'restored',`${w.id}-${r.disposition.head.slice(0,12)}`),r.disposition.retainedRef]}:undefined};
    }
}
