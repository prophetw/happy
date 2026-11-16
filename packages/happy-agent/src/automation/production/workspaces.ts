import { userInfo } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { hash } from '../journal';
import { readProductionConfig } from './config';
import { privateDirectory, privateRead } from '../rest/privateFs';
import { TaskQueue } from '../rest/taskQueue';
import { ApiError } from '../rest/schema';
import { canonicalRepository, workspaceGit } from '../rest/taskWorkspaces';
import { directoryAllowed, directoryProjectID } from '../rest/schema';
import { WorkspaceLifecycle, workspacePolicySchema, type ActivityProbe } from '../rest/workspaceLifecycle';

const commands = {
    inventory: ['limit','after'], plan: ['id'], result: ['id'],
    adopt: ['id','operation-id','revision','head'], resolve: ['id','operation-id','revision','head','kind','source'],
    apply: ['operation-id','plan-file'],
} as const;
export const workspaceUsage = 'happy-control workspaces inventory|plan|result|adopt|resolve|apply --worker-config <private worker.json> --policy <private policy.json> [command options]';

/** Same owner-authoritative queue for local CLI and authenticated owner UI. */
export function openWorkspaceLifecycle(workerConfig: string, policyFile: string, options: {
    homeDirectory?: string; activity?: ActivityProbe; readOnly?: boolean; authorize?: () => void | Promise<void>;
    authorizationCurrent?: () => void; ownerDirectorySelection?: boolean;
} = {}) {
    const policy = workspacePolicySchema.parse(JSON.parse(privateRead(policyFile, 32768).toString('utf8')));
    const config = readProductionConfig(workerConfig);
    if (config.role !== 'worker' || config.registration.machineID !== policy.machineID) throw new ApiError('WORKSPACE_SCOPE_DENIED', 403);
    const known=config.registration.projects.find(p=>p.directory===policy.root);
    if (!(known ? known.id===policy.projectID : options.ownerDirectorySelection&&config.registration.directorySelection
        &&directoryAllowed(policy.root,config.registration.directorySelection.roots)&&policy.projectID===directoryProjectID(policy.root))) throw new ApiError('WORKSPACE_SCOPE_DENIED',403);
    const directory = join(options.homeDirectory ?? userInfo().homedir, '.local/state/happy-control/machines', hash(policy.machineID));
    privateDirectory(directory);
    if (!existsSync(join(directory, hash('queue') + '.json'))) throw new ApiError('QUEUE_NOT_INITIALIZED');
    const registration = config.registration, projectOverrides: Record<string, number> = {};
    for (const [path, limit] of Object.entries(registration.projectConcurrencyOverrides ?? {})) projectOverrides[canonicalRepository(path)] = limit;
    const queue = new TaskQueue(directory, { projectConcurrency: registration.projectConcurrency ?? 2,
        machineConcurrency: registration.machineConcurrency ?? registration.maxConcurrency ?? null, projectOverrides },
        { machineID: policy.machineID, readOnly: options.readOnly ?? true });
    return { lifecycle: new WorkspaceLifecycle(queue, policy, options.activity, Date.now, workspaceGit, options.authorize, options.authorizationCurrent), registration };
}

/** Local owner CLI only. No REST/MCP method, credential loading, worker startup or scanner. */
export async function workspaceCommand(argv: string[], options: { homeDirectory?: string; activity?: ActivityProbe } = {}) {
    const action = (argv[0]==='retire'?'apply':argv[0]) as keyof typeof commands;
    if (!Object.hasOwn(commands,action)) throw new ApiError('WORKSPACE_COMMAND_INVALID');
    const values: Record<string,string> = {}, allowed = new Set<string>(['worker-config','policy',...commands[action]]);
    for (let n=1;n<argv.length;n+=2) {
        const key=argv[n]?.slice(2),value=argv[n+1];
        if(!argv[n]?.startsWith('--')||!allowed.has(key)||value===undefined||Object.hasOwn(values,key))throw new ApiError('WORKSPACE_COMMAND_INVALID');
        values[key]=value;
    }
    const required=(name:string)=>{if(!values[name])throw new ApiError('WORKSPACE_COMMAND_INVALID');return values[name];};
    const { lifecycle } = openWorkspaceLifecycle(required('worker-config'), required('policy'), {
        ...options, readOnly: ['inventory','plan','result'].includes(action),
    });
    if (action === 'apply' && !lifecycle.policy.allowApply) throw new ApiError('WORKSPACE_APPLY_DISABLED', 403);
    const revision=()=>{const n=Number(required('revision'));if(!Number.isSafeInteger(n)||n<0)throw new ApiError('WORKSPACE_COMMAND_INVALID');return n;};
    if(action==='inventory')return lifecycle.inventory(values.limit===undefined?20:Number(values.limit),values.after??'');
    if(action==='plan')return lifecycle.plan(required('id'));
    if(action==='result')return lifecycle.result(required('id'));
    if(action==='adopt')return lifecycle.adopt(required('id'),required('operation-id'),revision(),required('head'));
    if(action==='resolve')return lifecycle.resolve(required('id'),{operationID:required('operation-id'),expectedRevision:revision(),head:required('head'),
        kind:required('kind') as 'integrated',source:required('source')});
    const file=JSON.parse(privateRead(required('plan-file'),32768).toString('utf8'));
    // Consume our actual stdout contract as well as the library's raw plan.
    // Failed responses and extra envelope fields are never treated as plans.
    if(file&&typeof file==='object'&&Object.hasOwn(file,'ok')){
        if(file.ok!==true||Object.keys(file).length!==2||!Object.hasOwn(file,'result'))throw new ApiError('WORKSPACE_PLAN_INVALID');
        return lifecycle.apply(file.result,required('operation-id'));
    }
    return lifecycle.apply(file,required('operation-id'));
}
export async function workspaceMain(argv:string[],options:Parameters<typeof workspaceCommand>[1] = {}) {
    if(argv.length===1&&argv[0]==='--help'){process.stdout.write(workspaceUsage+'\n');return;}
    try {
        const result=await workspaceCommand(argv,options);
        process.stdout.write(JSON.stringify({ok:true,result})+'\n');
        if('state' in result&&['applying','failed'].includes(String(result.state)))process.exitCode=1;
    } catch(e) {
        const code=e instanceof ApiError?e.code:'WORKSPACE_INSPECTION_UNCONFIRMED';
        process.stdout.write(JSON.stringify({ok:false,error:{code}})+'\n');process.exitCode=1;
    }
}
