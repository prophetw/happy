import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@/sync/typesMessage';
import { dotMemoryHint, dotMemoryToolName, isDotMemoryToolCall } from './dotMemoryTool';

const digest = (character = 'a') => `sha256:${character.repeat(64)}`;

function call(toolName: string, result?: unknown, options: {
    state?: ToolCall['state'];
    args?: unknown;
    server?: string;
} = {}): ToolCall {
    return {
        name: 'McpTool',
        state: options.state ?? 'completed',
        input: { server: options.server ?? 'dot_memory', tool: toolName, arguments: options.args ?? {} },
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
        ...(result === undefined ? {} : { result }),
    };
}

describe('dot memory tool recognition', () => {
    it('accepts only the four hosted memory tools behind McpTool', () => {
        expect(dotMemoryToolName(call('dot_memory_recall'))).toBe('dot_memory_recall');
        expect(dotMemoryToolName(call('dot_memory_write'))).toBe('dot_memory_write');
        expect(dotMemoryToolName(call('dot_memory_propose'))).toBe('dot_memory_propose');
        expect(dotMemoryToolName(call('dot_memory_confirm'))).toBe('dot_memory_confirm');
        expect(dotMemoryToolName(call('dot_memory_read'))).toBeNull();
        expect(dotMemoryToolName(call('dot_memory_status'))).toBeNull();
        expect(dotMemoryToolName(call('dot_memory_recall', undefined, { server: 'happy' }))).toBeNull();
        expect(dotMemoryToolName({ name: 'Bash', input: { server: 'dot_memory', tool: 'dot_memory_recall' } })).toBeNull();
        expect(isDotMemoryToolCall(call('dot_memory_confirm'))).toBe(true);
        expect(isDotMemoryToolCall(call('dot_memory_read'))).toBe(false);
        expect(dotMemoryHint(call('dot_memory_read', { ok: true }))).toBeNull();
    });
});

describe('dot memory recall hints', () => {
    const reply = {
        ok: true,
        scope: 'all',
        memories: [
            { key: '偏好', keyDigest: digest('b'), revision: 2, scope: 'dot', kind: 'preference', value: { language: '中文' }, source: 'user' },
            { key: '时区', keyDigest: digest('c'), revision: 1, scope: 'user', kind: 'fact', value: 'UTC+8', source: 'agent' },
        ],
    };

    it('reads the real memories length and keeps each item scope distinct for scope=all', () => {
        const hint = dotMemoryHint(call('dot_memory_recall', JSON.stringify(reply), { args: { scope: 'all' } }));
        expect(hint).toMatchObject({ kind: 'recall', status: 'ready', count: 2 });
        if (hint?.kind !== 'recall') throw new Error('expected recall hint');
        expect(hint.memories).toHaveLength(2);
        expect(hint.memories[0]).toMatchObject({
            key: '偏好', keyDigest: digest('b'), scope: 'dot', source: 'user',
            target: { keyDigest: digest('b'), scope: 'dot' },
        });
        expect(hint.memories[0].valueSummary).toContain('中文');
        expect(hint.memories[1]).toMatchObject({
            key: '时区', scope: 'user', source: 'agent',
            target: { keyDigest: digest('c'), scope: 'user' },
        });
    });

    it('reads structured content and text blocks from a whole CallToolResult', () => {
        const structured = dotMemoryHint(call('dot_memory_recall', { content: [], structuredContent: reply }));
        expect(structured).toMatchObject({ kind: 'recall', status: 'ready', count: 2 });
        const text = dotMemoryHint(call('dot_memory_recall', {
            content: [{ type: 'text', text: JSON.stringify(reply) }], isError: false,
        }));
        expect(text).toMatchObject({ kind: 'recall', status: 'ready', count: 2 });
        const snake = dotMemoryHint(call('dot_memory_recall', { structured_content: reply }));
        expect(snake).toMatchObject({ kind: 'recall', status: 'ready', count: 2 });
    });

    it('unwraps Ok and treats Err as a failure', () => {
        const ok = dotMemoryHint(call('dot_memory_recall', { Ok: { structuredContent: reply } }));
        expect(ok).toMatchObject({ kind: 'recall', status: 'ready', count: 2 });
        expect(dotMemoryHint(call('dot_memory_recall', { Err: { code: 'hindsight_memory_unavailable' } })))
            .toEqual({ kind: 'recall', status: 'failed', count: 0, memories: [] });
    });

    it('shows an accurate empty result and never invents memories', () => {
        expect(dotMemoryHint(call('dot_memory_recall', JSON.stringify({ ok: true, memories: [] }))))
            .toEqual({ kind: 'recall', status: 'ready', count: 0, memories: [] });
    });

    it('reports host refusals as failed, not as an empty or successful search', () => {
        expect(dotMemoryHint(call('dot_memory_recall', { ok: false, error: { code: 'assistant_memory_unavailable' } })))
            .toEqual({ kind: 'recall', status: 'failed', count: 0, memories: [] });
        expect(dotMemoryHint(call('dot_memory_recall', undefined, { state: 'error' })))
            .toEqual({ kind: 'recall', status: 'failed', count: 0, memories: [] });
    });

    it.each([
        ['plain text', 'memory backend unavailable'],
        ['non-json text block', { content: [{ type: 'text', text: 'memory backend unavailable' }] }],
        ['missing payload', undefined],
        ['wrong shape', JSON.stringify({ ok: true, result: [] })],
    ])('never reports %s as a successful recall', (_label, result) => {
        const hint = dotMemoryHint(call('dot_memory_recall', result));
        expect(hint).toEqual({ kind: 'recall', status: 'unreadable', count: 0, memories: [] });
    });

    it('reports an error-flagged result as failed rather than unreadable', () => {
        expect(dotMemoryHint(call('dot_memory_recall', { structuredContent: { ok: false }, isError: true })))
            .toEqual({ kind: 'recall', status: 'failed', count: 0, memories: [] });
    });

    it('reports the raw list length while skipping entries it cannot label', () => {
        const hint = dotMemoryHint(call('dot_memory_recall', {
            ok: true, memories: [{ key: '偏好', keyDigest: digest(), scope: 'dot', value: '中文' }, null, { value: '无名称' }],
        }));
        expect(hint).toMatchObject({ kind: 'recall', status: 'ready', count: 3 });
        if (hint?.kind !== 'recall') throw new Error('expected recall hint');
        expect(hint.memories.map(item => item.key)).toEqual(['偏好']);
    });

    it('does not make a memory clickable without a valid digest and scope', () => {
        const hint = dotMemoryHint(call('dot_memory_recall', {
            ok: true, scope: 'dot',
            memories: [{ key: '有摘要无scope', keyDigest: digest('d'), scope: 'all', value: '正文' },
                { key: '无digest', scope: 'dot', value: '正文' }],
        }));
        if (hint?.kind !== 'recall') throw new Error('expected recall hint');
        expect(hint.memories[0].target).toBeNull();
        expect(hint.memories[1].target).toBeNull();
    });

    it('names the running state without fabricating a count', () => {
        expect(dotMemoryHint(call('dot_memory_recall', undefined, { state: 'running' })))
            .toEqual({ kind: 'recall', status: 'running', count: 0, memories: [] });
    });
});

