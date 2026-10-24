import { randomUUID } from 'node:crypto';
import { HumanInterventionInputSchema, HumanInterventionReplySchema, type HumanInterventionInput } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PushNotificationClient } from '@/api/pushNotifications';
import { AsyncLock } from '@/utils/lock';

type Client = Pick<ApiSessionClient, 'sessionId' | 'getAgentState' | 'getMetadata' | 'updateAgentState' | 'sendUserAction' | 'rpcHandlerManager'>;

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
                message: 'The user has been asked to act on the computer running this session. Stop dependent work and end this turn. Wait for their follow-up; do not poll. After acknowledgement, verify the actual result before continuing.',
            };
        });
    }

    reply(input: unknown) {
        return this.lock.inLock(async () => {
            const reply = HumanInterventionReplySchema.parse(input);
            const state = this.client.getAgentState();
            if (state?.completedHumanIntervention?.id === reply.id) {
                if (state.completedHumanIntervention.status !== reply.status) throw new Error('This request was already handled differently');
                return { success: true };
            }
            const pending = state?.humanIntervention;
            if (pending?.id !== reply.id) throw new Error('This intervention request is no longer pending');
            if (pending.response && pending.response !== reply.status) throw new Error('This request was already handled differently');
            await this.client.updateAgentState(current => ({
                ...current, humanIntervention: current.humanIntervention?.id === reply.id
                    ? { ...current.humanIntervention, response: reply.status } : current.humanIntervention,
            }));
            if (this.client.getAgentState()?.humanIntervention?.response !== reply.status) throw new Error('Could not save the intervention response');

            if (reply.status === 'cancelled') {
                // Validate the request here before aborting: a stale phone UI
                // must never interrupt work belonging to a newer request.
                await this.client.rpcHandlerManager.invokeHandlerIfRegistered('abort', {
                    reason: 'The user cancelled the local action. Stop the affected task and wait for further instructions.',
                });
            }

            const text = reply.status === 'resolved'
                ? `I have handled the local ${pending.kind} step. Check the actual command result or system state before continuing the original task. This acknowledgement does not grant privileges. If the action is still blocked, report it again.`
                : `I cancelled the local ${pending.kind} step. Stop the affected task and do not retry the privileged action or continue dependent work. Wait for further instructions.`;
            // A deterministic local id makes an RPC retry safe after a lost acknowledgement.
            await this.client.sendUserAction(text, `human-intervention:${reply.id}:${reply.status}`);
            await this.client.updateAgentState(current => ({
                ...current,
                humanIntervention: current.humanIntervention?.id === reply.id ? null : current.humanIntervention,
                completedHumanIntervention: reply,
            }));
            if (this.client.getAgentState()?.humanIntervention?.id === reply.id) throw new Error('Could not finish the intervention request');
            return { success: true };
        });
    }

    dispose() {
        this.client.rpcHandlerManager.unregisterHandler('human-intervention');
    }
}
