import { describe, expect, it } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { CodexAppServerClient } from '../codexAppServerClient';
import { CodexSessionTextStream } from './sessionTextStream';
import { mapCodexMcpMessageToSessionEnvelopes, type CodexTurnState } from './sessionProtocolMapper';

describe('shared Codex session text mapping', () => {
    it('routes raw native chunks through the ordinary event handler and mapper', () => {
        const client = new CodexAppServerClient();
        (client as any)._threadId = 'thread';
        const state: CodexTurnState = { currentTurnId: null, textStream: new CodexSessionTextStream() }, envelopes: any[] = [];
        client.setEventHandler(event => {
            const mapped = mapCodexMcpMessageToSessionEnvelopes(event, state);
            Object.assign(state, mapped); envelopes.push(...mapped.envelopes);
        });
        const notify = (method: string, fields: Record<string, unknown>) => (client as any).handleNotification(method, { threadId: 'thread', turnId: 'turn', ...fields });
        notify('turn/started', { turn: { id: 'turn' } });
        notify('item/agentMessage/delta', { itemId: 'reply', delta: '我是' });
        notify('item/agentMessage/delta', { itemId: 'reply', delta: '助手' });
        notify('item/completed', { item: { type: 'agentMessage', id: 'reply', text: '我是助手' } });
        notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
        expect(envelopes.filter(e => e.ev.t === 'text').map(e => e.ev)).toEqual([
            { t: 'text', text: '我是', textOffset: 0 },
            { t: 'text', text: '助手', textOffset: 2 },
            { t: 'text', text: '我是助手', textOffset: 0, textSnapshot: true },
        ]);
        expect(new Set(envelopes.map(e => e.turn))).toEqual(new Set(['turn']));
        expect(envelopes.filter(e => e.ev.t === 'text').every(e => e.codexItemId === 'thread:reply')).toBe(true);
        expect(envelopes.at(-1)).toMatchObject({ id: 'thread:turn:end', ev: { t: 'turn-end', status: 'completed' } });
    });

    it('keeps parent completion and each subagent stop as different messages', () => {
        const children = [createId(), createId()];
        const mapped = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete', thread_id: 'thread', turn_id: 'turn' }, {
            currentTurnId: 'turn', textStream: new CodexSessionTextStream(),
            activeSubagents: new Set(children), startedSubagents: new Set(children),
        });
        expect(mapped.envelopes).toHaveLength(3);
        expect(new Set(mapped.envelopes.map(e => e.id)).size).toBe(3);
        expect(mapped.envelopes.at(-1)?.id).toBe('thread:turn:end');
    });

    it('restores an implicit native turn before closing a recovered text item', () => {
        const state: CodexTurnState = { currentTurnId: null, textStream: new CodexSessionTextStream() };
        const mapped = mapCodexMcpMessageToSessionEnvelopes({ type: 'agent_message', thread_id: 'thread', turn_id: 'turn', item_id: 'reply', message: 'restored' }, state);
        expect(mapped.currentTurnId).toBe('turn');
        expect(mapped.envelopes[0]).toMatchObject({ id: 'thread:turn:start', ev: { t: 'turn-start' } });
        const end = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete', thread_id: 'thread', turn_id: 'turn' }, { ...state, currentTurnId: mapped.currentTurnId });
        expect(end.envelopes.at(-1)).toMatchObject({ id: 'thread:turn:end', turn: 'turn' });
    });

    it('does not stream partial control wrappers and uses the ordinary visibility filter', () => {
        const stream = new CodexSessionTextStream(), item = { thread_id: 'thread', turn_id: 'turn', item_id: 'reply' };
        expect(stream.map({ ...item, type: 'agent_message_delta', delta: '<happy-' })).toEqual([]);
        expect(stream.map({ ...item, type: 'agent_message_delta', delta: 'system>private</happy-system>可见' })).toEqual([]);
        expect(stream.map({ ...item, type: 'agent_message', message: '<happy-system>private</happy-system>可见' }))
            .toMatchObject([{ ev: { text: '可见', textSnapshot: true } }]);
        expect(stream.map({ ...item, type: 'agent_message', message: '<task-notification>internal</task-notification>' })).toEqual([]);
    });

    it('gives restored complete items the same identity as live complete items', () => {
        const event = { type: 'agent_message', thread_id: 'thread', turn_id: 'turn', item_id: 'reply', message: '完整回复' };
        const live = new CodexSessionTextStream();
        live.map({ ...event, type: 'agent_message_delta', delta: '完整' });
        expect(live.map(event)?.[0].id).toBe(new CodexSessionTextStream().map(event)?.[0].id);
    });
});
