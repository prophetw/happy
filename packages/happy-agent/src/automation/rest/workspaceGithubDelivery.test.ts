import { expect, it } from 'vitest';
import { githubDelivery, githubRemoteMatches, type DeliveryPR, type GithubDeliveryPolicy } from './workspaceGithubDelivery';

const head='f'.repeat(40), target='main', branch='dot-task/isolated';
const policy:GithubDeliveryPolicy={repository:'example/repo',mergeMethod:'squash',requiredChecks:['tests'],minimumApprovals:1};
function fixture() {
    const calls:string[][]=[];
    const pr:DeliveryPR={number:7,state:'OPEN',headRefOid:head,headRefName:branch,baseRefName:target,
        isCrossRepository:false,isDraft:false,mergeCommit:null,mergeStateStatus:'CLEAN',reviewDecision:'REVIEW_REQUIRED',
        statusCheckRollup:[{name:'tests',status:'IN_PROGRESS'}]};
    const protection={enforce_admins:{enabled:true},required_status_checks:{strict:true,contexts:['tests']},
        required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true}};
    const provider=githubDelivery(policy,branch,target,head,async args=>{
        calls.push(args);
        if(args[0]==='api')return JSON.stringify(protection);
        if(args[1]==='list')return JSON.stringify([pr]);
        if(args[1]==='merge') {
            pr.state='MERGED';pr.mergeCommit={oid:'e'.repeat(40)};
        }
        return '';
    });
    return {provider,pr,protection,calls};
}

it('requires the exact repository and remote PR head, target and approval policy',async()=>{
    const f=fixture();
    expect(githubRemoteMatches('git@github.com:example/repo.git',policy.repository)).toBe(true);
    expect(githubRemoteMatches('https://github.com.evil.example/example/repo',policy.repository)).toBe(false);
    expect(await f.provider.read()).toEqual(f.pr);
    expect(await f.provider.blocker(f.pr)).toBe('WORKSPACE_DELIVERY_PR_APPROVAL');
    f.pr.headRefOid='e'.repeat(40);
    await expect(f.provider.read()).rejects.toThrow('WORKSPACE_DELIVERY_PR_EVIDENCE_UNCONFIRMED');
    f.pr.headRefOid=head;
    f.protection.required_status_checks.strict=false;
    await expect(f.provider.blocker(f.pr)).rejects.toThrow('WORKSPACE_DELIVERY_PR_PROTECTION_UNCONFIRMED');
});

it('exposes CI wait and failure; uses matching head for the configured merge method',async()=>{
    const f=fixture();
    f.pr.reviewDecision='APPROVED';
    expect(await f.provider.blocker(f.pr)).toBe('WORKSPACE_DELIVERY_PR_CI_WAIT');
    f.pr.statusCheckRollup=[{name:'tests',status:'COMPLETED',conclusion:'FAILURE'}];
    expect(await f.provider.blocker(f.pr)).toBe('WORKSPACE_DELIVERY_PR_CI_FAILED');
    f.pr.statusCheckRollup=[{name:'tests',status:'COMPLETED',conclusion:'SUCCESS'}];
    expect(await f.provider.blocker(f.pr)).toBeUndefined();
    await f.provider.merge(f.pr);
    expect(f.calls.at(-1)).toEqual(['pr','merge','7','--repo','github.com/example/repo','--match-head-commit',head,'--squash']);
    expect(await f.provider.read()).toMatchObject({number:7,state:'MERGED',mergeCommit:{oid:'e'.repeat(40)}});
});
