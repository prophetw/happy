import { z } from 'zod';
import { ApiError } from './schema';

// No machine maximum is inferred from the per-project default.
export const concurrencyLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const concurrencyPolicySchema = z.object({
    projectConcurrency: concurrencyLimit.default(2),
    machineConcurrency: concurrencyLimit.nullable().default(null),
    // Keys are trusted canonical Git common directories (or real non-Git roots).
    projectOverrides: z.record(z.string().startsWith('/'), concurrencyLimit).default({}),
}).strict();
export type ConcurrencyPolicy = z.infer<typeof concurrencyPolicySchema>;
export function normalizeConcurrency(input: Partial<ConcurrencyPolicy> | number): ConcurrencyPolicy {
    const result = concurrencyPolicySchema.safeParse(typeof input === 'number'
        ? { projectConcurrency: input, machineConcurrency: input } : input);
    if (!result.success) throw new ApiError('INVALID_CONCURRENCY');
    return result.data;
}
