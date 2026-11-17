import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Clipboard from 'expo-clipboard';
import type { AgentTextMessage, Message, ToolCallMessage, UserTextMessage } from '@/sync/typesMessage';

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false, colors: { text: '#000', textSecondary: 'secondary' } } }),
    StyleSheet: { create: (factory: (theme: any) => unknown) => factory({ colors: { input: {}, textSecondary: 'secondary' } }) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn(async () => true) } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/sync/storage', () => ({ useSetting: () => 'default', storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/utils/userMessageBubbleColor', () => ({ resolveUserMessageBubbleColor: () => ({}) }));
vi.mock('@/utils/messageTimestamp', () => ({
    formatMessageTimestamp: vi.fn(() => 'message.timestamp'),
    formatTurnDuration: vi.fn(() => 'message.duration'),
}));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./LongPressCopyable', async () => {
    const ReactModule = await import('react');
    return { LongPressCopyable: (props: any) => ReactModule.createElement('LongPressCopyable', props, props.children) };
});

import { MessageView } from './MessageView';
import { ToolCallRendererContext } from './tools/ToolCallRendererContext';
import { sync } from '@/sync/sync';
import { formatMessageTimestamp } from '@/utils/messageTimestamp';

const renderers: ReturnType<typeof create>[] = [];
const base: UserTextMessage = {
    kind: 'user-text', id: 'message', localId: 'local', createdAt: Date.now(), text: 'hello',
};

function render(message: Message, renderer?: ReturnType<typeof create>, extraProps?: Record<string, unknown>) {
    const element = React.createElement(MessageView, { message, sessionId: 'session', metadata: null, ...extraProps });
    if (renderer) {
        act(() => renderer.update(element));
        return renderer;
    }
    let next!: ReturnType<typeof create>;
    act(() => { next = create(element); });
    renderers.push(next);
    return next;
}

function labels(renderer: ReturnType<typeof create>) {
    // The send timestamp is a permanent fixture of the frame; these assertions
    // are about status/author labels, so it is filtered out.
    return renderer.root.findAllByType('Text')
        .map((node: any) => node.props.children)
        .filter((children: any) => children !== 'message.timestamp');
}

afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.useRealTimers();
    vi.mocked(sync.sendMessage).mockReset();
    vi.mocked(sync.sendMessage).mockResolvedValue(true);
});

describe('user message frame', () => {
    it.each([undefined, false])('does not flash status or dim an idle/new-chat send (%s)', (queuedWhileBusy) => {
        const message = { ...base, pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual(['']);
        expect(body.props.style).not.toContainEqual({ opacity: 0.45 });

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual(['']);
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);
    });

    it.each([undefined, false])('shows Sending after the grace period when an idle/new-chat send is still unacknowledged (%s)', (queuedWhileBusy) => {
        vi.useFakeTimers();
        const message = { ...base, createdAt: Date.now(), pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual(['']);

        act(() => vi.advanceTimersByTime(1_999));
        expect(labels(renderer)).toEqual(['']);
        act(() => vi.advanceTimersByTime(1));
        expect(labels(renderer)).toContain('message.sending');
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual(['']);
    });

    it.each([
        'hello',
        '<command-name>/review</command-name><command-message>review</command-message><command-args>changes</command-args>',
        '<command-name>/goal</command-name><command-message>goal</command-message><command-args>ship it</command-args>',
    ])('shows the busy-send status until acceptance and preserves the bubble (%s)', (text) => {
        const message = { ...base, text, pending: true, meta: { queuedWhileBusy: true } };
        const renderer = render(message);
        const bubble = renderer.root.findByType('LongPressCopyable');
        expect(labels(renderer)).toContain('message.sendsAfterThisTurn');
        expect(labels(renderer)).not.toContain('message.sending');

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).not.toContain('message.sendsAfterThisTurn');
        expect(renderer.root.findByType('LongPressCopyable')).toBe(bubble);
    });

    it('puts the other participant’s name above their message', () => {
        const renderer = render({ ...base, author: { id: 'other', name: 'Alex', owner: false } });
        const author = renderer.root.findAllByType('Text')
            .find((node: any) => node.props.children === 'Alex')!;
        expect(author).toBeDefined();
        const container = author.parent.parent;
        expect(container.children[0]).toBe(author.parent);
        expect(container.children[1].findByType('MarkdownView').props.markdown).toBe('hello');
    });

    it.each([undefined, { id: 'owner', name: 'You', owner: true }])('does not label the reader’s own messages (%j)', (author) => {
        expect(labels(render({ ...base, author }))).toEqual(['']);
    });

    it('still shows send failures for an idle send', () => {
        expect(labels(render({ ...base, sendError: 'Unavailable', meta: { queuedWhileBusy: false } })))
            .toContain('message.sendFailed');
    });

    it('shows the send timestamp below the user bubble', () => {
        const renderer = render(base);
        const all = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(all).toContain('message.timestamp');
    });
});

