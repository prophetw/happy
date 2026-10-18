import { z } from 'zod';

export const RelaySwitchRequestSchema = z.object({
    id: z.string().min(1).max(128),
    phase: z.enum(['prepare', 'commit', 'finish', 'rollback']),
    serverUrl: z.string().min(1).max(2048),
    token: z.string().min(1).max(16384),
});

export type RelaySwitchRequest = z.infer<typeof RelaySwitchRequestSchema>;
export type RelaySwitchResult = { success: true } | { success?: false; error: string };
