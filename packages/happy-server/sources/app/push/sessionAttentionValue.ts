import { z } from 'zod';
import { log } from '@/utils/log';

export const SESSION_ATTENTION_PREFIX = 'session-attention-v1:';
export const attentionKindSchema = z.enum(['done', 'permission', 'question', 'failed', 'intervention']);
export const attentionActionKindSchema = z.enum(['permission', 'question']);
export const attentionVisibilitySchema = z.enum(['normal', 'persistent', 'hidden']);

const valueSchema = z.object({
    kind: attentionKindSchema,
    eventId: z.string(),
    read: z.boolean(),
    at: z.number(),
    seq: z.number().optional(),
    pushDelivered: z.boolean().optional(),
    errorCode: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/).optional(),
    occurredAt: z.number().optional(),
    visibility: attentionVisibilitySchema.optional(),
    action: z.object({ kind: attentionActionKindSchema.nullable(), at: z.number(), version: z.number().int() }).optional(),
    turnStartedAt: z.number().optional(),
    archivedAt: z.number().optional(),
});

export type AttentionKind = z.infer<typeof attentionKindSchema>;
export type AttentionValue = z.infer<typeof valueSchema>;

export function readAttentionValue(value: Uint8Array | null | undefined): AttentionValue | null {
    if (!value) return null;
    try {
        return valueSchema.parse(JSON.parse(Buffer.from(value).toString('utf8')));
    } catch {
        log({ module: 'push', level: 'warn' }, 'Ignoring invalid session attention metadata');
        return null;
    }
}

export function encodeAttentionValue(value: AttentionValue): string {
    return Buffer.from(JSON.stringify(value)).toString('base64');
}
