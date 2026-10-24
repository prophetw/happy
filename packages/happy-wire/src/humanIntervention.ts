import { z } from 'zod';

/** Details stay in encrypted agent state; push metadata only names the event. */
export const HumanInterventionInputSchema = z.object({
    kind: z.enum(['sudo', 'uac', 'manual']),
    instructions: z.string().trim().min(1).max(1500),
});

export const HumanInterventionSchema = HumanInterventionInputSchema.extend({
    id: z.string().min(1),
    createdAt: z.number().finite(),
    // Preserve the selected action if delivery fails or the CLI reconnects.
    response: z.enum(['resolved', 'cancelled']).optional(),
});

export const HumanInterventionReplySchema = z.object({
    id: z.string().min(1),
    status: z.enum(['resolved', 'cancelled']),
});

export type HumanIntervention = z.infer<typeof HumanInterventionSchema>;
export type HumanInterventionInput = z.infer<typeof HumanInterventionInputSchema>;
export type HumanInterventionReply = z.infer<typeof HumanInterventionReplySchema>;
