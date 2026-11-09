import { z } from 'zod';
export const executionSchema = z.object({ mode: z.enum(['legacy', 'worktree', 'integration', 'read-only']).default('legacy'),
    resources: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)).max(32).default([]) }).strict();
export type Execution = z.infer<typeof executionSchema>;