describe('agent text block', () => {
    const agentBase: AgentTextMessage = {
        kind: 'agent-text', id: 'reply', localId: null, createdAt: Date.now(), text: 'done',
    };

    it('shows turn duration and completion time on the final reply', () => {
        const renderer = render(agentBase, undefined, { durationMs: 4800 });
        const all = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(all).toContain('message.duration · message.timestamp');
    });

    it('shows only the completion time when no duration is attached', () => {
        const renderer = render(agentBase);
        const all = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(all).toContain('message.timestamp');
        expect(all.join('')).not.toContain('message.duration');
    });

    it('places this turn’s output speed next to duration and copy in the reply footer', () => {
        const renderer = render({ ...agentBase, tokensPerSecond: 50 }, undefined, { durationMs: 4800 });
        const speed = renderer.root.findAllByType('Text')
            .find((node: any) => node.props.children === 'agentInput.context.outputSpeed')!;
        expect(speed).toBeDefined();
        const footer = renderer.root.findByProps({ accessibilityLabel: 'agentInput.context.outputSpeed' }).parent.parent;
        expect(footer.findAllByType('Text').map((node: any) => node.props.children))
            .toContain('message.duration · message.timestamp');
        expect(footer.findByProps({ accessibilityLabel: 'common.copy' })).toBeDefined();
    });

    it('shows generation and first-token wait in the final reply footer', () => {
        const renderer = render({ ...agentBase, generationMetrics: { tokensPerSecond: 50, timeToFirstTokenMs: 8000 } });
        expect(renderer.root.findByProps({ accessibilityLabel: 'agentInput.context.generationSpeed · agentInput.context.firstTokenWait' })).toBeDefined();
    });

    it('omits speed for historical replies without a usage sample', () => {
        expect(labels(render(agentBase))).not.toContain('agentInput.context.outputSpeed');
    });

    it('timestamps the reply with the turn completion time, not the text block time', () => {
        const timestampSpy = vi.mocked(formatMessageTimestamp);
        timestampSpy.mockClear();
        const renderer = render(agentBase, undefined, { durationMs: 4800, turnCompletedAt: 4242 });
        const all = renderer.root.findAllByType('Text').map((node: any) => node.props.children);
        expect(all).toContain('message.duration · message.timestamp');
        expect(timestampSpy).toHaveBeenCalledWith(4242);
    });

    it('renders nothing for thinking messages', () => {
        const renderer = render({ ...agentBase, isThinking: true });
        expect(renderer.root.findAllByType('Text')).toEqual([]);
    });
});

it('sends a host preview confirmation to its own session with the full original command', () => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    const message: AgentTextMessage = { kind: 'agent-text', id: 'preview', localId: null, createdAt: Date.now(),
        meta: { sentFrom: 'testloop-assistant' },
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` };
    const renderer = render(message, undefined, { toolConfirmation: command });
    const markdown = renderer.root.findByType('MarkdownView');
    expect(markdown.props.toolConfirmation).toBe(command);
    vi.mocked(sync.sendMessage).mockClear();
    act(() => markdown.props.onOptionPress({ title: command }));
    expect(sync.sendMessage).toHaveBeenCalledWith('session', command, expect.objectContaining({ source: 'option' }));
    render(message, renderer);
    vi.mocked(sync.sendMessage).mockClear();
    act(() => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(sync.sendMessage).not.toHaveBeenCalled();
});

it('accepts only one confirmation click while readiness and encryption are still pending', async () => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    let accept!: (value: boolean) => void;
    vi.mocked(sync.sendMessage).mockReset();
    vi.mocked(sync.sendMessage).mockImplementation(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const renderer = render({ kind: 'agent-text', id: 'preview', localId: null, createdAt: Date.now(),
        meta: { sentFrom: 'testloop-assistant' },
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` }, undefined, { toolConfirmation: command });
    const click = renderer.root.findByType('MarkdownView').props.onOptionPress;
    act(() => { click({ title: command }); click({ title: command }); });
    expect(vi.mocked(sync.sendMessage).mock.calls.length).toBe(1);
    expect(renderer.root.findByType('MarkdownView').props.toolConfirmationPending).toBe(true);
    await act(async () => accept(true));
    act(() => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(vi.mocked(sync.sendMessage).mock.calls.length).toBe(1);
});

