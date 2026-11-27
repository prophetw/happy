import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ApiError } from './schema';
import { workspaceGit } from './taskWorkspaces';
import { integrationProof } from './workspaceDeliveryEvidence';
import { githubDelivery, type githubDeliveryPolicySchema } from './workspaceGithubDelivery';
import type { z } from 'zod';

type Policy = { root: string; remote?: string; mainRef: string; reclaimRemoteURL?: string; delivery?: {
    remoteURL: string; github?: z.infer<typeof githubDeliveryPolicySchema>;
} };
export type ReclaimTarget = { commit: string; remoteURL: string; head: string; proof: 'ancestor' | 'exact-content' | 'pull-request' };

export async function readReclaimTarget(policy: Policy): Promise<{ commit: string; remoteURL: string }> {
    const pin = policy.reclaimRemoteURL ?? policy.delivery?.remoteURL;
    if (!policy.remote || !pin) throw new ApiError('WORKSPACE_REMOTE_UNCONFIRMED', 409);
    const configured = await workspaceGit(policy.root, ['remote', 'get-url', '--all', policy.remote]);
    // Reject rewritten or ambiguous transport and query the already pinned URL.
    if (pin !== configured || /[\x00-\x20]/.test(pin) || pin.includes('::')
        || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(pin) && !/^(?:https|ssh|git|file):\/\//.test(pin)
        || /^https:\/\/[^/]*@/.test(pin))
        throw new ApiError('WORKSPACE_REMOTE_UNCONFIRMED', 409);
    try {
        const result = await workspaceGit(policy.root, ['ls-remote','--refs','--',pin,policy.mainRef],undefined,4500);
        const [commit,ref] = result.split('\t');
        if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit) && ref === policy.mainRef)
            return { commit, remoteURL:pin };
    } catch { /* An offline remote cannot prove integration. */ }
    throw new ApiError('WORKSPACE_REMOTE_UNCONFIRMED', 409);
}

export async function proveReclaimTarget(policy: Policy, repository: string, scratchRoot: string,
    candidate: { head: string; base: string; branch: string }): Promise<ReclaimTarget> {
    const target = await readReclaimTarget(policy);
    let scratch: string | undefined;
    try {
        let proofRoot = policy.root;
        const compare = async () => {
            const proof = await integrationProof(proofRoot, candidate.head, target.commit, candidate.base);
            if (proof === 'ancestor' || proof === 'exact-content') return proof;
            if (!policy.delivery?.github) return;
            const pr = await githubDelivery(policy.delivery.github, candidate.branch,
                policy.mainRef.slice('refs/heads/'.length), candidate.head).read();
            if (pr?.state === 'MERGED' && pr.mergeCommit?.oid
                && await integrationProof(proofRoot, pr.mergeCommit.oid, target.commit) === 'ancestor') return 'pull-request' as const;
            return undefined;
        };
        try { await workspaceGit(proofRoot, ['cat-file', '-e', target.commit + '^{commit}']); }
        catch {
            scratch = await mkdtemp(join(scratchRoot, 'git-proof-'));
            const format = await workspaceGit(policy.root, ['rev-parse', '--show-object-format']);
            await workspaceGit(scratch, ['init', '--bare', '--object-format=' + format]);
            await writeFile(join(scratch, 'objects', 'info', 'alternates'), join(repository, 'objects') + '\n', { mode: 0o600 });
            const transport = target.remoteURL.includes(':') ? target.remoteURL : resolve(policy.root,target.remoteURL);
            await workspaceGit(scratch, ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--',
                transport, policy.mainRef], undefined, 25_000);
            await workspaceGit(scratch, ['cat-file', '-e', target.commit + '^{commit}']);
            proofRoot = scratch;
        }
        const proof = await compare();
        const current = await readReclaimTarget(policy);
        if (target.commit !== current.commit || target.remoteURL !== current.remoteURL)
            throw new ApiError('WORKSPACE_REMOTE_UNCONFIRMED', 409);
        if (!proof) throw new ApiError('WORKSPACE_NOT_IN_MAIN', 409);
        return { ...target, head: candidate.head, proof };
    } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true });
    }
}
