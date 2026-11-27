import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { MetadataStore } from './store';
import { readLinuxProcess, retirementProcessProof } from './sessionProcessProofs';
import type { QueueTask, Workspace } from './taskQueue';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const requestSchema = z.strictObject({
    workspaceID: digest, sessionID: id, sequence: z.number().int().positive(), turnID: id,
    pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/), bootID: z.string().uuid(),
    expiresAt: z.number().int().nonnegative(),
});
type IdleRequest = z.infer<typeof requestSchema>;
const idleReceipt = z.strictObject({request:requestSchema,threadID:id});
const storePath = (queueDirectory:string) => join(queueDirectory,'workspace-idle-proofs');

export function requestWorkspaceIdleClose(directory: string, machineID: string, w: Workspace, task: QueueTask, now: number) {
    const proof = retirementProcessProof(join(directory,'session-process-proofs'),machineID,task.sessionID,w);
    if (!proof || !task.seq || !task.turnID) return false;
    const live = readLinuxProcess(proof.pid);
    if (!live || live.bootID!==proof.bootID || live.startTicks!==proof.startTicks || live.uid!==proof.uid
        || live.cwd!==w.cwd || live.cgroup!==proof.cgroup || live.processGroup!==proof.processGroup) return false;
    const store = new MetadataStore(storePath(directory),8192);
    const prior = requestSchema.safeParse(store.get(w.id));
    if (prior.success && prior.data.startTicks===live.startTicks && prior.data.pid===live.pid
        && prior.data.sessionID===task.sessionID && prior.data.turnID===task.turnID && prior.data.sequence===task.seq) {
        const saved = idleReceipt.safeParse(store.get('closed:'+w.id));
        if (prior.data.expiresAt>now || saved.success && JSON.stringify(saved.data.request)===JSON.stringify(prior.data)) return true;
    }
    const request = requestSchema.safeParse({workspaceID:w.id,sessionID:task.sessionID,sequence:task.seq,turnID:task.turnID,
        pid:live.pid,startTicks:live.startTicks,bootID:live.bootID,expiresAt:now+45_000});
    if (!request.success) return false;
    store.set(w.id,request.data);
    return true;
}

/** Run by the dedicated execution process. A request cannot signal another process. */
export function readWorkspaceIdleClose(cwd: string, workspaceID: string | undefined, sessionID: string, sequence: number | undefined) {
    if (!workspaceID || !digest.safeParse(workspaceID).success || !sequence
        || cwd !== join(dirname(dirname(cwd)),'worktrees',workspaceID)) return;
    const directory = storePath(dirname(dirname(cwd)));
    if (!existsSync(directory)) return;
    const value = requestSchema.safeParse(new MetadataStore(directory,8192,false).get(workspaceID));
    if (!value.success) return;
    const r = value.data, identity = readLinuxProcess(process.pid);
    if (!identity || r.workspaceID!==workspaceID || r.sessionID!==sessionID || r.sequence!==sequence
        || r.pid!==process.pid || r.bootID!==identity.bootID || r.startTicks!==identity.startTicks || r.expiresAt<Date.now()) return;
    return {directory,request:r};
}

export function acknowledgeWorkspaceIdleClose(close: {directory:string;request:IdleRequest}, threadID:string) {
    const store = new MetadataStore(close.directory,8192,false);
    const current = requestSchema.safeParse(store.get(close.request.workspaceID));
    if (current.success && JSON.stringify(current.data)===JSON.stringify(close.request))
        store.set('closed:' + close.request.workspaceID,idleReceipt.parse({request:close.request,threadID}));
}

/** Pass an unused observation only after a fresh, authoritative process and lease check. */
export function workspaceIdleEvidence(directory: string, workspaceID: string, task: QueueTask, confirmedUnusedAt?:number) {
    const path = storePath(directory);
    if (!existsSync(path)) return null;
    const store = new MetadataStore(path,8192,false);
    const raw = store.get(workspaceID);
    if (!raw) return null;
    const request = requestSchema.parse(raw);
    const receipt = idleReceipt.safeParse(store.get('closed:' + workspaceID));
    if(receipt.success && JSON.stringify(receipt.data.request)===JSON.stringify(request)
        && request.sessionID===task.sessionID && request.turnID===task.turnID && request.sequence===task.seq)
        return receipt.data.threadID;
    if(confirmedUnusedAt!==undefined&&request.workspaceID===workspaceID&&request.expiresAt<confirmedUnusedAt)return null;
    return undefined;
}

export function workspaceIdleCloseFenced(directory: string, workspaceID: string) {
    const path = storePath(directory);
    if (!existsSync(path)) return false;
    const store = new MetadataStore(path,8192,false);
    const raw = store.get(workspaceID);
    if (!raw) return false;
    const request = requestSchema.parse(raw);
    const receipt = idleReceipt.safeParse(store.get('closed:' + workspaceID));
    return request.expiresAt>=Date.now() || receipt.success && JSON.stringify(receipt.data.request)===JSON.stringify(request);
}