describe('dot memory write, confirm and propose hints', () => {
    const receipt = { keyDigest: digest('e'), action: 'remember', revision: 1, currentRevision: 1, currentStatus: 'active' };

    it('shows a saved write only with ok=true, and opens the receipt digest in its scope', () => {
        const saved = dotMemoryHint(call('dot_memory_write', {
            ok: true, scope: 'user', status: 'saved', receipt, indexing: 'pending',
        }, { args: { scope: 'dot' } }));
        expect(saved).toEqual({ kind: 'write', tool: 'dot_memory_write', status: 'saved',
            target: { keyDigest: digest('e'), scope: 'user' } });
        const forgotten = dotMemoryHint(call('dot_memory_write', {
            ok: true, scope: 'dot', status: 'forgotten_locally', receipt: { ...receipt, action: 'forget' },
        }));
        expect(forgotten).toEqual({ kind: 'write', tool: 'dot_memory_write', status: 'forgotten',
            target: { keyDigest: digest('e'), scope: 'dot' } });
    });

    it('falls back to the request scope and never opens a receipt without a usable digest', () => {
        const fromArgs = dotMemoryHint(call('dot_memory_write', { ok: true, status: 'saved', receipt }, { args: { scope: 'user' } }));
        expect(fromArgs).toMatchObject({ status: 'saved', target: { keyDigest: digest('e'), scope: 'user' } });
        const noDigest = dotMemoryHint(call('dot_memory_write', { ok: true, status: 'saved', receipt: { ...receipt, keyDigest: 'not-a-digest' }, scope: 'dot' }));
        expect(noDigest).toMatchObject({ status: 'saved', target: null });
    });

    it('does not claim success without ok=true or without a terminal status', () => {
        expect(dotMemoryHint(call('dot_memory_write', { ok: false, status: 'saved', receipt })))
            .toMatchObject({ status: 'failed' });
        expect(dotMemoryHint(call('dot_memory_write', { status: 'saved', receipt })))
            .toMatchObject({ status: 'unreadable' });
        expect(dotMemoryHint(call('dot_memory_write', { ok: true, status: 'accepted', receipt })))
            .toMatchObject({ status: 'pending', target: null });
        expect(dotMemoryHint(call('dot_memory_write', undefined, { state: 'running' })))
            .toMatchObject({ status: 'running', target: null });
        expect(dotMemoryHint(call('dot_memory_write', 'plain text')))
            .toMatchObject({ status: 'unreadable', target: null });
    });

    it('applies the same terminal receipts to confirmations', () => {
        expect(dotMemoryHint(call('dot_memory_confirm', { ok: true, status: 'saved', receipt, scope: 'user' }, { args: { proposalId: 'proposal' } })))
            .toEqual({ kind: 'write', tool: 'dot_memory_confirm', status: 'saved',
                target: { keyDigest: digest('e'), scope: 'user' } });
        expect(dotMemoryHint(call('dot_memory_confirm', { ok: true, status: 'saved' })))
            .toEqual({ kind: 'write', tool: 'dot_memory_confirm', status: 'saved', target: null });
    });

    it('shows a proposal as awaiting confirmation, never as saved', () => {
        expect(dotMemoryHint(call('dot_memory_propose', { ok: true, proposalId: 'proposal', status: 'proposed' })))
            .toEqual({ kind: 'propose', status: 'proposed' });
        expect(dotMemoryHint(call('dot_memory_propose', { ok: true, proposalId: 'proposal', status: 'accepted' })))
            .toEqual({ kind: 'propose', status: 'pending' });
        expect(dotMemoryHint(call('dot_memory_propose', { ok: false, error: { code: 'assistant_memory_revision_conflict' } })))
            .toEqual({ kind: 'propose', status: 'failed' });
        expect(dotMemoryHint(call('dot_memory_propose', 'plain text')))
            .toEqual({ kind: 'propose', status: 'unreadable' });
        expect(dotMemoryHint(call('dot_memory_propose', undefined, { state: 'running' })))
            .toEqual({ kind: 'propose', status: 'running' });
    });
});