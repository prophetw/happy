import { z } from 'zod';
export const objectID = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const checkoutDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const testEvidenceSchema = z.object({ command: z.string().min(1).max(300), exitCode: z.number().int() }).strict();
const candidate = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('commit'), commit: objectID, baseCommit: objectID.optional() }).strict(),
    z.object({ kind: z.literal('checkout'), requestID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest: checkoutDigest }).strict(),
    z.object({ kind: z.literal('test'), commit: objectID, command: z.string().trim().min(1).max(300).regex(/^[^\x00-\x1f\x7f]+$/) }).strict(),
]);
export const executionSchema = z.object({ mode: z.enum(['legacy', 'worktree', 'integration', 'read-only', 'text', 'inspect']).default('legacy'),
    resources: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)).max(32).default([]),
    handoff: z.literal(true).optional(), candidate: candidate.optional(),
    retireAfterIntegration: z.literal(true).optional(),
    source: z.enum(['baseline', 'checkout']).optional(),
}).strict().refine(value => (!value.candidate || value.mode === 'read-only') && (!value.handoff || ['legacy', 'integration', 'worktree'].includes(value.mode))
    && (!value.retireAfterIntegration || value.mode === 'worktree')
    && (value.mode === 'inspect') === (value.source !== undefined)
    && (!restrictedExecution(value.mode) || value.resources.length === 0), 'invalid_execution_candidate');
export type Execution = z.infer<typeof executionSchema>;
export type TestEvidence = z.infer<typeof testEvidenceSchema>;

export function restrictedExecution(mode: string | undefined): mode is 'text' | 'inspect' {
    return mode === 'text' || mode === 'inspect';
}
