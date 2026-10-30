import { randomUUID } from 'node:crypto';
import { HumanInterventionInputSchema, type HumanInterventionInput } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { AsyncLock } from '@/utils/lock';

type Client = Pick<ApiSessionClient, 'sessionId' | 'getAgentState' | 'getMetadata' | 'updateAgentState' | 'rpcHandlerManager'>;

/** One pending request per session. State and replies survive MCP reconnects. */
export class HumanInterventionHandler {
    private readonly lock = new AsyncLock();

    constructor(private readonly client: Client, private readonly push?: Pick<PushNotificationClient, 'sendSessionNotification'>) {
        client.rpcHandlerManager.registerHandler('human-intervention', (reply: unknown) => this.reply(reply));
    }

    request(input: HumanInterventionInput) {
        return this.lock.inLock(async () => {
            const parsed = HumanInterventionInputSchema.parse(input);
            let request = this.client.getAgentState()?.humanIntervention;
            const created = !request;
            if (request && (request.kind !== parsed.kind || request.instructions !== parsed.instructions)) {
                throw new Error('A human intervention request is already pending. Wait for the user to handle it.');
            }
            if (!request) {
                request = { ...parsed, id: randomUUID(), createdAt: Date.now() };
                const pending = request;
                await this.client.updateAgentState(state => ({ ...state, humanIntervention: pending }));
                if (this.client.getAgentState()?.humanIntervention?.id !== request.id) {
                    throw new Error('Could not save the human intervention request');
                }
            }
            if (created) this.push?.sendSessionNotification({
                kind: 'intervention', metadata: this.client.getMetadata(),
                data: { sessionId: this.client.sessionId, requestId: request.id, type: 'human_intervention' },
            });
            return {
                requestId: request.id,
                message: 'The user has been asked to act on the computer running this session. Stop dependent work and end this turn. Wait for their own chat reply; opening or dismissing the reminder sends nothing. Do not poll. Follow their reply and verify the actual result before continuing dependent work.',
            };
        });
    }

    async reply(_input: unknown): Promise<never> {
        // Older clients must not inject a fixed message or abort work through
        // their old Continue/Cancel buttons. Only an authored chat reply counts.
        throw new Error('Open the conversation and send your own reply to this reminder. Update the Happy app to use the new reply flow.');
    }

    dispose() {
        this.client.rpcHandlerManager.unregisterHandler('human-intervention');
    }
}
