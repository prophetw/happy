import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { workspaceReclaimProgressSchema } from '@slopus/happy-wire';
import { MetadataStore } from './store';

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.strictObject({
    workspaceID: hex, binding: hex, policy: hex, projectID: z.string(), ownerID: z.string(),
    progress: workspaceReclaimProgressSchema,
    nextAt: z.number().int(), attempts: z.number().int(),
});
export type ReclaimRequest = z.infer<typeof requestSchema>;

function store(directory:string, create=false, history=false) {
    const path=join(directory,history?'requested-reclaim-history':'requested-reclaims');
    return create || existsSync(path) ? new MetadataStore(path,32*1024,create) : undefined;
}
export function readReclaimRequest(directory:string,workspaceID:string) {
    const raw=store(directory,false,true)?.get(workspaceID) ?? store(directory)?.get(workspaceID);
    return raw ? requestSchema.parse(raw) : undefined;
}
export function saveReclaimRequest(directory:string,request:ReclaimRequest) {
    const pending=store(directory,true)!;
    const entry=requestSchema.parse(request);
    if (entry.progress.state!=='released') { pending.set(entry.workspaceID,entry);return; }
    const history=store(directory,true,true)!;
    history.set(entry.workspaceID,entry);
    if (requestSchema.parse(history.get(entry.workspaceID)).progress.state==='released') pending.delete(entry.workspaceID);
}
export function dueRequestedReclaims(directory:string,now:number) {
    return (store(directory)?.list<unknown>('')??[]).map(value=>requestSchema.parse(value)).filter(r=>r.nextAt<=now&&readReclaimRequest(directory,r.workspaceID)?.progress.state!=='released');
}
export function reclaimRequestFenced(directory:string,workspaceID:string) {
    const request=readReclaimRequest(directory,workspaceID);
    return !!request && !['released','attention'].includes(request.progress.state);
}
