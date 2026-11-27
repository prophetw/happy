import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, opendirSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { workspacePlanSchema, workspaceDispositionSchema, workspaceOperationSchema, workspaceDeliveryReceiptSchema, type WorkspaceItem, type WorkspaceDelivery, type WorkspaceDeliveryRequest, type WorkspaceDeliveryReceipt, type WorkspaceReclaimGuidance, type WorkspaceReclaimProgress } from '@slopus/happy-wire';
import { hash } from '../journal';
import { canonicalBody } from './auth';
import { ApiError } from './schema';
import { MetadataStore } from './store';
import { privateDirectory, privateRead } from './privateFs';
import { TaskQueue, terminalTask, holdsReviewCheckout, type Workspace, type QueueTask } from './taskQueue';
import { workspaceGit, workspaceLock } from './taskWorkspaces';
import { checkoutEvidence, gitWorkspaces, integrationProof, remoteDeliveryRefs, ensureTargetCommit, type GitWorkspace } from './workspaceDeliveryEvidence';
import { githubDelivery, githubDeliveryPolicySchema, githubRemoteMatches } from './workspaceGithubDelivery';
import { recoverWorkspaceIdentity } from './workspaceIdentity';
import { readLinuxProcess, retirementProcessProof } from './sessionProcessProofs';
import { scanWorkspaceProcesses, type Activity, type ProcessScope } from './workspaceProcessScan';
import { reclaimRecord, saveReclaimStatus, type ReclaimStatus } from './workspaceReclaimState';
import { proveReclaimTarget, readReclaimTarget, type ReclaimTarget } from './workspaceReclaimGit';
import { archiveMove, archiveTree, withArchiveIndexFence } from './workspaceArchive';
import { dueRequestedReclaims, readReclaimRequest, saveReclaimRequest, type ReclaimRequest } from './workspaceReclaimRequests';
import { requestWorkspaceIdleClose, workspaceIdleEvidence } from './workspaceIdleProof';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const absolute = z.string().max(4096).refine(s => isAbsolute(s) && resolve(s) === s && !/[\x00-\x1f]/.test(s));
export const workspacePolicySchema = z.object({ version: z.literal(1), id, machineID: id, grantID: id, projectID: id,
    root: absolute, mainRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9_./-]{0,240}$/)
        .refine(ref=>!ref.includes('..') && !ref.includes('//') && !ref.split('/').some(part=>part.startsWith('.')||part.endsWith('.lock')) && !/[./]$/.test(ref)),
    remote: id.optional(), reclaimRemoteURL:z.string().min(1).max(4096).optional(), delivery: z.object({
        strategy:z.enum(['direct','pr']), remoteURL:z.string().min(1).max(4096).regex(/^[^\x00-\x1f]+$/),
        github:githubDeliveryPolicySchema.optional(),
        test:z.array(z.string().min(1).max(4096).regex(/^[^\x00-\x1f]+$/)).min(1).max(32),
    }).strict().refine(p=>!p.github||p.strategy==='pr'&&githubRemoteMatches(p.remoteURL,p.github.repository)).optional(), inventoryDirectories: z.array(absolute).max(20).optional(),
    protectedDirectories: z.array(absolute).max(100).default([]), allowApply: z.boolean().default(false),
    automaticRetirementArchive: absolute.optional(), allowArchive: z.boolean().default(false), allowDiscard: z.boolean().default(false),
}).strict().refine(p=>!p.delivery||!!p.remote,'A delivery policy requires an explicit remote');
export type WorkspacePolicy = z.input<typeof workspacePolicySchema>;
export type { Activity } from './workspaceProcessScan';
export type ActivityProbe = (workspace: Workspace, tasks: Pick<QueueTask,'processID'|'sessionID'>[], archive?:string) => Promise<Activity>;
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');
const overlaps = (a: string, b: string) => inside(a,b) || inside(b,a);
const fingerprint = (value: unknown) => hash(canonicalBody(value));
function error(code: string): never { throw new ApiError(code,409); }

/** Cold, local operator probe. An unreadable process/namespace is uncertainty, not absence.
 * No argv, environment, process name or unrelated task data is returned to callers.
 */
export async function linuxWorkspaceActivity(workspace:Workspace,tasks:Pick<QueueTask,'processID'|'sessionID'>[],queueDirectory?:string,machineID?:string,
    scan: (cwd: string, scope: ProcessScope) => Promise<Activity> = scanWorkspaceProcesses):Promise<Activity> {
    if (process.platform !== 'linux') return { confirmed: false, blockers: ['activity_platform_unconfirmed'], fingerprint: '' };
    try {
        const knownPids=new Set<number>(), groups=new Set<number>();
        const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
        const sessions=new Set([...tasks.map(t=>t.sessionID),...(workspace.sessionID?[workspace.sessionID]:[])]);
        for(const sessionID of sessions) {
            const proof=queueDirectory&&machineID?retirementProcessProof(join(queueDirectory,'session-process-proofs'),machineID,sessionID,workspace):null;
            if(!proof)return {confirmed:false,blockers:['session_mapping_unconfirmed'],fingerprint:''};
            // A ledger PID and a group number can both be reused. Workspace
            // paths, file descriptors and session arguments are scanned independently.
            if(proof.bootID!==boot)continue;
            const live=readLinuxProcess(proof.pid);
            if(live?.bootID===boot&&live.startTicks===proof.startTicks) {
                knownPids.add(proof.pid);
                if(live.processGroup)groups.add(live.processGroup);
            }
            // With a missing leader, members of its old group can still exist.
            // A reused leader number can no longer name that old group.
            if(!(live && live.startTicks!==proof.startTicks && proof.pid===proof.processGroup))
                groups.add(proof.processGroup!);
        }
        if(!sessions.size)return {confirmed:false,blockers:['session_mapping_unconfirmed'],fingerprint:''};
        return await scan(workspace.cwd, { pids: [...knownPids], groups: [...groups], sessions: [...sessions] });
    } catch { return { confirmed: false, blockers: ['activity_visibility_unconfirmed'], fingerprint: '' }; }
}

const dispositionSchema = workspaceDispositionSchema.extend({ retainedRef: z.string().max(256), source: z.string().min(1).max(200) });
const operationSchema = workspaceOperationSchema;
const recordSchema = z.object({ version: z.literal(1), binding: digest, revision: z.number().int().nonnegative(),
    disposition: dispositionSchema.optional(), operations: z.array(operationSchema).max(16), checkedAt: z.number().optional(),
}).strict();
type Record = z.infer<typeof recordSchema>;
const deliveryIntentSchema=z.object({
    scope:digest, policy:digest, ownerID:id, requestID:id, evidence:z.string().max(16000).optional(),
    receipt:workspaceDeliveryReceiptSchema, previousPushedHead:commit.optional(),
}).strict();
type DeliveryIntent=z.infer<typeof deliveryIntentSchema>;
const planSchema = workspacePlanSchema;
export type WorkspacePlan = z.infer<typeof planSchema>;
type Snapshot = { workspace: Workspace; tasks: QueueTask[]; related: QueueTask[]; others: Workspace[] };
const gitArchiveMaterialSchema=z.object({digest,commits:z.array(commit).max(64)}).strict();
type GitArchiveMaterial=z.infer<typeof gitArchiveMaterialSchema>;
type GitMaterial=GitArchiveMaterial&{bytes:Buffer};
type GitState = { fetched?:GitMaterial; reflog?:GitMaterial; head: string; branch: string; mainCommit: string; remoteCommit?: string; dirty: boolean; ignored: boolean;
    registry: string; identity: string; digest: string; checkout:string };

/** One owner-authoritative lifecycle record per workspace, with bounded operation receipts.
 * A remote delivery requires a separate durable Owner authorization for an exact candidate.
 */
