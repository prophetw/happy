import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkspaceDelivery } from '@slopus/happy-wire';
import { workspaceGit } from './taskWorkspaces';

const sha = /^[a-f0-9]{40,64}$/;
export type GitWorkspace = { directory: string; branch?: string; head?: string };
export type DeliveryTarget = { root: string; mainRef: string; remote?: string; delivery?: { remoteURL: string } };

export async function gitWorkspaces(root: string): Promise<GitWorkspace[] | undefined> {
    try {
        let separator = '\0', result: string;
        try { result = await workspaceGit(root, ['worktree','list','--porcelain','-z']); }
        catch {
            // Git 2.34 does not support NUL-terminated worktree porcelain.
            result = await workspaceGit(root, ['-c','core.quotePath=false','worktree','list','--porcelain']);
            separator = '\n';
        }
        return result.split(separator+separator).filter(Boolean).flatMap(block => {
            const [directory, ...fields] = block.split(separator);
            if (!directory.startsWith('worktree /') || /[\x00-\x1f]/.test(directory)) return [];
            const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
            const head = fields.find(field => field.startsWith('HEAD '))?.slice(5);
            return [{ directory: directory.slice(9), branch, head: head && sha.test(head) ? head : undefined }];
        });
    } catch { return undefined; }
}

export async function remoteDeliveryRefs(target: DeliveryTarget, branches: string[]): Promise<Map<string, string> | undefined> {
    if (!target.remote || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(target.remote)) return;
    const refs = new Set([target.mainRef, ...branches.map(branch => 'refs/heads/' + branch)]);
    try {
        if(target.delivery && await workspaceGit(target.root,['remote','get-url','--all',target.remote])!==target.delivery.remoteURL) return;
        const output = await workspaceGit(target.root, ['ls-remote','--refs','--',target.remote,...refs], undefined, 4500);
        const result = new Map<string, string>();
        for (const line of output.split('\n').filter(Boolean)) {
            const [head, ref] = line.split('\t');
            if (!sha.test(head) || !refs.has(ref) || result.has(ref)) return;
            result.set(ref, head);
        }
        if (result.has(target.mainRef)) return result;
    } catch { /* An unavailable remote leaves the merge status unknown. */ }
    return undefined;
}

function rawDiffRows(output: string): Map<string, string> {
    if(!output) return new Map();
    if(output.includes('\ufffd')||!output.endsWith('\0')) throw Error('Unconfirmed Git diff encoding');
    const fields = output.slice(0,-1).split('\0');
    if(fields.length%2) throw Error('Unconfirmed Git diff fields');
    const rows = new Map<string, string>();
    for (let i=0;i<fields.length;i+=2) {
        const path=fields[i+1];
        if(!path||rows.has(path)||!/^:[0-7]+ [0-7]+ [a-f0-9]+ [a-f0-9]+ [AMDT]$/.test(fields[i])) throw Error('Unconfirmed Git diff row');
        rows.set(path,fields[i]);
    }
    return rows;
}

/** A positive content proof requires every candidate path to have exactly the same
 * old/new object and mode delta from the same verified base. Other remote paths may differ. */
export async function integrationProof(root:string, head:string, target:string, base?:string): Promise<'ancestor' | 'exact-content' | 'pending' | undefined> {
    if(head===target && sha.test(head))return 'ancestor';
    try {
        if (await workspaceGit(root, ['merge-base',head,target]) === head) return 'ancestor';
        if (!base) return;
        if (await workspaceGit(root, ['merge-base','--octopus',head,target,base]) !== base) return;
        const diff = async (end:string) => rawDiffRows(await workspaceGit(root, ['diff','--raw','--no-abbrev','--no-renames','--no-ext-diff','-z',base,end,'--']));
        const [candidate, main] = await Promise.all([diff(head),diff(target)]);
        if (candidate.size && [...candidate].every(([path,delta]) => main.get(path) === delta)) return 'exact-content';
        return 'pending';
    } catch { return undefined; }
}

export async function checkoutEvidence(directory:string, repository:string):Promise<Pick<WorkspaceDelivery,'directory'|'dirty'|'untracked'>> {
    try {
        const st = lstatSync(directory,{throwIfNoEntry:false});
        if (!st) return { directory:'missing' };
        if (!st.isDirectory() || realpathSync(directory) !== directory) return { directory:'unknown' };
        const result: Pick<WorkspaceDelivery,'directory'|'dirty'|'untracked'> = { directory:'present' };
        const common = realpathSync(resolve(directory,await workspaceGit(directory,['rev-parse','--git-common-dir'])));
        if (common !== repository || await workspaceGit(directory,['rev-parse','--show-toplevel']) !== directory) return result;
        const entries = (await workspaceGit(directory,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none'])).split('\0');
        result.dirty = entries.some(Boolean);
        result.untracked = false;
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            if (entry.startsWith('?? ')) result.untracked = true;
            if (/^[RC]|^.[RC]/.test(entry)) index++; // Skip the original name in a rename/copy.
        }
        return result;
    } catch { return { directory:'unknown' }; }
}

/** Read back the pinned target through fetch when Git needs its commit objects.
 * This never updates a branch, tracking ref or FETCH_HEAD. */
export async function ensureTargetCommit(root:string, remote:string, targetRef:string, expected:string, lockFD:number) {
    try { await workspaceGit(root,['cat-file','-e',expected+'^{commit}'],lockFD); }
    catch {
        await workspaceGit(root,['fetch','--no-tags','--no-write-fetch-head','--refmap=','--',remote,targetRef],lockFD);
        await workspaceGit(root,['cat-file','-e',expected+'^{commit}'],lockFD);
    }
}
