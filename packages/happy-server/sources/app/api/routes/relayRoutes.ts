import { z } from 'zod';
import type { Fastify } from '../types';
import { db } from '@/storage/db';
import { allocateUserSeq } from '@/storage/seq';
import { eventRouter, buildNewSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import { activityCache } from '@/app/presence/sessionCache';

export function relayRoutes(app: Fastify) {
    app.get('/v1/relay', { preHandler: app.authenticate }, async () => ({ liveSwitch: 1 }));

    // Only the current encrypted snapshot is registered. No transcript or
    // attachment is copied, and an existing session's messages stay untouched.
    app.put('/v1/relay/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }),
            body: z.object({
                metadata: z.string().min(1),
                agentState: z.string().nullable(),
                dataEncryptionKey: z.string().base64().nullish(),
            }),
        },
    }, async (request, reply) => {
        const id = request.params.sessionId;
        const snapshot = {
            metadata: request.body.metadata,
            agentState: request.body.agentState,
            dataEncryptionKey: request.body.dataEncryptionKey
                ? new Uint8Array(Buffer.from(request.body.dataEncryptionKey, 'base64')) : undefined,
        };
        const session = await db.$transaction(async tx => {
            const existing = await tx.session.findUnique({ where: { id } });
            if (existing && existing.accountId !== request.userId) return null;
            return existing
                ? tx.session.update({ where: { id }, data: {
                    ...snapshot, metadataVersion: { increment: 1 }, agentStateVersion: { increment: 1 },
                } })
                : tx.session.create({ data: { id, accountId: request.userId, tag: `relay:${id}`, ...snapshot } });
        });
        if (!session) return reply.code(409).send({ error: 'Session belongs to a different account' });
        activityCache.resumeSessionUpdates(id);
        eventRouter.emitUpdate({
            userId: request.userId,
            payload: buildNewSessionUpdate(session, await allocateUserSeq(request.userId), randomKeyNaked(12)),
            recipientFilter: { type: 'user-scoped-only' },
        });
        return {
            id: session.id, seq: session.seq,
            metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
        };
    });
}
