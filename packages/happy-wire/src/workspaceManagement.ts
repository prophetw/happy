import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
export const workspacePlanSchema = z.object({ version: z.literal(1), id: digest, policy: digest, workspaceID: digest,
    revision: z.number().int().nonnegative(), workspaceState: z.enum(['active','retiring','retired']),
    outcome: z.enum(['unknown','pending_commit','pending_integration','no_change_unreviewed','resolved']),
    checkedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(), eligible: z.boolean(),
    reasons: z.array(z.string().max(128)).max(64), binding: digest, git: digest, tasks: digest,
    head: commit.optional(), branch: z.string().max(256).optional(), checkout: digest.optional(),
    mainCommit: commit.optional(), remoteCommit: commit.optional(),
}).strict().refine(p => p.expiresAt === p.checkedAt + 60000, 'Invalid plan lifetime');

export const workspaceOperationSchema = z.object({ id, fingerprint: digest,
    state: z.enum(['adopted','resolved','applying','removed','failed']), revision: z.number().int().nonnegative(),
    planID: digest.optional(), head: commit.optional(), branch: z.string().optional(), checkout: digest.optional(),
    retainedRef: z.string().optional(), reason: z.string().optional(), removal: z.enum(['git-confirmed','absence-after-intent']).optional(),
}).strict();
export const workspaceDispositionSchema = z.object({ kind: z.enum(['integrated','archived','discarded','no-change']), head: commit,
    policy: digest, mainCommit: commit, remoteCommit: commit.optional(), retainedRef: z.string(),
    proof: z.enum(['ancestor','patch-equivalent','retained-ref']), source: z.string(), recordedAt: z.number(), taskDigest: digest,
    sourceTaskID: digest, sourceRequestID: id,
}).strict();
export const workspaceItemSchema = z.object({ id: digest, projectID: id, directory: z.string(), branch: z.string().optional(),
    baseCommit: commit.optional(), revision: z.number().int().nonnegative(), state: z.string(), managed: z.boolean(),
    reasons: z.array(z.string()), taskCount: z.number().int().nonnegative(), tasks: z.array(z.object({ id: digest, sessionID: id, state: z.string(), resultCommit: commit.optional() })).max(20),
    disposition: workspaceDispositionSchema.optional(), lastVerification: z.number().optional(), lastOperation: workspaceOperationSchema.optional(),
    plan: workspacePlanSchema.optional(),
}).strict();
export const workspaceResultSchema = z.object({ workspaceID: digest, revision: z.number(), workspaceState: z.enum(['active','retiring','retired']),
    disposition: workspaceDispositionSchema.optional(), operation: workspaceOperationSchema.optional(), operations: z.array(workspaceOperationSchema).max(16).optional(),
    rebuild: z.object({ command: z.literal('git'), args: z.array(z.string()).max(20) }).optional(),
}).strict();
export const workspaceDetailSchema = z.object({ item: workspaceItemSchema, plan: workspacePlanSchema,
    inspectedHead: commit.optional(), adoptionVerified: z.boolean(), result: workspaceResultSchema,
}).strict();
export const workspaceCatalogSchema = z.object({ ownerID: id, machineID: id, machineName: z.string(), automaticGC: z.literal(false),
    projects: z.array(z.object({ id, name: z.string(), allowApply: z.boolean(), allowArchive: z.boolean(), allowDiscard: z.boolean() })).max(50),
}).strict();
export const workspaceListSchema = z.object({ total: z.number(), returned: z.number(), items: z.array(workspaceItemSchema).max(5), next: digest.nullable() }).strict();
const scope = { machineID: id, projectID: id };
export const workspaceReadSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('inventory'), ...scope, after: digest.optional(), limit: z.number().int().min(1).max(5).default(5) }).strict(),
    z.object({ action: z.literal('detail'), ...scope, workspaceID: digest }).strict(),
    z.object({ action: z.literal('result'), ...scope, workspaceID: digest, operationID: id.optional() }).strict(),
]);
export const workspaceWriteSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('plan'), ...scope, workspaceID: digest }).strict(),
    z.object({ action: z.literal('adopt'), ...scope, workspaceID: digest, operationID: id, revision: z.number().int().nonnegative(), head: commit }).strict(),
    z.object({ action: z.literal('resolve'), ...scope, workspaceID: digest, operationID: id, revision: z.number().int().nonnegative(), head: commit,
        kind: z.enum(['integrated','no-change','archived']) }).strict(),
    z.object({ action: z.literal('apply'), ...scope, workspaceID: digest, operationID: id, ticket: id, confirmedPlanID: digest }).strict(),
]);
export const workspaceTicketSchema = z.object({ ticket: id, plan: workspacePlanSchema }).strict();
export const workspaceMutationResultSchema = z.object({ operationID: id, status: z.enum(['pending','unknown','settled']),
    receipt: workspaceOperationSchema.optional(), error: z.string().optional() }).strict()
    .refine(v=>!v.receipt||v.receipt.id===v.operationID,'Receipt identity mismatch')
    .refine(v=>v.status!=='settled'||v.receipt?.state!=='applying'&&(!!v.receipt||!!v.error),'Unconfirmed settled operation');
export type WorkspaceRead = z.input<typeof workspaceReadSchema>;
export type WorkspaceWrite = z.infer<typeof workspaceWriteSchema>;
export type WorkspaceItem = z.infer<typeof workspaceItemSchema>;
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;
export type WorkspaceCatalog = z.infer<typeof workspaceCatalogSchema>;
export type WorkspaceList = z.infer<typeof workspaceListSchema>;
export type WorkspaceTicket = z.infer<typeof workspaceTicketSchema>;
export type WorkspaceMutationResult = z.infer<typeof workspaceMutationResultSchema>;
