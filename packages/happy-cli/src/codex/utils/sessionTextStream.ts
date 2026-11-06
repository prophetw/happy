import { createEnvelope, stripLeadingTaskNotificationWrappers, type SessionEnvelope } from '@slopus/happy-wire';
import { stripHappySystemBlocks } from '@/utils/happySystemBlock';

/** Shared native item rendering for ordinary and hosted Happy Codex sessions. */
export class CodexSessionTextStream {
    private items = new Map<string, { raw: string; visible: string; hold: boolean }>();

    map(message: Record<string, unknown>): SessionEnvelope[] | null {
        if (!['agent_message_delta', 'agent_message'].includes(String(message.type))) return null;
        const { thread_id: thread, turn_id: turn, item_id: item } = message;
        if (typeof thread !== 'string' || typeof turn !== 'string' || typeof item !== 'string') return null;
        const prefix = `${thread}:${turn}:${item}:`, partial = message.type === 'agent_message_delta';
        const value = partial ? message.delta : message.message;
        if (typeof value !== 'string') return [];
        const prior = this.items.get(prefix) ?? { raw: '', visible: '', hold: false };
        const raw = partial ? prior.raw + value : value;
        // Control wrappers may be split across deltas. Once markup starts, wait
        // for the complete item so injected Happy/task blocks never leak briefly.
        const hold = prior.hold || raw.includes('<');
        const visible = stripLeadingTaskNotificationWrappers(stripHappySystemBlocks(raw));
        const envelopes: SessionEnvelope[] = [];
        if (partial && !hold && visible.startsWith(prior.visible) && visible.length > prior.visible.length) {
            envelopes.push(createEnvelope('agent', { t: 'text', text: visible.slice(prior.visible.length), textOffset: prior.visible.length },
                { id: prefix + prior.visible.length, turn, codexItemId: `${thread}:${item}` }));
        }
        if (!partial && visible.trim()) envelopes.push(createEnvelope('agent', { t: 'text', text: visible, textOffset: 0, textSnapshot: true },
            { id: prefix + 'snapshot', turn, codexItemId: `${thread}:${item}` }));
        if (partial) this.items.set(prefix, { raw, visible: hold ? prior.visible : visible, hold });
        else this.items.delete(prefix);
        return envelopes;
    }

    clear(): void { this.items.clear(); }
}
