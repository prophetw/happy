import { z } from 'zod';
export const objectID = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const checkoutDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const testEvidenceSchema = z.object({ command: z.string().min(1).max(300), exitCode: z.number().int() }).strict();
const candidate = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('commit'), commit: objectID, baseCommit: objectID.optional() }).strict(),
    z.object({ kind: z.literal('checkout'), requestID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest: checkoutDigest }).strict(),
    z.object({ kind: z.literal('test'), commit: objectID, command: z.string().trim().min(1).max(300).regex(/^[^\x00-\x1f\x7f]+$/) }).strict(),
]);
export const executionSchema = z.object({ mode: z.enum(['legacy', 'worktree', 'integration', 'read-only']).default('legacy'),
    resources: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)).max(32).default([]),
    handoff: z.literal(true).optional(), candidate: candidate.optional(),
}).strict().refine(value => (!value.candidate || value.mode === 'read-only') && (!value.handoff || value.mode !== 'read-only'), 'invalid_execution_candidate');
export type Execution = z.infer<typeof executionSchema>;
export type TestEvidence = z.infer<typeof testEvidenceSchema>;
