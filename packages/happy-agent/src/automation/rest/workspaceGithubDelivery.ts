import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ApiError } from './schema';

export const githubDeliveryPolicySchema=z.object({
    repository:z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/),
    mergeMethod:z.enum(['merge','squash','rebase']),
    requiredChecks:z.array(z.string().min(1).max(200)).min(1).max(30),
    minimumApprovals:z.number().int().min(0).max(6),
}).strict();
export type GithubDeliveryPolicy=z.infer<typeof githubDeliveryPolicySchema>;

const objectID=z.string().regex(/^[a-f0-9]{40,64}$/);
const pullRequestSchema=z.object({
    number:z.number().int().positive(), state:z.enum(['OPEN','CLOSED','MERGED']),
    headRefOid:objectID, headRefName:z.string(), baseRefName:z.string(), isCrossRepository:z.boolean(), isDraft:z.boolean(),
    mergeCommit:z.object({oid:objectID}).nullable(), mergeStateStatus:z.string(),
    reviewDecision:z.string().nullable(), statusCheckRollup:z.array(z.object({
        name:z.string().optional(), context:z.string().optional(), status:z.string().optional(),
        conclusion:z.string().nullable().optional(), state:z.string().optional(),
    })).nullable(),
});
export type DeliveryPR=z.infer<typeof pullRequestSchema>;
const protectionSchema=z.object({
    enforce_admins:z.object({enabled:z.literal(true)}),
    required_status_checks:z.object({strict:z.literal(true), contexts:z.array(z.string()).default([]),
        checks:z.array(z.object({context:z.string()})).default([])}),
    required_pull_request_reviews:z.object({
        required_approving_review_count:z.number().int().nonnegative(),dismiss_stale_reviews:z.boolean(),
        bypass_pull_request_allowances:z.object({users:z.array(z.unknown()),teams:z.array(z.unknown()),apps:z.array(z.unknown())}).optional(),
    }).nullable(),
});
const exec=promisify(execFile);
export type GithubDeliveryCommand=(args:string[])=>Promise<string>;
const ghCommand:GithubDeliveryCommand=async args=>{
    try {
        const env={...process.env,GH_PROMPT_DISABLED:'1',GH_NO_UPDATE_NOTIFIER:'1',GH_HOST:'github.com'};
        // The configured repo and branch are passed as arguments, never a shell command.
        return (await exec('gh',args,{env,encoding:'utf8',timeout:15_000,maxBuffer:512*1024})).stdout;
    } catch {throw new ApiError('WORKSPACE_DELIVERY_PR_UNAVAILABLE',409);}
};
const invalid=()=>new ApiError('WORKSPACE_DELIVERY_PR_EVIDENCE_UNCONFIRMED',409);

export function githubRemoteMatches(url:string,repository:string) {
    return [`https://github.com/${repository}`,`git@github.com:${repository}`,`ssh://git@github.com/${repository}`]
        .some(base=>url===base||url===base+'.git');
}

export function githubDelivery(policy:GithubDeliveryPolicy,branch:string,target:string,head:string,run:GithubDeliveryCommand=ghCommand) {
    const repo='github.com/'+policy.repository;
    const branchPath='repos/'+policy.repository+'/branches/'+encodeURIComponent(target)+'/protection';
    const read=async()=>{
        const json=await run(['pr','list','--repo',repo,'--head',branch,'--base',target,'--state','all','--limit','2',
            '--json',Object.keys(pullRequestSchema.shape).join(',')]);
        const result=z.array(pullRequestSchema).safeParse(JSON.parse(json));
        if(!result.success||result.data.length>1)throw invalid();
        const pr=result.data[0];
        if(pr&&(pr.headRefName!==branch||pr.baseRefName!==target||pr.isCrossRepository||pr.headRefOid!==head))throw invalid();
        return pr;
    };
    const create=async()=>{
        await run(['pr','create','--repo',repo,'--head',branch,'--base',target,
            '--title','Dot candidate '+head.slice(0,12),'--body','Candidate '+head+'.']);
    };
    const protections=async()=>{
        const parsed=protectionSchema.safeParse(JSON.parse(await run(['api','--hostname','github.com',branchPath])));
        if(!parsed.success)throw new ApiError('WORKSPACE_DELIVERY_PR_PROTECTION_UNCONFIRMED',409);
        const {required_status_checks:checks,required_pull_request_reviews:reviews}=parsed.data;
        const contexts=new Set([...checks.contexts,...checks.checks.map(check=>check.context)]);
        const bypass=reviews?.bypass_pull_request_allowances;
        if(!policy.requiredChecks.every(check=>contexts.has(check))
            || (reviews?.required_approving_review_count??0)<policy.minimumApprovals
            || reviews&&reviews.required_approving_review_count>0&&!reviews.dismiss_stale_reviews
            || bypass&&Object.values(bypass).some(list=>list.length))throw new ApiError('WORKSPACE_DELIVERY_PR_PROTECTION_UNCONFIRMED',409);
        return Math.max(reviews?.required_approving_review_count??0,policy.minimumApprovals);
    };
    const blocker=async(pr:DeliveryPR)=>{
        const reviews=await protections();
        if(pr.state!=='OPEN'||pr.isDraft)return 'WORKSPACE_DELIVERY_PR_CLOSED_OR_DRAFT';
        if(reviews>0&&pr.reviewDecision!=='APPROVED')return 'WORKSPACE_DELIVERY_PR_APPROVAL';
        for(const context of policy.requiredChecks) {
            const check=pr.statusCheckRollup?.filter(check=>check.name===context||check.context===context);
            if(check?.length!==1)return 'WORKSPACE_DELIVERY_PR_CI_WAIT';
            const state=check[0].conclusion??check[0].state;
            if(state&&['FAILURE','ERROR','TIMED_OUT','CANCELLED','ACTION_REQUIRED','STARTUP_FAILURE'].includes(state))return 'WORKSPACE_DELIVERY_PR_CI_FAILED';
            if(state!=='SUCCESS')return 'WORKSPACE_DELIVERY_PR_CI_WAIT';
        }
        if(pr.mergeStateStatus==='DIRTY')return 'WORKSPACE_DELIVERY_PR_CONFLICT';
        if(pr.mergeStateStatus!=='CLEAN')return 'WORKSPACE_DELIVERY_PR_NOT_READY';
        return undefined;
    };
    const merge=async(pr:DeliveryPR)=>{
        await run(['pr','merge',String(pr.number),'--repo',repo,'--match-head-commit',head,'--'+policy.mergeMethod]);
    };
    return {read,create,blocker,merge};
}