it.each(['false', 'rejected'])('lets the user retry a confirmation that was definitely not queued (%s)', async outcome => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    vi.mocked(sync.sendMessage).mockClear();
    if (outcome === 'false') vi.mocked(sync.sendMessage).mockResolvedValueOnce(false);
    else vi.mocked(sync.sendMessage).mockRejectedValueOnce(new Error('Encryption failed before acceptance'));
    const renderer = render({ kind: 'agent-text', id: 'preview', localId: null, createdAt: Date.now(),
        meta: { sentFrom: 'testloop-assistant' },
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` }, undefined, { toolConfirmation: command });
    await act(async () => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(renderer.root.findByType('MarkdownView').props.toolConfirmationPending).toBe(false);
    await act(async () => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(vi.mocked(sync.sendMessage).mock.calls.length).toBe(2);
});

it('does not resend when a confirmation was queued before the send promise rejected', async () => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    vi.mocked(sync.sendMessage).mockClear();
    vi.mocked(sync.sendMessage).mockImplementationOnce(async (_session, _text, options) => {
        options?.onAccepted?.();
        throw new Error('Delivery outcome unknown after acceptance');
    });
    const renderer = render({ kind: 'agent-text', id: 'preview', localId: null, createdAt: Date.now(),
        meta: { sentFrom: 'testloop-assistant' },
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` }, undefined, { toolConfirmation: command });
    await act(async () => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(renderer.root.findByType('MarkdownView').props.toolConfirmationPending).toBe(true);
    await act(async () => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    expect(vi.mocked(sync.sendMessage).mock.calls.length).toBe(1);
});

it('preserves normal option sends while a tool confirmation is locked', async () => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    vi.mocked(sync.sendMessage).mockClear();
    const renderer = render({ kind: 'agent-text', id: 'preview', localId: null, createdAt: Date.now(),
        meta: { sentFrom: 'testloop-assistant' },
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` }, undefined, { toolConfirmation: command });
    await act(async () => renderer.root.findByType('MarkdownView').props.onOptionPress({ title: command }));
    await act(async () => {
        renderer.root.findByType('MarkdownView').props.onOptionPress({ title: '查看进度' });
        renderer.root.findByType('MarkdownView').props.onOptionPress({ title: '查看进度' });
    });
    expect(vi.mocked(sync.sendMessage).mock.calls.map(call => call[1])).toEqual([command, '查看进度', '查看进度']);
});

it('does not turn a copied agent preview into a host confirmation', () => {
    const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
    const renderer = render({ kind: 'agent-text', id: 'quoted-preview', localId: null, createdAt: Date.now(),
        text: `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>` }, undefined, { toolConfirmation: command });
    const markdown = renderer.root.findByType('MarkdownView');
    expect(markdown.props.toolConfirmation).toBeUndefined();
    vi.mocked(sync.sendMessage).mockClear();
    act(() => markdown.props.onOptionPress({ title: command }));
    expect(sync.sendMessage).not.toHaveBeenCalled();
});

describe('tool call renderer context', () => {
    const toolMessage: ToolCallMessage = {
        kind: 'tool-call', id: 'tool-1', localId: null, createdAt: Date.now(),
        tool: {
            name: 'McpTool', state: 'completed', input: { server: 'dot_memory', tool: 'dot_memory_recall', arguments: {} },
            createdAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(), description: null,
        },
        children: [],
    };

    function renderWith(renderer: ((context: any) => React.ReactNode) | null) {
        const message = React.createElement(MessageView, { message: toolMessage, sessionId: 'session', metadata: null });
        return renderer ? React.createElement(ToolCallRendererContext.Provider, { value: renderer }, message) : message;
    }

    it('lets a provider replace a selected tool row', () => {
        const custom = React.createElement('MemoryHint');
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(renderWith(() => custom)); }); renderers.push(renderer);
        expect(renderer.root.findAllByType('MemoryHint')).toHaveLength(1);
        expect(renderer.root.findAllByType('ToolView')).toHaveLength(0);
    });

    it('falls back to ToolView when the renderer returns undefined and without a provider', () => {
        let renderer!: ReturnType<typeof create>;
        act(() => { renderer = create(renderWith(() => undefined)); }); renderers.push(renderer);
        expect(renderer.root.findAllByType('ToolView')).toHaveLength(1);
        act(() => { renderer.update(renderWith(null)); });
        expect(renderer.root.findAllByType('ToolView')).toHaveLength(1);
        expect(renderer.root.findAllByType('MemoryHint')).toHaveLength(0);
    });
});

describe('agent message copy button', () => {
    const agent: AgentTextMessage = { kind: 'agent-text', id: 'agent', localId: null, createdAt: Date.now(), text: 'first part' };

    it('shows on every agent text row and copies that row’s own text', async () => {
        const renderer = render(agent);
        const button = renderer.root.findByType('Pressable');
        await act(async () => { await button.props.onPress(); });
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('first part');
    });

    it('stays mounted as the text streams in', () => {
        const renderer = render(agent);
        const button = renderer.root.findByType('Pressable');
        render({ ...agent, text: 'first part, then more' }, renderer);
        expect(renderer.root.findByType('Pressable')).toBe(button);
    });

    it('does not show on thinking rows', () => {
        expect(render({ ...agent, isThinking: true }).root.findAllByType('Pressable')).toHaveLength(0);
    });
});