export class WorkspaceLifecycle {
    readonly policy: z.infer<typeof workspacePolicySchema>;
    private readonly policyHash: string;
    private readonly activity: ActivityProbe;
    constructor(readonly queue: TaskQueue, policy: WorkspacePolicy,
        activity?: ActivityProbe, private now = Date.now,
        private git = workspaceGit, private authorize: () => void | Promise<void> = () => {}, private authorizationCurrent: () => void = () => {}, private archiveActivity?: ActivityProbe) {
        this.policy = workspacePolicySchema.parse(policy); this.policyHash = fingerprint(this.policy);
        this.activity=activity??((w,t)=>linuxWorkspaceActivity(w,t,queue.directory,this.policy.machineID));
        if (queue.access.machineID !== this.policy.machineID) error('WORKSPACE_MACHINE_MISMATCH');
    }
    private snapshot(workspaceID: string): Snapshot {
        digest.parse(workspaceID);
        return this.queue.transaction(s => this.snapshotFor(s,workspaceID),true);
    }
    private snapshotFor(s:{workspaces:Workspace[];tasks:QueueTask[]},workspaceID:string, automatic = false):Snapshot {
            const w = s.workspaces.find(w=>w.id===workspaceID);
            if (!w || w.grantID!==this.policy.grantID || w.projectID!==this.policy.projectID || w.root!==this.policy.root) error('WORKSPACE_SCOPE_DENIED');
            return { workspace: w!, tasks: s.tasks.filter(t=>t.workspaceID===workspaceID&&t.grantID===w.grantID),
                related: s.tasks.filter(t=>(!terminalTask(t) || holdsReviewCheckout(t)) && (t.sessionID===w!.sessionID || t.resources.some(r=>r.key===`checkout:${hash(w!.cwd)}`
                    || r.mode==='exclusive'&&(r.key==='machine'||r.key===`repo:${hash(w!.repository)}`)))),
                others: s.workspaces.filter(other=>other.id!==workspaceID && other.retirement?.phase!=='retired'
                    && overlaps(other.cwd,w!.cwd) && (other.execution.candidate?.kind !== 'checkout' || automatic
                        && !s.tasks.some(task => task.workspaceID===other.id && terminalTask(task)))) };
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
    private ownership(w: Workspace, legacy = false, checkTemporary = true) {
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
            if (checkTemporary && readdirSync(w.temporaryDirectory).length) error('WORKSPACE_TEMPORARY_ARTIFACTS');
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
    private readGitArchiveFile(path:string) {
        const before=lstatSync(path,{throwIfNoEntry:false,bigint:true});
        if(!before)return;
        if(!before.isFile()||before.uid!==BigInt(process.getuid!())||before.nlink!==1n||before.size>65536n||realpathSync(path)!==path)
            error('WORKSPACE_GITDIR_ARTIFACTS');
        const fd=openSync(path,constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_RDONLY);
        let bytes:Buffer;
        try {
            const matches=(s:typeof before)=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.ctimeNs===before.ctimeNs;
            if(!matches(fstatSync(fd,{bigint:true})))error('WORKSPACE_GITDIR_ARTIFACTS');
            bytes=Buffer.alloc(Number(before.size)+1);
            let total=0,n:number;
            while(total<bytes.length&&(n=readSync(fd,bytes,total,bytes.length-total,null))>0)total+=n;
            if(total!==Number(before.size)||!matches(fstatSync(fd,{bigint:true}))||!matches(lstatSync(path,{bigint:true})))
                error('WORKSPACE_GITDIR_ARTIFACTS');
            return bytes.subarray(0,total);
        }finally{closeSync(fd);}
    }

    private async fetchedHistory(cwd:string,gitdir:string) {
        const bytes=this.readGitArchiveFile(join(gitdir,'FETCH_HEAD'));
        if(!bytes)return;
        const hashes=new Set<string>();
        for(const line of bytes.toString('latin1').split('\n')){
            if(!line)continue;
            const parsed=/^([a-f0-9]{40}|[a-f0-9]{64})\t(?:not-for-merge)?\t[^\x00\r]+$/.exec(line);
            if(!parsed)error('WORKSPACE_GITDIR_ARTIFACTS');
            hashes.add(parsed[1]);
        }
        if(hashes.size>32)error('WORKSPACE_GITDIR_ARTIFACTS');
        const commits=[...hashes];
        for(const oid of commits){
            const kind=await this.git(cwd,['cat-file','-t',oid]).catch(()=>undefined);
            if(kind!=='commit')error('WORKSPACE_GITDIR_ONLY_RESULTS');
        }
        // Only shared refs count. Worktree-local refs disappear during retirement.
        if(commits.length&&await this.git(cwd,['rev-list','--max-count=1',...commits,'--not','--branches','--tags','--remotes']))
            error('WORKSPACE_GITDIR_ONLY_RESULTS');
        return {commits,digest:hash(bytes.toString('base64')),bytes};
    }

    private reflogMaterial(gitdir:string) {
        const bytes=this.readGitArchiveFile(join(gitdir,'logs','HEAD'));
        if(!bytes)return;
        const commits=new Set<string>();
        for(const line of bytes.toString('latin1').split('\n')){
            if(!line)continue;
            const entry=/^([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) /.exec(line);
            if(!entry||entry[1].length!==entry[2].length)error('WORKSPACE_REFLOG_UNCONFIRMED');
            for(const oid of [entry[1],entry[2]]) if(!/^0+$/.test(oid))commits.add(oid);
        }
        return {bytes,digest:hash(bytes.toString('base64')),commits:[...commits]};
    }

    private async inspectGit(w: Workspace, legacy = false, automatic?: ReclaimTarget, localOnly = false, preserveContent = false): Promise<GitState> {
        this.ownership(w,legacy,!preserveContent);
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
        if(preserveContent)ordinary.add('FETCH_HEAD');
        if(readdirSync(gitdir).some(name=>!ordinary.has(name))
            ||existsSync(join(gitdir,'logs'))&&readdirSync(join(gitdir,'logs')).some(name=>name!=='HEAD'))error('WORKSPACE_GITDIR_ARTIFACTS');
        const fetched=preserveContent?await this.fetchedHistory(w.cwd,gitdir):undefined;
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
        const observedReflog=preserveContent?this.reflogMaterial(gitdir):undefined;
        const historyHeads=[...new Set([...reflog,...(observedReflog?.commits??[])])];
        const historyRefs=preserveContent?['--branches','--tags','--remotes']:['--single-worktree','--all'];
        let retainedReflog:GitMaterial|undefined;
        if(historyHeads.length&&await this.git(w.cwd,['rev-list','--max-count=1',...historyHeads,'--not',...historyRefs])) {
            if(!observedReflog||observedReflog.commits.length>64||historyHeads.some(oid=>!observedReflog.commits.includes(oid)))
                error('WORKSPACE_REFLOG_ONLY_RESULTS');
            retainedReflog=observedReflog;
        }
        const messageHeads=new Set([head,...reflog]);
        if(existsSync(join(gitdir,'ORIG_HEAD'))){
            const original=readFileSync(join(gitdir,'ORIG_HEAD'),'utf8');
            if(!/^[a-f0-9]{40,64}\n?$/.test(original))error('WORKSPACE_GITDIR_ARTIFACTS');
            if(!retainedReflog?.commits.includes(original.trim())
                &&await this.git(w.cwd,['rev-list','--max-count=1',original.trim(),'--not','--single-worktree','--all']))
                error('WORKSPACE_GITDIR_ONLY_RESULTS');
            messageHeads.add(original.trim());
        }
        if(existsSync(join(gitdir,'COMMIT_EDITMSG'))
            &&!(await this.git(w.cwd,['show','-s','--format=%B%x00',...messageHeads])).split('\0').map(text=>text.trim())
                .includes(readFileSync(join(gitdir,'COMMIT_EDITMSG'),'utf8').trim()))error('WORKSPACE_GITDIR_ARTIFACTS');
        let mainCommit=automatic?.commit ?? await this.git(w.root,['rev-parse','--verify',this.policy.mainRef+'^{commit}']);
        if(this.policy.delivery && !localOnly) await this.verifyDeliveryRemote();
        let remoteCommit: string|undefined;
        if (localOnly) {
            remoteCommit = automatic?.commit;
        } else if (automatic) {
            const remote = await readReclaimTarget(this.policy);
            if (head !== automatic.head) error('WORKSPACE_HEAD_CHANGED');
            if (remote.commit !== automatic.commit || remote.remoteURL !== automatic.remoteURL) error('WORKSPACE_REMOTE_UNCONFIRMED');
            remoteCommit = remote.commit;
        } else if (this.policy.remote) {
            remoteCommit=(await remoteDeliveryRefs(this.policy,[]))?.get(this.policy.mainRef);
            if(!remoteCommit)error('WORKSPACE_REMOTE_UNCONFIRMED');
            await this.git(w.root,['cat-file','-e',remoteCommit+'^{commit}']);
            if(this.policy.delivery) mainCommit=remoteCommit;
        }
        const indexFlags=await this.git(w.cwd,['ls-files','-v']);
        if(indexFlags.split('\n').some(line=>/^[a-zS] /.test(line)))error('WORKSPACE_INDEX_FLAGS_UNCONFIRMED');
        if((await this.git(w.cwd,['ls-files','--stage'])).split('\n').some(line=>line.startsWith('160000 ')))error('WORKSPACE_SUBMODULES_RETAINED');
        const status=await this.git(w.cwd,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none']);
        const ignored=await this.git(w.cwd,['ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory']);
        const st=lstatSync(w.cwd), identity=`${st.dev}:${st.ino}:${lstatSync(join(w.cwd,'.git')).ino}`;
        const result={head,branch,mainCommit,remoteCommit,dirty:Boolean(status),ignored:Boolean(ignored),registry:entry!,identity};
        return {...result,fetched,reflog:retainedReflog,digest:fingerprint({...result,status,ignored}),checkout:fingerprint({head,branch,status,ignored,entry,identity})};
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
    /** Read-only reconciliation. Only the returned page gets checkout and remote probes. */
    async deliveryInventory(limit: number, after = '', view: 'pending'|'released' = 'pending', requestID?:string, guidance = false, reclaim = false) {
        const ledger = this.queue.transaction(s => {
            const claimed = new Set<string>(), knownIDs=new Set<string>(), owned: Workspace[] = [], tasks = new Map<string, QueueTask[]>();
            for (const w of s.workspaces) {
                claimed.add(w.cwd);knownIDs.add(w.id);
                if (w.grantID === this.policy.grantID && w.projectID === this.policy.projectID && w.root === this.policy.root) owned.push(w);
            }
            for (const t of s.tasks) {
                if (t.grantID !== this.policy.grantID || !t.workspaceID) continue;
                const list = tasks.get(t.workspaceID);
                if (list) list.push(t); else tasks.set(t.workspaceID,[t]);
            }
            return { claimed, knownIDs, owned, tasks };
        },true);
        const registry = await gitWorkspaces(this.policy.root);
        const entries = new Map(registry?.map(entry=>[entry.directory,entry]));
        const candidates = ledger.owned.filter(w=>w.branch && !w.execution.candidate
            && (view==='released') === (w.retirement?.phase==='retired'));
        const roots = [this.policy.root, ...this.policy.inventoryDirectories ?? []];
        const historical = view==='released' ? [] : (registry ?? []).filter(entry =>
            entry.directory!==this.policy.root && !ledger.claimed.has(entry.directory) && !inside(entry.directory,this.queue.directory)
            && !entry.branch?.startsWith('dot-task/')
            && roots.some(root=>entry.directory!==root && inside(entry.directory,root)));
        const orphanIDs=new Set([...ledger.tasks.keys()].filter(key=>!ledger.knownIDs.has(key)));
        if (view==='pending') for(const entry of registry??[]) {
            const workspaceID=entry.branch?.match(/^dot-task\/([a-f0-9]{64})$/)?.[1];
            if(workspaceID&&!ledger.knownIDs.has(workspaceID)&&entry.directory===join(this.queue.directory,'worktrees',workspaceID)) orphanIDs.add(workspaceID);
        }
        const recovered=view==='released'?[]:[...orphanIDs].flatMap(id=>{
            const identity=recoverWorkspaceIdentity(this.queue,this.policy,id);
            if(!identity||ledger.claimed.has(identity.directory)) return [];
            return [{id,workspace:undefined,identity,entry:entries.get(identity.directory)}];
        });
        const rows = [
            ...candidates.map(workspace=>({ id:workspace.id, workspace, identity:undefined, entry:entries.get(workspace.cwd) })),
            ...historical.map(entry=>({ id:hash(canonicalBody([this.policy.projectID,this.policy.grantID,entry.directory])), workspace:undefined, identity:undefined, entry })),
            ...recovered,
        ].filter(row=>!requestID||ledger.tasks.get(row.id)?.some(task=>task.requestID===requestID)).sort((a,b)=>a.id.localeCompare(b.id));
        const remaining = rows.filter(row=>row.id>after), page = remaining.slice(0,limit);
        const remote = view==='released' || !page.length ? undefined : await remoteDeliveryRefs(this.policy,
            page.flatMap(row=>row.entry?.branch ?? row.workspace?.branch ?? row.identity?.branch ?? []));
        let repository: string | undefined;
        if (page.some(row=>!row.workspace&&!row.identity)) {
            try { repository=realpathSync(resolve(this.policy.root,await this.git(this.policy.root,['rev-parse','--git-common-dir']))); }
            catch { /* Keep the registry entry visible without inspecting the checkout. */ }
        }
        const tests = new Map<string,{ commit:string; status:string; order:number }>();
        for (const w of ledger.owned) {
            if (w.execution.candidate?.kind!=='test') continue;
            const {commit}=w.execution.candidate, key=canonicalBody([w.repository,commit]);
            for (const task of ledger.tasks.get(w.id) ?? []) {
                if (task.state==='completed' && task.testResult && (tests.get(key)?.order ?? -1)<task.order)
                    tests.set(key,{commit,status:task.testResult.exitCode===0?'passed':'failed',order:task.order});
            }
        }
        const items = await Promise.all(page.map(async ({id,workspace,identity,entry}):Promise<WorkspaceItem> => {
            if (workspace) {
                const tasks=ledger.tasks.get(workspace.id) ?? [];
                const item=this.workspaceItem(workspace,tasks);
                const head=entry?.head??[...item.tasks].reverse().find(task=>task.resultCommit)?.resultCommit;
                const test=head?tests.get(canonicalBody([workspace.repository,head])):undefined;
                const intent=this.storedDelivery(workspace);
                const receipt=intent&&{...intent.receipt,...(intent.policy!==this.policyHash?{blocker:'WORKSPACE_DELIVERY_AUTHORIZATION_CHANGED'}:{})};
                const delivery=await this.deliveryObservation(item,workspace.repository,entry,registry!==undefined,remote,
                    test&&{commit:test.commit,status:test.status},intent?.policy===this.policyHash?receipt?.pullRequestMerge:undefined);
                const reclaimGuidance = guidance ? await this.reclaimGuidance(workspace.id,delivery) : undefined;
                return {...item,...(reclaim?this.requestedReclaimProjection(workspace):{}),reclaimGuidance,branch:entry?.branch??item.branch,delivery:{...delivery,receipt,
                    canStart:!!(this.policy.delivery && workspace.managedBy && item.state!=='retired' && (!intent || this.canReplaceDelivery(intent,entry?.head)))}};
            }
            if(identity) {
                const tasks=ledger.tasks.get(id)??[];
                const item:WorkspaceItem={id,projectID:this.policy.projectID,directory:identity.directory,branch:entry?.branch??identity.branch,
                    baseCommit:identity.baseCommit,state:'mapping-missing',managed:false,revision:0,reasons:[],taskCount:tasks.length,tasks:this.taskLinks(tasks)};
                return {...item,delivery:await this.deliveryObservation(item,identity.repository,entry,registry!==undefined,remote)};
            }
            const item:WorkspaceItem={id,projectID:this.policy.projectID,directory:entry!.directory,branch:entry!.branch,
                state:'unclaimed',managed:false,revision:0,reasons:[],taskCount:0,tasks:[]};
            return {...item,delivery:await this.deliveryObservation(item,repository,entry,true,remote)};
        }));
        return { total:rows.length, returned:items.length, items,next:remaining.length>limit?page.at(-1)!.id:null };
    }
    private deliveryStore(create=false) {
        const directory=join(this.queue.directory,'workspace-delivery');
        return create||existsSync(directory)?new MetadataStore(directory,128*1024,create):undefined;
    }

    private storedDelivery(w:Workspace) {
        const raw=this.deliveryStore()?.get<unknown>(w.id);
        if (!raw) return undefined;
        const record=deliveryIntentSchema.parse(raw);
        if(record.scope!==this.binding(w)) error('WORKSPACE_METADATA_CHANGED');
        return record;
    }

    private canReplaceDelivery(intent:DeliveryIntent, head:string|undefined) {
        const previous=intent.receipt;
        return !!head&&head!==previous.head&&intent.policy===this.policyHash&&(
            ['authorized','testing','tested'].includes(previous.phase)
            || this.policy.delivery?.strategy==='direct'&&previous.phase==='pushed'&&previous.blocker==='WORKSPACE_DELIVERY_TARGET_ADVANCED');
    }

    private async verifyDeliveryRemote() {
        const {delivery,root,remote}=this.policy;
        if(!delivery||!remote) error('WORKSPACE_DELIVERY_DISABLED');
        const [read,write]=await Promise.all([
            this.git(root,['remote','get-url','--all',remote]),this.git(root,['remote','get-url','--push','--all',remote]),
        ]);
        if(read!==delivery.remoteURL||write!==delivery.remoteURL) error('WORKSPACE_DELIVERY_REMOTE_CHANGED');
        return { ...delivery, remote };
    }

    private async runDeliveryTest(directory:string, argv:string[], fd:number) {
        return new Promise<number>((resolve,reject)=>{
            const child=spawn(argv[0],argv.slice(1),{cwd:directory,stdio:['ignore','ignore','ignore',fd],detached:true,
                env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:directory,CI:'1',GIT_TERMINAL_PROMPT:'0'}});
            const timer=setTimeout(()=>{
                if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch {/* Already exited. */}
            },120_000);
            child.once('error',()=>{clearTimeout(timer);reject(new ApiError('WORKSPACE_DELIVERY_TEST_UNKNOWN',409));});
            child.once('close',code=>{clearTimeout(timer);if(code===null)reject(new ApiError('WORKSPACE_DELIVERY_TEST_UNKNOWN',409));else resolve(code);});
        });
    }

    /** An Owner authorizes the exact candidate once. Each retry reads observable
     * Git state before any remote effect and rechecks current account policy. */
    async deliver(request:WorkspaceDeliveryRequest, ownerID:string):Promise<WorkspaceDeliveryReceipt> {
        if(this.queue.access.readOnly) error('WORKSPACE_READ_ONLY');
        const {workspaceID,operationID}=request;
        const progression = await this.locked(workspaceID,async fd=>{
            await this.authorize();
            const s=this.snapshot(workspaceID),w=s.workspace;
            let intent=this.storedDelivery(w);
            const previous=intent;
            if (previous && (previous.ownerID!==ownerID||previous.policy!==this.policyHash)) error('WORKSPACE_DELIVERY_AUTHORIZATION_CHANGED');
            if (request.action==='start-delivery') {
                if (previous?.receipt.operationID===operationID &&
                    (previous.requestID!==request.requestID||previous.receipt.head!==request.head||previous.evidence!==request.evidence))
                    error('WORKSPACE_OPERATION_CONFLICT');
                if (!previous||previous.receipt.operationID!==operationID) {
                    this.ownership(w);
                    if(w.retirement||!this.policy.delivery||!this.policy.remote) error('WORKSPACE_DELIVERY_DISABLED');
                    const source=s.tasks.at(-1);
                    if(source?.state!=='completed'||!source.dispatched||source.requestID!==request.requestID||source.resultCommit!==request.head)
                        error('WORKSPACE_DELIVERY_CANDIDATE_CHANGED');
                    if(previous&&!this.canReplaceDelivery(previous,request.head))error('WORKSPACE_OPERATION_CONFLICT');
                    const store=this.deliveryStore(true)!;
                    if(store.get(`history:${w.id}:${operationID}`))error('WORKSPACE_OPERATION_CONFLICT');
                    const previousPushedHead=previous?.receipt.phase==='pushed'?previous.receipt.head:previous?.previousPushedHead;
                    intent={scope:this.binding(w),policy:this.policyHash,ownerID,requestID:source.requestID,evidence:request.evidence,previousPushedHead,
                        receipt:{operationID,head:request.head,phase:'authorized',updatedAt:this.now(),remote:this.policy.remote,
                            targetRef:this.policy.mainRef,branch:w.branch}};
                    if(previous)store.set(`history:${w.id}:${previous.receipt.operationID}`,previous);
                    store.set(w.id,intent);
                }
            } else if(previous?.receipt.operationID!==operationID) {
                const older=this.deliveryStore()?.get(`history:${w.id}:${operationID}`);
                if(older) {
                    const saved=deliveryIntentSchema.parse(older);
                    if(saved.ownerID!==ownerID||saved.policy!==this.policyHash||saved.scope!==this.binding(w))
                        error('WORKSPACE_DELIVERY_AUTHORIZATION_CHANGED');
                    return {...saved,receipt:{...saved.receipt,blocker:'WORKSPACE_DELIVERY_SUPERSEDED'}};
                }
                error('WORKSPACE_DELIVERY_AUTHORIZATION_REQUIRED');
            }
            if(!intent) error('WORKSPACE_DELIVERY_AUTHORIZATION_REQUIRED');
            const current=intent;
            const durable=this.deliveryStore(true)!;
            const save=(changes:Partial<WorkspaceDeliveryReceipt>)=>{
                current.receipt=workspaceDeliveryReceiptSchema.parse({...current.receipt,blocker:undefined,...changes,updatedAt:this.now()});
                durable.set(w.id,current);
                return current;
            };
            const { head }=current.receipt;
            if(w.retirement?.phase==='retired') return this.result(w.id,operationID).operation?.state==='removed'
                ? save({phase:'released'}):save({blocker:'WORKSPACE_DELIVERY_RELEASE_UNCONFIRMED'});
            if(w.retirement?.phase==='retiring') return current;
            try {
                const policy=await this.verifyDeliveryRemote(), targetRef=this.policy.mainRef;
                const branch=w.branch!;
                const baseSnapshot=async()=>{
                    const latest=this.snapshot(w.id), source=latest.tasks.at(-1);
                    if(source?.requestID!==current.requestID||source.resultCommit!==head||this.runtimeReasons(latest).length) error('WORKSPACE_DELIVERY_CANDIDATE_CHANGED');
                    const state=await this.inspectGit(w);
                    if(state.head!==head||state.branch!==branch) error('WORKSPACE_DELIVERY_CANDIDATE_CHANGED');
                    if(state.dirty||state.ignored) error('WORKSPACE_UNSAVED_ARTIFACTS');
                    return state;
                };
                const observe=async()=>{
                    const refs=await remoteDeliveryRefs(this.policy,[branch]), target=refs?.get(targetRef);
                    if(!target) error('WORKSPACE_REMOTE_UNCONFIRMED');
                    await ensureTargetCommit(w.root,policy.remote,targetRef,target,fd);
                    return {target,pushed:refs!.get('refs/heads/'+branch)};
                };
                let {target,pushed}=await observe();
                if(current.receipt.phase==='push-intent'&&pushed===head)
                    save({phase:'pushed',pushedAt:current.receipt.pushedAt??this.now()});
                await baseSnapshot();
                const provider=policy.github?githubDelivery(policy.github,branch,targetRef.slice('refs/heads/'.length),head):undefined;
                if(policy.strategy==='pr'&&!provider)error('WORKSPACE_DELIVERY_PR_REQUIRED');
                const priorPR=provider&&await provider.read();
                const testCandidate=async(base:string)=>{
                    save({phase:'testing',testedOn:base,testExitCode:undefined});
                    await this.authorize();
                    const exitCode=await this.runDeliveryTest(w.cwd,policy.test,fd);
                    save({phase:'tested',testExitCode:exitCode});
                    if(exitCode!==0)error('WORKSPACE_DELIVERY_TEST_FAILED');
                    await baseSnapshot();
                };
                const verifyPRMerge=async(merge:string, expectedTarget:string)=>{
                    return await integrationProof(w.root,merge,expectedTarget)==='ancestor';
                };
                let proof=await integrationProof(w.root,head,target,w.baseCommit);
                if(priorPR?.state==='MERGED'&&priorPR.mergeCommit&&await verifyPRMerge(priorPR.mergeCommit.oid,target)) {
                    if(current.receipt.testExitCode!==0)await testCandidate(target);
                    return save({phase:'merged',pullRequest:priorPR.number,pullRequestMerge:priorPR.mergeCommit.oid,
                        mergedAt:current.receipt.mergedAt??this.now(),mergedTarget:current.receipt.mergedTarget??target,
                        ...(current.receipt.testExitCode!==0?{blocker:'WORKSPACE_DELIVERY_TEST_REQUIRED'}:{})});
                }
                if(!provider && (proof==='ancestor'||proof==='exact-content')) {
                    if(current.receipt.testExitCode!==0)await testCandidate(target);
                    return save({phase:'merged',mergedAt:current.receipt.mergedAt??this.now(),mergedTarget:current.receipt.mergedTarget??target});
                }
                if (!proof||priorPR?.state==='MERGED') error('WORKSPACE_REMOTE_UNCONFIRMED');
                // A direct delivery may advance the target only when the tested
                // candidate already contains it. Preserve the branch on a race.
                if(await this.git(w.root,['merge-base',head,target],fd)!==target) error('WORKSPACE_DELIVERY_TARGET_ADVANCED');
                if(current.receipt.testedOn!==target||current.receipt.testExitCode!==0)await testCandidate(target);
                await baseSnapshot();
                ({target,pushed}=await observe());
                if(target!==current.receipt.testedOn) error('WORKSPACE_DELIVERY_TARGET_ADVANCED');
                if(pushed&&pushed!==head&&(pushed!==current.previousPushedHead
                    ||await this.git(w.root,['merge-base',pushed,head],fd)!==pushed))error('WORKSPACE_DELIVERY_REMOTE_BRANCH_CHANGED');
                const push=async(ref:string, expected:string)=>{
                    await this.authorize();
                    await this.verifyDeliveryRemote();
                    this.authorizationCurrent();
                    await this.git(w.root,['push','--porcelain',`--force-with-lease=${ref}:${expected}`,'--',policy.remote,`${head}:${ref}`],fd);
                };
                if(pushed!==head) {
                    save({phase:'push-intent'});
                    await push('refs/heads/'+branch,pushed??'');
                    if((await observe()).pushed!==head) error('WORKSPACE_DELIVERY_PUSH_UNKNOWN');
                }
                save({phase:'pushed',pushedAt:current.receipt.pushedAt??this.now()});
                if(provider) {
                    let pr=await provider.read();
                    if(!pr) {
                        save({phase:'pr-intent'});
                        await this.authorize();
                        this.authorizationCurrent();
                        await provider.create();
                        pr=await provider.read();
                    }
                    if(!pr)error('WORKSPACE_DELIVERY_PR_UNAVAILABLE');
                    if(pr.state!=='MERGED') {
                        save({phase:'pr-open',pullRequest:pr.number});
                        const blocker=await provider.blocker(pr);
                        if(blocker)return save({blocker});
                        await this.authorize();
                        if((await observe()).target!==target)error('WORKSPACE_DELIVERY_TARGET_ADVANCED');
                        await baseSnapshot();
                        this.authorizationCurrent();
                        save({phase:'merge-intent'});
                        await provider.merge(pr);
                        pr=await provider.read();
                    }
                    const {target:confirmed}=await observe();
                    if(pr?.state!=='MERGED'||!pr.mergeCommit||!await verifyPRMerge(pr.mergeCommit.oid,confirmed))
                        error('WORKSPACE_DELIVERY_MERGE_UNKNOWN');
                    return save({phase:'merged',pullRequest:pr.number,pullRequestMerge:pr.mergeCommit.oid,mergedAt:this.now(),mergedTarget:confirmed});
                }
                if((await observe()).target!==target) error('WORKSPACE_DELIVERY_TARGET_ADVANCED');
                await baseSnapshot();
                save({phase:'merge-intent'});
                try { await push(targetRef,target); }
                catch(error) {
                    if(!(error instanceof ApiError)||error.code!=='WORKTREE_PREPARATION_UNCONFIRMED')throw error;
                    const after=await observe();
                    const integrated=await integrationProof(w.root,head,after.target,w.baseCommit);
                    if(integrated==='ancestor'||integrated==='exact-content')
                        return save({phase:'merged',mergedAt:this.now(),mergedTarget:after.target});
                    if(after.target!==target)throw new ApiError('WORKSPACE_DELIVERY_TARGET_ADVANCED',409);
                    throw new ApiError('WORKSPACE_DELIVERY_MERGE_UNKNOWN',409);
                }
                const confirmed=await observe();
                proof=await integrationProof(w.root,head,confirmed.target,w.baseCommit);
                if(proof!=='ancestor'&&proof!=='exact-content') error('WORKSPACE_DELIVERY_MERGE_UNKNOWN');
                return save({phase:'merged',mergedAt:this.now(),mergedTarget:confirmed.target});
            } catch(e) { return save({blocker:e instanceof ApiError?e.code:'WORKSPACE_DELIVERY_UNCONFIRMED'}); }
        });
        const receipt=progression.receipt;
        if(receipt.phase!=='merged'||receipt.blocker) return receipt;
        const check=this.snapshot(workspaceID).workspace;
        let blocker:string|undefined;
        try {
            if(!progression.evidence) error('WORKSPACE_BUSINESS_ACCEPTANCE_REQUIRED');
            const finalized=await this.finalizeIntegrated(workspaceID,operationID,receipt.head,progression.evidence!,ownerID,receipt);
            if(finalized.state!=='removed') blocker=finalized.reason??'WORKSPACE_DELIVERY_RELEASE_UNCONFIRMED';
        } catch(e) { blocker=e instanceof ApiError?e.code:'WORKSPACE_DELIVERY_RELEASE_UNCONFIRMED'; }
        return this.locked(workspaceID,async()=>{
            const latest=this.storedDelivery(check)!;
            if(latest.receipt.phase==='released') return latest.receipt;
            latest.receipt=workspaceDeliveryReceiptSchema.parse({...latest.receipt,phase:blocker?'merged':'released',blocker,updatedAt:this.now()});
            this.deliveryStore(true)!.set(workspaceID,latest);
            return latest.receipt;
        });
    }

    private async deliveryObservation(item: WorkspaceItem, repository:string|undefined, entry:GitWorkspace|undefined,
        registryKnown:boolean, remote:Map<string,string>|undefined, test?:WorkspaceDelivery['test'], pullRequestMerge?:string):Promise<WorkspaceDelivery> {
        const at=this.now(), released=item.state==='retired', unclaimed=item.state==='unclaimed';
        const head=entry?.head??[...item.tasks].reverse().find(task=>task.resultCommit)?.resultCommit??item.disposition?.head;
        const checkout=repository?await checkoutEvidence(item.directory,repository):{directory:'unknown' as const};
        const remoteHead=remote?.get(this.policy.mainRef);
        const branch=entry?.branch??item.branch, pushedHead=branch?remote?.get('refs/heads/'+branch):undefined;
        const result=head && remoteHead && !unclaimed && head!==item.baseCommit ? await integrationProof(this.policy.root,head,remoteHead,item.baseCommit):undefined;
        const proof=result==='ancestor'||result==='exact-content'?result
            : remoteHead&&pullRequestMerge&&await integrationProof(this.policy.root,pullRequestMerge,remoteHead)==='ancestor'?'pull-request':undefined;
        const state=released?'released':unclaimed?'unclaimed':proof?'merged':result==='pending'?(head===pushedHead?'pushed':'pending-merge'):'unknown';
        const registration=entry?'registered':registryKnown?'missing':'unknown';
        const next=released?'none':unclaimed?'claim':item.state==='mapping-missing'?'restore':checkout.directory==='missing'||registration==='missing'?'restore'
            :checkout.dirty?'preserve':proof?'finalize':state==='unknown'||checkout.dirty===undefined?'inspect'
            :test?.status==='passed'?'integrate':'test';
        return {...checkout,registration,ownership:unclaimed?'unclaimed':item.state==='mapping-missing'?'mapping-missing':item.managed?'managed':'legacy',state,
            head,remote:this.policy.remote,targetRef:this.policy.mainRef,remoteHead,pushedHead,proof,observedAt:at,test,next};
    }
    /** Owner UI projection: identifiers/status only, never task text or credentials. */
    overview(workspaceID: string): WorkspaceItem {
        const s = this.snapshot(workspaceID), w = s.workspace, r = this.read(w);
        return this.workspaceItem(w,s.tasks,r,this.runtimeReasons(s));
    }
    private taskLinks(tasks:QueueTask[]) {
        return tasks.slice(-20).map(t=>({id:t.id,requestID:t.requestID,sessionID:t.sessionID,state:t.state,resultCommit:t.resultCommit}));
    }
    private workspaceItem(w:Workspace,tasks:QueueTask[],r=this.read(w),reasons:string[]=[]):WorkspaceItem {
        const reclaim = reclaimRecord(this.queue.directory,w)?.status;
        const automatic = reclaim && `automatic_reclaim:${reclaim.state}:${reclaim.reason ?? ''}`;
        return { id: w.id, projectID: w.projectID, directory: w.cwd, branch: w.branch, baseCommit: w.baseCommit,
            revision: r.revision, managed: !!w.managedBy, state: w.retirement?.phase ?? (!w.managedBy ? 'legacy_unconfirmed' : r.disposition ? 'resolved' : 'pending_disposition'),
            reasons: [...reasons, ...(automatic ? [automatic] : []), ...(!w.managedBy ? ['WORKSPACE_OWNER_UNCONFIRMED'] : [])],
            taskCount: tasks.length, tasks: this.taskLinks(tasks),
            disposition: r.disposition, lastVerification: r.checkedAt, lastOperation: r.operations.at(-1),
            ...(w.execution.retireAfterIntegration && w.managedBy && this.policy.allowApply && this.policy.automaticRetirementArchive ? { canFinalizeIntegrated:true } : {}) };
    }
    /** Scoped diagnostics can show simultaneous blockers without changing
     * the deletion plan or relying on a cached previous attempt. */
    private async reclaimGuidance(workspaceID: string, checkout?: Pick<WorkspaceDelivery,'dirty'|'directory'>, includeNames = false): Promise<WorkspaceReclaimGuidance | undefined> {
        const snapshot = this.snapshot(workspaceID), w = snapshot.workspace;
        if (w.retirement?.phase === 'retired') return;
        const reasons = this.runtimeReasons(snapshot);
        let temporary: WorkspaceReclaimGuidance['temporary'];
        try {
            this.ownership(w,false,false);
            if (existsSync(w.temporaryDirectory)) {
                const names: string[] = [];
                let count = 0;
                const directory = opendirSync(w.temporaryDirectory);
                try {
                    for (let entry; count < 1000 && (entry=directory.readSync()); count++) {
                        if (includeNames && names.length < 8) names.push(entry.name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'�').slice(0,160));
                    }
                } finally { directory.closeSync(); }
                if (count) {
                    temporary = {directory:w.temporaryDirectory,count,bounded:count===1000,...(includeNames?{names}:{})};
                    reasons.push('WORKSPACE_TEMPORARY_ARTIFACTS');
                }
            }
            // Occupancy and saved content are separate observations. Scope
            // them to the still-registered, real checkout before probing.
            const metadata=lstatSync(w.cwd,{throwIfNoEntry:false});
            if (metadata?.isDirectory() && realpathSync(w.cwd)===w.cwd && metadata.uid===process.getuid?.()) {
                const current=checkout ?? await checkoutEvidence(w.cwd,w.repository);
                if (current.dirty) reasons.push('staged_unstaged_or_untracked');
                if (current.directory==='present' && typeof current.dirty==='boolean') {
                    try {
                        const activity=await this.activity(w,snapshot.tasks);
                        if (!activity.confirmed) reasons.push('activity_unconfirmed');
                        reasons.push(...activity.blockers);
                    } catch { reasons.push('activity_unconfirmed'); }
                }
            }
        } catch(error) { reasons.push(error instanceof ApiError?error.code:'git_or_path_unconfirmed'); }
        if (!this.policy.allowApply) reasons.push('policy_apply_disabled');
        if (w.retirement) reasons.push('retirement_in_progress');
        return {checkedAt:this.now(),reasons:[...new Set(reasons)].slice(0,32),temporary};
    }

    async detail(workspaceID: string, guidance = false, reclaim = false) {
        const item = this.overview(workspaceID), plan = await this.plan(workspaceID);
        let inspectedHead = plan.head, adoptionVerified = false;
        if (!item.managed && plan.workspaceState === 'active') {
            try { inspectedHead = (await this.inspectGit(this.snapshot(workspaceID).workspace, true)).head; adoptionVerified = true; }
            catch { /* Missing/unsafe legacy ownership remains unconfirmed, never auto-adopted. */ }
        }
        const reclaimGuidance = guidance ? await this.reclaimGuidance(workspaceID,undefined,true) : undefined;
        return { item: { ...item, ...(reclaim?this.requestedReclaimProjection(this.snapshot(workspaceID).workspace):{}), reclaimGuidance, reasons: [...plan.reasons,...item.reasons.filter(code=>code.startsWith('automatic_reclaim:'))] },
            plan, inspectedHead, adoptionVerified, result: this.result(workspaceID, undefined, true) };
    }
    async plan(workspaceID: string, acceptedForFinalize = false, automatic?: ReclaimTarget): Promise<WorkspacePlan> {
        const s=this.queue.transaction(state=>this.snapshotFor(state,workspaceID,!!automatic),true),w=s.workspace,r=this.read(w);
        const retired = w.retirement?.phase === 'retired';
        const reasons = retired ? ['already_retired'] : this.runtimeReasons(s);
        let state:GitState|undefined;
        if (!retired) {
            try {
                state=await this.inspectGit(w,false,automatic);
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
            if (w.retirement) reasons.push('retirement_in_progress');
            if (!this.policy.allowApply) reasons.push('policy_apply_disabled');
            if (w.execution.retireAfterIntegration && !acceptedForFinalize) reasons.push('business_acceptance_required');
        }
        const checkedAt=this.now();
        const body:Omit<WorkspacePlan,'id'>={version:1 as const,policy:this.policyHash,workspaceID,revision:r.revision,checkedAt,expiresAt:checkedAt+60000,
            workspaceState:w.retirement?.phase??'active',
            outcome:(retired&&r.disposition?'resolved':!state?'unknown':state.dirty||state.ignored?'pending_commit':r.disposition?.head===state.head?'resolved':state.head===w.baseCommit?'no_change_unreviewed':'pending_integration') as WorkspacePlan['outcome'],
            eligible:reasons.length===0,reasons:[...new Set(reasons)].sort(),binding:this.binding(w),git:state?.digest??fingerprint(null),tasks:this.taskDigest(s),
            head:retired?w.retirement?.retainedCommit:state?.head,branch:state?.branch,mainCommit:state?.mainCommit,remoteCommit:state?.remoteCommit,checkout:state?.checkout};
        return {...body,id:fingerprint(body)};
    }
    private async locked<T>(workspaceID:string,action:(fd:number)=>Promise<T>) {
        const fd=await workspaceLock(this.queue.directory,workspaceID);
        try {return await action(fd);} finally {closeSync(fd);}
    }
    private requestedReclaimProjection(w:Workspace) {
        const record=readReclaimRequest(this.queue.directory,w.id);
        return {canRequestReclaim:this.archiveActivity && w.managedBy && !w.execution.retireAfterIntegration ? this.policy.allowApply && !!w.branch && w.stage==='ready' && w.execution.mode==='worktree' && !w.execution.candidate && !w.retirement
            && (!record || record.progress.state==='attention') : undefined,
            reclaimRequest:record?.binding===this.binding(w) && record.projectID===this.policy.projectID ? record.progress : undefined};
    }

    async requestReclaim(workspaceID:string,ownerID:string):Promise<WorkspaceReclaimProgress> {
        if (this.queue.access.readOnly || !this.policy.allowApply || !this.archiveActivity) error('WORKSPACE_APPLY_DISABLED');
        return this.locked(workspaceID,async()=>{
            await this.authorize();
            const {workspace:w}=this.snapshot(workspaceID);
            this.ownership(w,false,false);
            if (w.execution.mode!=='worktree'||w.execution.candidate) error('WORKTREE_NOT_MANAGED');
            if(w.execution.retireAfterIntegration)error('business_acceptance_required');
            return this.queue.transaction(state=>{
                const current=this.snapshotFor(state,w.id,true).workspace;
                const binding=this.binding(current), previous=readReclaimRequest(this.queue.directory,w.id);
                if (previous) {
                    if(previous.ownerID!==ownerID || previous.binding!==binding || previous.policy!==this.policyHash)
                        error('WORKSPACE_AUTHORIZATION_CHANGED');
                    if(previous.progress.state==='attention' && !current.retirement)
                        saveReclaimRequest(this.queue.directory,{...previous,nextAt:this.now()});
                    return previous.progress;
                }
                if(current.retirement) error('WORKSPACE_RETIRED');
                const progress:WorkspaceReclaimProgress={operationID:hash('requested-reclaim:v1:'+binding),state:'waiting',updatedAt:this.now()};
                saveReclaimRequest(this.queue.directory,{workspaceID:w.id,binding,projectID:w.projectID,ownerID,policy:this.policyHash,
                    progress,nextAt:this.now(),attempts:0});
                return progress;
            });
        });
    }

    async requestedReclaimDue(root:string,ownerID:string) {
        if(this.queue.access.readOnly||!this.policy.allowApply||!this.archiveActivity) return;
        const due=dueRequestedReclaims(this.queue.directory,this.now()).filter(record=>record.projectID===this.policy.projectID&&record.ownerID===ownerID)
            .sort((a,b)=>a.nextAt-b.nextAt||a.workspaceID.localeCompare(b.workspaceID));
        if(!due.length)return;
        await this.locked(due[0].workspaceID,async(fd)=>{
            let request=readReclaimRequest(this.queue.directory,due[0].workspaceID);
            if(!request||request.progress.state==='released'||request.nextAt>this.now())return;
            let recoveryLocation:string|undefined;
            const publish=(state:WorkspaceReclaimProgress['state'],reason?:string,archive?:WorkspaceReclaimProgress['archive'])=>{
                const previous=request!;
                const attempts=previous.progress.reason===reason?Math.min(previous.attempts+1,8):0;
                const nextAt=state==='released'?0:this.now()+Math.min(30_000*2**attempts,state==='attention'?1_800_000:300_000);
                request={...previous,attempts,nextAt,progress:{operationID:previous.progress.operationID,state,reason,archive,recoveryLocation,updatedAt:this.now()}};
                saveReclaimRequest(this.queue.directory,request);
            };
            try {
                await this.authorize();
                const snapshot=()=>this.queue.transaction(state=>this.snapshotFor(state,request!.workspaceID,true),true);
                const initial=snapshot(), w=initial.workspace;
                if(request.binding!==this.binding(w)||request.policy!==this.policyHash) error('WORKSPACE_AUTHORIZATION_CHANGED');
                const id=request.progress.operationID;
                if(w.retirement&&w.retirement.operationID!==id) {
                    if(w.retirement.phase==='retired'&&this.result(w.id).operation?.state==='removed') {publish('released');return;}
                    error('retirement_in_progress');
                }
                this.ownership(w,false,false);
                const latestTask=initial.tasks.at(-1);
                if(!latestTask || initial.tasks.some(t=>t.sessionID!==w.sessionID)) error('WORKSPACE_SHARED_TASKS');
                if(initial.others.length || initial.related.length || initial.tasks.some(t=>!terminalTask(t)))
                    error('queued_running_or_recovery_reference');
                if(w.execution.retireAfterIntegration) error('business_acceptance_required');
                if([w.cwd,w.root,w.repository,w.temporaryDirectory].some(path=>overlaps(path,root))
                    || inside(root,join(this.queue.directory,'worktrees'))) error('WORKSPACE_ARCHIVE_NOT_INDEPENDENT');
                privateDirectory(root,true);
                const directory=join(root,id);
                const store=new MetadataStore(directory,128*1024);
                const preparedSchema=z.strictObject({work:z.string(),temporary:z.string().optional(),index:commit,gitDirectory:absolute,admin:z.string(),
                    head:commit,branch:z.string(),integrated:z.boolean(),proof:dispositionSchema.shape.proof,
                    mainCommit:commit, retainedRef:z.string(),indexRef:z.string(),tasks:digest, thread:z.string().max(128).optional(),
                    fetched:gitArchiveMaterialSchema.optional(),reflog:gitArchiveMaterialSchema.optional()});
                const readPrepared=()=>{const raw=store.get('prepared');return raw?preparedSchema.parse(raw):undefined;};
                let prepared=readPrepared();
                if(prepared)recoveryLocation=directory;
                const retainedHistory=store.get('retained-history');
                if(retainedHistory){
                    await this.verifyGitMaterial(w,directory,id,'history','HEAD-reflog',gitArchiveMaterialSchema.parse(retainedHistory));
                    recoveryLocation=directory;
                }
                if(!prepared) {
                    const activity=await this.archiveActivity!(w,initial.tasks);
                    if(!activity.confirmed) error('activity_unconfirmed');
                    const canAskToClose=activity.blockers.length===1&&activity.blockers[0]==='live_session_or_process'
                        &&latestTask.state==='completed'&&initial.tasks.length===1;
                    if(activity.blockers.length&&!canAskToClose)error(activity.blockers[0]);
                    const git=await this.inspectGit(w,false,undefined,true,true);
                    let target:ReclaimTarget|undefined;
                    try {target=await proveReclaimTarget(this.policy,w.repository,directory,{head:git.head,branch:git.branch,base:w.baseCommit!});}
                    catch(e) {
                        if(!(e instanceof ApiError)||e.code!=='WORKSPACE_NOT_IN_MAIN'||!this.policy.allowArchive) throw e;
                    }
                    if(canAskToClose) {
                        await this.authorize();
                        if(target&&requestWorkspaceIdleClose(this.queue.directory,this.policy.machineID,w,latestTask,this.now())
                            &&workspaceIdleEvidence(this.queue.directory,w.id,latestTask)) {
                            publish('closing','workspace_idle_close_pending');return;
                        }
                        error('live_session_or_process');
                    }
                    const thread=workspaceIdleEvidence(this.queue.directory,w.id,latestTask,this.now());
                    if(thread===undefined)error('WORKSPACE_RECOVERY_UNCONFIRMED');
                    // A verified Git history can be retained independently of
                    // a checkout that still contains unarchivable shared files.
                    const reflog=await this.archiveGitMaterial(w,directory,id,'history','HEAD-reflog',git.reflog,fd);
                    if(reflog){
                        await this.verifyGitMaterial(w,directory,id,'history','HEAD-reflog',reflog);
                        this.writeRecoveryFile(join(directory,'GIT-HISTORY.txt'),[
                            'Each HEAD-reflog file is an exact copy of worktree-local Git metadata.',
                            `Pinned commits are under refs/happy/workspace-history/${id}/.`,
                            'This preserves Git history only. Follow the Owner receipt for the status of the workspace and its files.',
                            '',
                        ].join('\n'));
                        store.set('retained-history',reflog);
                        recoveryLocation=directory;
                    }
                    const priorArchive=request.progress.state==='archiving';
                    if(['WORKSPACE_ARCHIVE_LIMIT','WORKSPACE_ARCHIVE_UNSUPPORTED_FILE'].includes(request.progress.reason??'')) {
                        // Reject external aliases on a retry without hashing gigabytes of shared files.
                        archiveTree(w.cwd,undefined,true);
                        archiveTree(w.temporaryDirectory,undefined,true);
                    }
                    if(!priorArchive)publish('archiving');
                    const work=archiveTree(w.cwd), temporary=archiveTree(w.temporaryDirectory);
                    if(!work) error('WORKSPACE_ARCHIVE_CHANGED');
                    const index=await this.reclaimIndex(w,directory,fd);
                    const gitDirectory=await this.reclaimGitDirectory(w,fd),admin=archiveTree(gitDirectory,'happy-reclaim:'+id);
                    if(!admin)error('WORKSPACE_ARCHIVE_CHANGED');
                    const retainedRef=`refs/happy/workspaces/${w.id}/${git.head}`,indexRef=`refs/happy/workspace-index/${id}/${index}`;
                    await this.ensureReclaimRef(w,retainedRef,git.head,fd);
                    await this.ensureReclaimRef(w,indexRef,index,fd);
                    const fetched=await this.archiveGitMaterial(w,directory,id,'fetch','FETCH_HEAD',git.fetched,fd);
                    prepared=preparedSchema.parse({work,temporary,index,gitDirectory,admin,fetched,reflog,head:git.head,branch:git.branch,integrated:!!target,
                        proof:target?.proof??'retained-ref',mainCommit:target?.commit??git.mainCommit,retainedRef,indexRef,tasks:this.taskDigest(initial),thread:thread??undefined});
                    store.set('prepared',prepared);
                    recoveryLocation=directory;
                }
                const original=prepared;
                if(fingerprint(readPrepared())!==fingerprint(original)||original.tasks!==this.taskDigest(snapshot())) error('WORKSPACE_ARCHIVE_CHANGED');
                if(await this.git(w.root,['rev-parse','--verify',original.retainedRef])!==original.head
                    || await this.git(w.root,['rev-parse','--verify',original.indexRef+'^{tree}'])!==original.index) error('WORKSPACE_ARCHIVE_CHANGED');
                await this.verifyGitMaterial(w,directory,id,'fetch','FETCH_HEAD',original.fetched);
                await this.verifyGitMaterial(w,directory,id,'history','HEAD-reflog',original.reflog);
                const checkout=join(directory,'checkout'),temporaryPath=join(directory,'temporary');
                const wExists=!!lstatSync(w.cwd,{throwIfNoEntry:false}), tExists=!!lstatSync(w.temporaryDirectory,{throwIfNoEntry:false});
                if(wExists || tExists) {
                    const live=await this.archiveActivity!(w,initial.tasks);
                    if(!live.confirmed)error('activity_unconfirmed');
                    if(live.blockers.length)error(live.blockers[0]);
                }
                if (wExists) {
                    const current=await this.inspectGit(w,false,undefined,true,true);
                    if(current.head!==original.head||current.branch!==original.branch
                        ||await this.reclaimIndex(w,directory,fd)!==original.index) error('WORKSPACE_ARCHIVE_CHANGED');
                } else if (!w.retirement) error('WORKSPACE_RECOVERY_UNCONFIRMED');
                if (original.integrated && wExists) {
                    const confirm=await readReclaimTarget(this.policy);
                    if(confirm.commit!==original.mainCommit) await proveReclaimTarget(this.policy,w.repository,directory,
                        {head:original.head,base:w.baseCommit!,branch:original.branch});
                }
                if(wExists&&!w.retirement&&!this.read(w).operations.some(op=>op.id===id)
                    && !lstatSync(checkout,{throwIfNoEntry:false})&&!lstatSync(temporaryPath,{throwIfNoEntry:false})
                    && (archiveTree(w.cwd)!==original.work||archiveTree(w.temporaryDirectory)!==original.temporary
                        ||archiveTree(original.gitDirectory,'happy-reclaim:'+id)!==original.admin
                        ||(await this.fetchedHistory(w.cwd,original.gitDirectory))?.digest!==original.fetched?.digest
                        ||(original.reflog&&this.reflogMaterial(original.gitDirectory)?.digest!==original.reflog.digest))) {
                    // Nothing moved. A new snapshot may safely include the new
                    // file on a later tick while this intent stays stable.
                    store.delete('prepared');
                    error('WORKSPACE_ARCHIVE_SETTLING');
                }
                await this.authorize();
                const current=this.read(w);
                let operation=current.operations.find(op=>op.id===id);
                if(operation?.state!=='removed') {
                    if(!operation) {
                        current.disposition=dispositionSchema.parse({kind:original.integrated?'integrated':'archived',head:original.head,
                            mainCommit:original.mainCommit,remoteCommit:original.integrated?original.mainCommit:undefined,proof:original.proof,
                            retainedRef:original.retainedRef,policy:this.policyHash,source:'one-click:'+id,recordedAt:this.now(),
                            taskDigest:original.tasks,sourceTaskID:latestTask.id,sourceRequestID:latestTask.requestID});
                        operation={id,fingerprint:fingerprint(original),state:'applying',revision:++current.revision,
                            head:original.head,branch:original.branch,retainedRef:original.retainedRef};
                        this.add(current,operation);this.write(w,current);
                    } else if (operation.fingerprint!==fingerprint(original)||operation.state!=='applying') error('WORKSPACE_ARCHIVE_CHANGED');
                    this.queue.transaction(state=>{
                        const next=this.snapshotFor(state,w.id,true), retirement=next.workspace.retirement;
                        if(this.taskDigest(next)!==original.tasks||retirement&&retirement.operationID!==id) error('WORKSPACE_ARCHIVE_CHANGED');
                        if(!retirement) next.workspace.retirement={operationID:id,phase:'retiring',retainedRef:original.retainedRef,retainedCommit:original.head};
                    });
                }
                if(wExists || tExists) {
                    const finalActivity=await this.archiveActivity!(w,initial.tasks);
                    if(!finalActivity.confirmed)error('activity_unconfirmed');
                    if(finalActivity.blockers.length)error(finalActivity.blockers[0]);
                }
                this.authorizationCurrent();
                // The original trees move out of Git's reach. A normal, non-force
                // Git remove then clears only the resulting missing registration.
                archiveMove(w.temporaryDirectory,temporaryPath,original.temporary);
                archiveMove(w.cwd,checkout,original.work);
                const registry=this.entry(await this.registry(w),w.cwd);
                if(registry) {
                    if(resolve(original.gitDirectory,'..')!==join(w.repository,'worktrees')) error('WORKSPACE_REGISTRY_CHANGED');
                    if(!registry.split('\n').includes('HEAD '+original.head) || !registry.split('\n').includes('branch refs/heads/'+original.branch)
                        || /\nlocked(?: |$)/.test(registry)) error('WORKSPACE_REGISTRY_CHANGED');
                    const retainedActivity=await this.archiveActivity!(w,initial.tasks,id);
                    if(!retainedActivity.confirmed) error('activity_unconfirmed');
                    if(retainedActivity.blockers.length) error(retainedActivity.blockers[0]);
                    await withArchiveIndexFence(original.gitDirectory,original.admin,id,async()=>{
                        this.authorizationCurrent();
                        if(lstatSync(w.cwd,{throwIfNoEntry:false})) error('WORKSPACE_ARCHIVE_CHANGED');
                        if(await this.git(w.root,['rev-parse','--verify','refs/heads/'+original.branch],fd)!==original.head)
                            error('WORKSPACE_ARCHIVE_CHANGED');
                        await this.git(w.root,['worktree','remove','--',w.cwd],fd);
                    });
                }
                if(lstatSync(w.cwd,{throwIfNoEntry:false})||this.entry(await this.registry(w),w.cwd)) error('WORKSPACE_REMOVAL_UNCONFIRMED');
                this.writeRecoveryFile(join(directory,'RECOVERY.txt'),this.reclaimRecoveryGuide(w,original,checkout,id));
                if(operation.state!=='removed') this.finish(w,current,operation,registry?'git-confirmed':'absence-after-intent');
                publish('released',undefined,{directory,checkout,temporary:original.temporary?temporaryPath:undefined,
                    commit:original.head,indexRef:original.indexRef,integrated:original.integrated});
            } catch(error) {
                const reason=error instanceof ApiError?error.code:'WORKSPACE_ARCHIVE_UNAVAILABLE';
                publish(['queued_running_or_recovery_reference','activity_unconfirmed','live_session_or_process','open_file_reference',
                    'process_entrypoint_reference','mount_reference','WORKSPACE_REMOTE_UNCONFIRMED','retirement_in_progress','WORKSPACE_ARCHIVE_SETTLING'].includes(reason)
                    ?'waiting':'attention',reason);
            }
        });
    }

    private writeRecoveryFile(path:string,contents:string) {
        if(!lstatSync(path,{throwIfNoEntry:false})){
            const output=openSync(path,constants.O_EXCL|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
            try{writeFileSync(output,contents);fsyncSync(output);}finally{closeSync(output);}
        }
        if(privateRead(path,32*1024).toString('utf8')!==contents)error('WORKSPACE_ARCHIVE_CHANGED');
    }

    private reclaimRecoveryGuide(w:Workspace,entry:{retainedRef:string;indexRef:string;fetched?:GitArchiveMaterial;reflog?:GitArchiveMaterial},checkout:string,operationID:string) {
        const q=(value:string)=>"'" + value.replaceAll("'", "'\\''") + "'";
        const path=join(this.queue.directory,'restored',w.id);
        return [
            'Preserved checkout. Run the commands only when you decide to restore it on the execution computer.',
            'The destination is a fresh checkout; keep the archive itself as evidence.',
            `git -C ${q(w.root)} worktree add --no-checkout --detach ${q(path)} ${q(entry.retainedRef)}`,
            `git -C ${q(path)} read-tree ${q(entry.indexRef)}`,
            `tar --exclude=./.git -cf - -C ${q(checkout)} . | tar -xf - -C ${q(path)}`,
            'Temporary files, if present, are in the sibling temporary directory.',
            ...entry.fetched?[`The preserved FETCH_HEAD metadata is in FETCH_HEAD-${entry.fetched.digest}.`,
                `Fetched commits are retained under refs/happy/workspace-fetch/${operationID}/.`]:[],
            ...entry.reflog?[`The preserved worktree HEAD reflog is in HEAD-reflog-${entry.reflog.digest}.`,
                `Local history is retained under refs/happy/workspace-history/${operationID}/. These refs do not certify delivery.`]:[],
            'Only use the commands as a sequence after the preceding command succeeds. Review archived symlinks before following them.',
            '',
        ].join('\n');
    }

    private async archiveGitMaterial(w:Workspace,directory:string,id:string,kind:'fetch'|'history',
        name:string,material:GitMaterial|undefined,lockFD:number) {
        if(!material)return;
        const {digest,commits,bytes}=material;
        const path=join(directory,name+'-'+digest);
        if(!lstatSync(path,{throwIfNoEntry:false})) {
            const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
            try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
        }
        for(const oid of commits)await this.ensureReclaimRef(w,`refs/happy/workspace-${kind}/${id}/${oid}`,oid,lockFD);
        return {digest,commits};
    }

    private async verifyGitMaterial(w:Workspace,directory:string,id:string,kind:'fetch'|'history',
        name:string,material?:GitArchiveMaterial) {
        if(!material)return;
        const bytes=privateRead(join(directory,name+'-'+material.digest),65536);
        if(hash(bytes.toString('base64'))!==material.digest)error('WORKSPACE_ARCHIVE_CHANGED');
        for(const oid of material.commits) {
            if(await this.git(w.root,['rev-parse','--verify',`refs/happy/workspace-${kind}/${id}/${oid}`])!==oid)
                error('WORKSPACE_ARCHIVE_CHANGED');
        }
    }

    private async ensureReclaimRef(w:Workspace,ref:string,object:string,fd:number) {
        let previous:string|undefined;
        try {previous=await this.git(w.root,['rev-parse','--verify',ref],fd);} catch {/* A new private recovery ref. */}
        if(!previous) await this.git(w.root,['update-ref',ref,object,'0'.repeat(object.length)],fd);
        if(await this.git(w.root,['rev-parse','--verify',ref],fd)!==object) error('WORKSPACE_ARCHIVE_CHANGED');
    }

    private async reclaimGitDirectory(w:Workspace,fd:number) {
        const gitDirectory=await this.git(w.cwd,['rev-parse','--absolute-git-dir'],fd);
        if(realpathSync(gitDirectory)!==gitDirectory||resolve(gitDirectory,'..')!==join(w.repository,'worktrees'))
            error('WORKSPACE_REGISTRY_CHANGED');
        return gitDirectory;
    }

    private async reclaimIndex(w:Workspace,directory:string,fd:number) {
        const index=join(await this.reclaimGitDirectory(w,fd),'index');
        const snapshot=join(directory,'index-'+randomUUID());
        try {
            if(lstatSync(index,{throwIfNoEntry:false})) {
                const source=openSync(index,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
                try {
                    const stat=fstatSync(source);
                    if(!stat.isFile()||stat.nlink!==1||stat.size>32*1024*1024||stat.uid!==process.getuid?.())
                        error('WORKSPACE_ARCHIVE_UNSUPPORTED_FILE');
                    writeFileSync(snapshot,readFileSync(source),{flag:'wx',mode:0o600});
                } finally {closeSync(source);}
            }
            return commit.parse(await this.git(w.cwd,['write-tree'],fd,30_000,snapshot));
        } finally {if(lstatSync(snapshot,{throwIfNoEntry:false}))unlinkSync(snapshot);}
    }

    async reclaimDue(archiveDirectory: string, limit = 1) {
        if (this.queue.access.readOnly || !this.policy.allowApply || !this.policy.remote) return;
        const now = this.now();
        const workspaces = this.queue.transaction(state => state.workspaces.filter(w => w.projectID === this.policy.projectID
            && w.grantID === this.policy.grantID && w.root === this.policy.root && w.stage === 'ready'), true);
        const due = workspaces.flatMap(w => {
            const record = reclaimRecord(this.queue.directory, w);
            if(readReclaimRequest(this.queue.directory,w.id))return [];
            return record && record.status.state !== 'released' && record.nextAt <= now ? [{w, record}] : [];
        }).sort((a,b) => a.record.nextAt - b.record.nextAt || a.w.id.localeCompare(b.w.id)).slice(0, limit);
        for (const {w} of due) {
            await this.locked(hash('automatic-retirement:' + w.id), async () => {
                const current = reclaimRecord(this.queue.directory, w);
                if (!current || current.status.state === 'released' || current.nextAt > this.now() || readReclaimRequest(this.queue.directory,w.id)) return;
                let operationID = hash('automatic-retirement:v1:' + w.id);
                let reason: string | undefined;
                try {
                    const snapshot = this.snapshot(w.id);
                    // A fresh attempt is allowed only after the previous operation
                    // durably failed with a verified intact checkout and no fence.
                    for (let attempt = 0; attempt < 3; attempt++) {
                        if (snapshot.workspace.retirement?.operationID === operationID) break;
                        const previous = this.result(w.id, operationID).operation;
                        if (previous?.state !== 'failed' || !['WORKTREE_REMOVE_REFUSED', 'WORKSPACE_IN_USE',
                                'WORKSPACE_PLAN_CHANGED','WORKSPACE_PLAN_EXPIRED_OR_BLOCKED'].includes(previous.reason ?? '')) break;
                        operationID = hash(operationID + ':retry');
                    }
                    reason = await this.reclaimOne(w.id, operationID, archiveDirectory);
                }
                catch (e) { reason = e instanceof ApiError ? e.code : 'WORKSPACE_INSPECTION_UNCONFIRMED'; }
                const waiting = reason && ['WORKSPACE_REMOTE_UNCONFIRMED','WORKSPACE_NOT_IN_MAIN','queued_running_or_recovery_reference',
                    'task_running','workspace_idle_close_pending','live_session_or_process','open_file_reference','process_entrypoint_reference','mount_reference',
                    'WORKSPACE_IN_USE','activity_unconfirmed','WORKSPACE_CONTROL_UNAVAILABLE','WORKSPACE_MANAGER_BUSY',
                    'WORKTREE_PREPARATION_UNCONFIRMED'].includes(reason);
                const status: ReclaimStatus = reason ? {state:waiting?'waiting':'attention',reason,operationID}
                    : {state:'released',operationID:this.result(w.id).operation?.id ?? operationID};
                const attempt = current.status.reason === status.reason ? Math.min(current.attempt + 1, 10) : 0;
                const nextAt = status.state === 'released' ? 0 : this.now() + Math.min(30_000 * 2 ** attempt,
                    status.state === 'attention' ? 3_600_000 : 300_000);
                saveReclaimStatus(this.queue.directory,{...current,status,attempt,nextAt});
            });
        }
    }

    private async reclaimOne(workspaceID: string, operationID: string, archiveDirectory: string): Promise<string | undefined> {
        await this.authorize();
        const s = this.queue.transaction(state=>this.snapshotFor(state,workspaceID,true),true), w = s.workspace;
        if (!reclaimRecord(this.queue.directory,w)) return 'WORKSPACE_OWNER_UNCONFIRMED';
        const existing = this.result(workspaceID,operationID).operation;
        if (w.retirement?.phase === 'retired' && this.result(w.id).operation?.state === 'removed') return undefined;
        if (s.tasks.some(t => !terminalTask(t)) || s.related.length || s.others.length) return 'queued_running_or_recovery_reference';
        if (s.tasks.length === 0) return 'task_running';
        const [task] = s.tasks;
        if (s.tasks.length !== 1 || task.sessionID !== w.sessionID) return 'WORKSPACE_SHARED_TASKS';
        if (task.worktreeDirty === true) return 'WORKSPACE_UNSAVED_ARTIFACTS';
        if (!w.baseCommit || !w.branch || task.state !== 'completed' || !task.dispatched || !task.resultCommit || task.worktreeDirty !== false)
            return 'WORKSPACE_RESULT_UNCONFIRMED';
        if ([w.cwd,w.root,w.repository].some(path=>overlaps(path,archiveDirectory))
            || inside(archiveDirectory,join(this.queue.directory,'worktrees'))) return 'WORKSPACE_ARCHIVE_NOT_INDEPENDENT';

        const archive = new MetadataStore(archiveDirectory,128*1024), key = 'reclaim:' + operationID;
        const targetSchema = z.strictObject({commit,head:commit,remoteURL:z.string().min(1).max(4096),
            proof:z.enum(['ancestor','exact-content','pull-request'])});
        const savedSchema = z.strictObject({ binding:digest,tasks:digest,policy:digest,target:targetSchema,plan:planSchema,
            requestID:id,sessionID:id,taskID:id,retainedRef:z.string().max(256),closedThread:id.optional() });
        const saved = archive.get(key);
        let entry;
        if (existing) {
            if (!saved) return 'WORKSPACE_RECOVERY_UNCONFIRMED';
            entry = savedSchema.parse(saved);
            if (existing.state === 'failed' && w.retirement?.operationID !== operationID)
                return existing.reason ?? 'WORKTREE_REMOVE_REFUSED';
        } else {
            this.ownership(w);
            const target = await proveReclaimTarget(this.policy,w.repository,archiveDirectory,
                {head:task.resultCommit,base:w.baseCommit,branch:w.branch});
            const preview = await this.plan(w.id,true,target);
            const blockers = preview.reasons.filter(reason => !['result_needs_disposition','no_change_needs_resolution',
                'target_main_changed_reverify_disposition','policy_changed_reverify_disposition','result_changed_reverify_disposition'].includes(reason));
            if (blockers.length) {
                if (blockers.length===1 && blockers[0]==='live_session_or_process') {
                    await this.authorize();
                    if (this.queue.transaction(state => this.taskDigest(this.snapshotFor(state,w.id,true)) === this.taskDigest(s)
                        && requestWorkspaceIdleClose(this.queue.directory,this.policy.machineID,w,task,this.now()),true))
                        return workspaceIdleEvidence(this.queue.directory,w.id,task)?'workspace_idle_close_pending':'live_session_or_process';
                }
                return blockers[0];
            }
            const closedThread = workspaceIdleEvidence(this.queue.directory,w.id,task,preview.checkedAt);
            if (closedThread === undefined) return 'WORKSPACE_RECOVERY_UNCONFIRMED';
            const kind = target.head === w.baseCommit ? 'no-change' : 'integrated';
            const current = this.read(w);
            if (current.disposition?.head !== target.head || current.disposition.kind !== kind
                || current.disposition.remoteCommit !== target.commit || current.disposition.policy !== this.policyHash
                || current.disposition.taskDigest !== this.taskDigest(s)) {
                await this.resolve(w.id,{operationID:hash(operationID + ':proof:' + current.revision),expectedRevision:current.revision,
                    head:target.head,kind,source:'automatic-remote-proof:' + operationID},target);
            }
            const plan = await this.plan(w.id,true,target);
            if (!plan.eligible) return plan.reasons[0] ?? 'WORKSPACE_INSPECTION_UNCONFIRMED';
            const disposition=this.read(w).disposition!;
            entry = savedSchema.parse({binding:this.binding(w),tasks:this.taskDigest(s),policy:this.policyHash,target,plan,
                requestID:task.requestID,sessionID:task.sessionID,taskID:task.id,retainedRef:disposition.retainedRef,
                closedThread:closedThread ?? undefined});
            archive.set(key,entry);
        }
        const evidence = entry;
        const verifyArchive = () => {
            const current = this.queue.transaction(state=>this.snapshotFor(state,w.id,true),true);
            if (fingerprint(savedSchema.parse(archive.get(key))) !== fingerprint(evidence)
                || evidence.binding !== this.binding(current.workspace) || evidence.tasks !== this.taskDigest(current)
                || evidence.policy !== this.policyHash || evidence.target.head !== task.resultCommit)
                error('WORKSPACE_ARCHIVE_CHANGED');
        };
        verifyArchive();
        const result = await this.apply(evidence.plan,operationID,verifyArchive,evidence.target);
        return result.state === 'removed' ? undefined : result.reason ?? 'WORKSPACE_RECOVERY_UNCONFIRMED';
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
    async resolve(workspaceID:string,input:{operationID:string;expectedRevision:number;head:string;kind:z.infer<typeof dispositionSchema>['kind'];source:string;pullRequestMerge?:string}, automatic?: ReclaimTarget) {
        if(this.queue.access.readOnly)error('WORKSPACE_READ_ONLY');
        id.parse(input.operationID);commit.parse(input.head);z.string().min(1).max(200).parse(input.source);
        return this.locked(workspaceID,async()=>{
            await this.authorize();
            const s=this.snapshot(workspaceID),w=s.workspace,r=this.read(w),fp=fingerprint({action:'resolve',policy:this.policyHash,workspaceID,...input});
            const old=this.receipt(r,input.operationID,fp);if(old)return old;
            if(r.operations.length>=16)error('WORKSPACE_OPERATION_LIMIT');
            if(r.revision!==input.expectedRevision||w.retirement)error('WORKSPACE_REVISION_CHANGED');
            const state=await this.inspectGit(w,false,automatic);
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
            if (automatic && ['integrated','no-change'].includes(input.kind)) proof=automatic.proof;
            else if(['integrated','no-change'].includes(input.kind)) {
                const target=state.remoteCommit??state.mainCommit;
                try {await this.git(w.root,['merge-base','--is-ancestor',state.head,target]);proof='ancestor';}
                catch {
                    if(input.kind==='no-change')error('WORKSPACE_NOT_IN_MAIN');
                    if(input.pullRequestMerge&&this.policy.delivery?.github) {
                        const provider=githubDelivery(this.policy.delivery.github,state.branch,this.policy.mainRef.slice('refs/heads/'.length),state.head);
                        const pr=await provider.read();
                        if(pr?.state!=='MERGED'||pr.mergeCommit?.oid!==input.pullRequestMerge
                            ||await integrationProof(w.root,pr.mergeCommit.oid,target)!=='ancestor')error('WORKSPACE_NOT_IN_MAIN');
                        proof='pull-request';
                    } else if(this.policy.delivery && await integrationProof(w.root,state.head,target,w.baseCommit)==='exact-content') proof='exact-content';
                    else {
                    await this.git(w.root,['merge-base','--is-ancestor',w.baseCommit!,target]);
                    if(await this.git(w.root,['rev-list','--merges',`${target}..${state.head}`]))error('WORKSPACE_EQUIVALENCE_UNCONFIRMED');
                    const cherry=await this.git(w.root,['cherry',target,state.head,w.baseCommit!]);
                    const count=Number(await this.git(w.root,['rev-list','--count',`${target}..${state.head}`]));
                    if(!cherry||cherry.split('\n').length!==count||cherry.split('\n').some(line=>!line.startsWith('- ')))error('WORKSPACE_NOT_IN_MAIN');
                    proof='patch-equivalent';
                    }
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
    /** The authenticated Workspace Owner supplies explicit business acceptance.
     * Evidence, disposition and apply each use the existing durable owner store. */
    async finalizeIntegrated(workspaceID: string, operationID: string, head: string, evidence: string, acceptedBy: string, delivery?:WorkspaceDeliveryReceipt) {
        id.parse(operationID); commit.parse(head);
        const acceptance = z.object({ evidence: z.string().trim().min(1).max(16000), acceptedBy: id }).parse({evidence,acceptedBy});
        await this.authorize();
        const initial = this.snapshot(workspaceID), w = initial.workspace;
        if (!w.execution.retireAfterIntegration || !this.policy.allowApply || !this.policy.automaticRetirementArchive)
            error('WORKSPACE_AUTOMATIC_RETIREMENT_DISABLED');
        this.ownership(w);
        const archive = this.policy.automaticRetirementArchive;
        if ([w.cwd, w.root, w.repository].some(path => overlaps(path, archive))
            || inside(archive, join(this.queue.directory, 'worktrees'))) error('WORKSPACE_ARCHIVE_NOT_INDEPENDENT');
        const store = new MetadataStore(archive, 128 * 1024, false), key = `finalize:${w.id}:${operationID}`;
        if(delivery&&(delivery.operationID!==operationID||delivery.head!==head||delivery.phase!=='merged'||delivery.testExitCode!==0||!delivery.mergedTarget))
            error('WORKSPACE_DELIVERY_RELEASE_UNCONFIRMED');
        const deliveryEvidence=delivery&&{head:delivery.head,remote:delivery.remote,targetRef:delivery.targetRef,branch:delivery.branch,
            testedOn:delivery.testedOn,testExitCode:delivery.testExitCode,
            pushedAt:delivery.pushedAt,mergedAt:delivery.mergedAt,mergedTarget:delivery.mergedTarget,pullRequest:delivery.pullRequest,pullRequestMerge:delivery.pullRequestMerge};
        const binding = { workspaceID, operationID, head, acceptance, policy: this.policyHash, ...(deliveryEvidence?{delivery:deliveryEvidence}:{}) };
        const archiveSchema = z.object({ binding: digest, tasks: digest, workspace: digest, evidence: z.json() }).strict();
        const archiveEvidence = (tasks: QueueTask[]) => JSON.parse(JSON.stringify({ acceptance, ...(deliveryEvidence?{delivery:deliveryEvidence}:{}), tasks: tasks.map(t => ({ id:t.id, requestID:t.requestID,
            sessionID:t.sessionID, turnID:t.turnID, seq:t.seq, resultCommit:t.resultCommit, test:t.testResult })) }));
        const planKey = key + ':plan';
        const loadPlan = () => {
            const saved = store.get(planKey);
            return saved ? planSchema.parse(saved) : undefined;
        };
        const load = () => {
            const raw = store.get<unknown>(key);
            if (!raw) return;
            const record = archiveSchema.parse(raw);
            const current = this.snapshot(workspaceID);
            if (record.binding !== fingerprint(binding) || record.workspace !== this.binding(w)
                || record.tasks !== this.taskDigest(current)
                || fingerprint(record.evidence) !== fingerprint(archiveEvidence(current.tasks)))
                error('WORKSPACE_ARCHIVE_CHANGED');
            return record;
        };
        const prior = load();
        let archivedPlan = loadPlan();
        const verifyArchive = () => {
            if (!load() || loadPlan()?.id !== archivedPlan?.id) error('WORKSPACE_ARCHIVE_CHANGED');
        };
        const previous = this.result(workspaceID,operationID).operation;
        if (prior && archivedPlan && previous) return this.apply(archivedPlan, operationID, verifyArchive);
        const planIsCurrent=(plan:WorkspacePlan)=>plan.checkedAt<=this.now()&&plan.expiresAt>=this.now();
        const plan = await this.plan(workspaceID);
        const retained = (reasons: string[]) => ({ id: operationID, fingerprint: fingerprint(binding), state: 'failed' as const,
            revision: this.read(w).revision, reason: [...new Set(reasons)].join(',').slice(0,2048) });
        if (plan.head !== head) return retained(['WORKSPACE_HEAD_CHANGED', ...plan.reasons]);
        const blockers = plan.reasons.filter(reason => !['result_needs_disposition','no_change_needs_resolution','business_acceptance_required'].includes(reason));
        if (initial.tasks.some(t => t.state !== 'completed' || !t.dispatched || t.worktreeDirty !== false || !t.resultCommit))
            blockers.push('WORKSPACE_ACCEPTED_RESULT_UNCONFIRMED');
        if (blockers.length) return retained(blockers);
        if (!prior) await this.locked(workspaceID,async()=>{
            if(!store.get(key))store.set(key,{binding:fingerprint(binding),workspace:this.binding(w),
                tasks:this.taskDigest(initial),evidence:archiveEvidence(initial.tasks)});
        });
        if (!load()) error('WORKSPACE_ARCHIVE_CHANGED');
        const kind = head === w.baseCommit ? 'no-change' : 'integrated';
        let disposition = this.read(w).disposition;
        if (!disposition || disposition.kind !== kind) {
            try {
                await this.resolve(workspaceID,{ operationID:hash('finalize-disposition:' + w.id + ':' + operationID), expectedRevision:plan.revision,
                    head, kind, source:'owner-business-acceptance:' + operationID, ...(delivery?.pullRequestMerge?{pullRequestMerge:delivery.pullRequestMerge}:{}) });
            } catch (e) { if (e instanceof ApiError) return retained([e.code]); throw e; }
            disposition=this.read(w).disposition;
        }
        if (!disposition || disposition.head !== head || disposition.kind !== kind || disposition.proof === 'retained-ref')
            return retained(['WORKSPACE_NOT_IN_MAIN']);
        if (!archivedPlan||!planIsCurrent(archivedPlan)) {
            const latest = await this.plan(workspaceID, true);
            if (!latest.eligible) return retained(latest.reasons);
            archivedPlan=await this.locked(workspaceID,async()=>{
                const cached=loadPlan();
                if(cached&&(planIsCurrent(cached)||this.result(workspaceID,operationID).operation))return cached;
                store.set(planKey,latest);
                return latest;
            });
        }
        if (!archivedPlan) error('WORKSPACE_ARCHIVE_CHANGED');
        return this.apply(archivedPlan,operationID,verifyArchive);
    }
    async apply(raw:WorkspacePlan,operationID:string, verifyArchive?: () => void, automatic?: ReclaimTarget) {
        if(this.queue.access.readOnly)error('WORKSPACE_READ_ONLY');
        id.parse(operationID);const parsed=planSchema.safeParse(raw);if(!parsed.success)error('WORKSPACE_PLAN_INVALID');
        const plan=parsed.data!,{id:planID,...body}=plan;
        if(planID!==fingerprint(body)||plan.policy!==this.policyHash)error('WORKSPACE_PLAN_INVALID');
        return this.locked(plan.workspaceID,async(fd)=>{
            await this.authorize();
            const s=this.snapshot(plan.workspaceID),w=s.workspace,r=this.read(w),fp=fingerprint({action:'apply',policy:this.policyHash,planID,operationID});
            let op=this.receipt(r,operationID,fp);
            if(op&&op.state!=='applying'){
                if(op.state==='failed'&&w.retirement?.operationID===operationID)return this.fail(w,r,op,op.reason??'WORKTREE_REMOVE_REFUSED',automatic);
                return op;
            }
            if(!this.policy.allowApply)error('WORKSPACE_APPLY_DISABLED');
            if(readReclaimRequest(this.queue.directory,w.id)) error('WORKSPACE_RECLAIM_REQUESTED');
            if (w.execution.retireAfterIntegration && !verifyArchive) error('WORKSPACE_BUSINESS_ACCEPTANCE_REQUIRED');
            verifyArchive?.();
            this.ownership(w);
            if(op&&w.retirement?.operationID===operationID&&!existsSync(w.cwd)&&!this.entry(await this.registry(w),w.cwd)) {
                if(!r.disposition||await this.git(w.root,['rev-parse','--verify',r.disposition.retainedRef])!==op.head)error('WORKSPACE_RECOVERY_UNCONFIRMED');
                return this.finish(w,r,op,'absence-after-intent');
            }
            // An archived, already fenced automatic operation can be reconciled
            // after a long stop. It still has to match a new full safety check.
            const recoverArchived=!!verifyArchive&&op?.state==='applying'&&w.retirement?.operationID===operationID;
            if((!recoverArchived&&(this.now()>plan.expiresAt||this.now()<plan.checkedAt))||!plan.eligible){
                if(op)return this.fail(w,r,op,'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED',automatic);
                error('WORKSPACE_PLAN_EXPIRED_OR_BLOCKED');
            }
            const check=await this.plan(plan.workspaceID, !!verifyArchive,automatic);
            if(op) {
                // Only our own persisted fence/revision may differ while recovering an interrupted command.
                check.revision=plan.revision;check.reasons=check.reasons.filter(x=>x!=='retirement_in_progress');check.eligible=check.reasons.length===0;
            }
            if(!check.eligible||check.binding!==plan.binding||check.git!==plan.git||check.tasks!==plan.tasks||check.revision!==plan.revision){
                if(op)return this.fail(w,r,op,'WORKSPACE_PLAN_CHANGED',automatic);
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
                    if(current.retirement||this.binding(current)!==plan.binding
                        || automatic && this.taskDigest(this.snapshotFor(q,w.id,true))!==plan.tasks || q.tasks.some(t=>(!terminalTask(t) || holdsReviewCheckout(t))&&(t.workspaceID===w.id||t.sessionID===w.sessionID||t.resources.some(x=>x.key===`checkout:${hash(w.cwd)}`
                        ||x.mode==='exclusive'&&(x.key==='machine'||x.key===`repo:${hash(w.repository)}`)))))error('WORKSPACE_IN_USE');
                    current.retirement={operationID,phase:'retiring',retainedRef:op!.retainedRef!,retainedCommit:op!.head!};
                });} catch {return this.fail(w,r,op,'WORKSPACE_IN_USE',automatic);}
            }
            // Network authorization precedes the last filesystem/activity probe.
            // It must not open an extra async gap after that safety snapshot.
            try { await this.authorize(); } catch { return this.fail(w,r,op,'WORKSPACE_AUTHORIZATION_CHANGED',automatic); }
            // Recheck after the durable fence; heavy work is outside the queue transaction.
            const latest=await this.plan(w.id, !!verifyArchive,automatic);
            if(latest.git!==plan.git||latest.tasks!==plan.tasks||latest.reasons.some(reason=>reason!=='retirement_in_progress'))return this.fail(w,r,op,'WORKSPACE_PLAN_CHANGED',automatic);
            try { verifyArchive?.(); } catch { return this.fail(w,r,op,'WORKSPACE_ARCHIVE_CHANGED',automatic); }
            try { this.authorizationCurrent(); } catch { return this.fail(w,r,op,'WORKSPACE_AUTHORIZATION_CHANGED',automatic); }
            if(!recoverArchived&&(this.now()>plan.expiresAt||this.now()<plan.checkedAt))return this.fail(w,r,op,'WORKSPACE_PLAN_EXPIRED_OR_BLOCKED',automatic);
            try {
                await this.git(w.root,['worktree','remove','--',w.cwd],fd);
            } catch {
                if(!existsSync(w.cwd)){op.reason='WORKSPACE_REMOVAL_UNCONFIRMED';this.write(w,r);error('WORKSPACE_REMOVAL_UNCONFIRMED');}
                return this.fail(w,r,op,'WORKTREE_REMOVE_REFUSED',automatic);
            }
            if(existsSync(w.cwd)||this.entry(await this.registry(w),w.cwd))error('WORKSPACE_REMOVAL_UNCONFIRMED');
            return this.finish(w,r,op,'git-confirmed');
        });
    }
    private async fail(w:Workspace,r:Record,op:z.infer<typeof operationSchema>,reason:string,automatic?:ReclaimTarget) {
        let intact=false;
        if(existsSync(w.cwd)&&op.checkout){try{intact=(await this.inspectGit(w,false,automatic,!!automatic)).checkout===op.checkout;}catch{/* Unknown keeps the fence. */}}
        if(!intact){op.state='applying';op.reason='WORKSPACE_RECOVERY_UNCONFIRMED';this.write(w,r);return op;}
        op.state='failed';op.reason=reason;r.revision++;op.revision=r.revision;this.write(w,r);
        // Clear only this operation's fence, only while the original path still exists.
        if(existsSync(w.cwd))this.queue.transaction(q=>{const current=q.workspaces.find(x=>x.id===w.id)!;if(current.retirement?.operationID===op.id&&current.retirement.phase==='retiring')delete current.retirement;});
        return op;
    }
    private finish(w:Workspace,r:Record,op:z.infer<typeof operationSchema>,removal:'git-confirmed'|'absence-after-intent') {
        this.queue.transaction(q=>{const current=q.workspaces.find(x=>x.id===w.id)!;if(current.retirement?.operationID!==op.id)error('WORKSPACE_RECOVERY_UNCONFIRMED');current.retirement!.phase='retired';});
        op.state='removed';delete op.reason;op.removal=removal;r.revision++;op.revision=r.revision;r.checkedAt=this.now();this.write(w,r);
        const reclaim = reclaimRecord(this.queue.directory,w);
        if (reclaim) saveReclaimStatus(this.queue.directory,{...reclaim,status:{state:'released',operationID:op.id},nextAt:0});
        return op;
    }
    result(workspaceID:string,operationID?:string,history=false) {
        const w=this.snapshot(workspaceID).workspace,r=this.read(w),last=operationID?r.operations.find(op=>op.id===operationID):r.operations.at(-1);
        return {workspaceID,revision:r.revision,workspaceState:w.retirement?.phase??'active',disposition:r.disposition,operation:last,
            ...(history?{operations:r.operations}:{}),
            rebuild:r.disposition?{command:'git',args:['-C',w.root,'worktree','add','-b',`recovered/${w.id}/${r.disposition.head.slice(0,12)}`,
                join(this.queue.directory,'restored',`${w.id}-${r.disposition.head.slice(0,12)}`),r.disposition.retainedRef]}:undefined};
    }
}
