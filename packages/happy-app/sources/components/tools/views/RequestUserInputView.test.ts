import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolViewProps } from './_all';

const mocks = vi.hoisted(() => ({ communication: null as any, answer: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), TextInput: host('TextInput'),
        TouchableOpacity: host('TouchableOpacity'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { select: (value: any) => value.web ?? value.default } };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return { StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles },
        useUnistyles: () => ({ theme: lightTheme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', () => ({ useSessionAgentFormCommunication: () => mocks.communication }));
vi.mock('@/sync/ops', () => ({ sessionAnswerQuestion: mocks.answer }));
vi.mock('../ToolSectionView', async () => {
    const React = await import('react');
    return { ToolSectionView: (props: any) => React.createElement('Section', props, props.children) };
});
import { RequestUserInputView } from './RequestUserInputView';

let renderer: any;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.clearAllMocks(); });

function renderQuestion() {
    mocks.communication = {
        id: 'async-question', kind: 'form', status: 'pending', isBlocking: false,
        questions: [{ id: 'choice', header: 'Color', question: 'Which color?', options: [{ label: 'Blue' }], allowCustom: true }],
    };
    // A turn can already have finished while this question is still pending.
    const tool = { name: 'request_user_input', state: 'completed', callId: 'async-question' } as ToolViewProps['tool'];
    act(() => { renderer = create(React.createElement(RequestUserInputView, { tool, sessionId: 'session', metadata: null, messages: [] })); });
}

describe('Codex question card', () => {
    it('allows a choice to be submitted after the generation turn completed', async () => {
        renderQuestion();
        const buttons = () => renderer.root.findAllByType('TouchableOpacity');
        expect(buttons()[0].props.disabled).toBe(false);
        act(() => buttons()[0].props.onPress());
        await act(async () => { await buttons().at(-1).props.onPress(); });
        expect(mocks.answer).toHaveBeenCalledExactlyOnceWith('session', 'async-question', { choice: { options: ['Blue'] } }, 'form');
    });

    it('sends a typed answer as free text and clears the previous single choice', async () => {
        renderQuestion();
        act(() => renderer.root.findAllByType('TouchableOpacity')[0].props.onPress());
        act(() => renderer.root.findByType('TextInput').props.onChangeText('Green'));
        await act(async () => { await renderer.root.findAllByType('TouchableOpacity').at(-1).props.onPress(); });
        expect(mocks.answer).toHaveBeenCalledExactlyOnceWith('session', 'async-question', { choice: { options: [], custom: 'Green' } }, 'form');
    });

    it('keeps the form editable when sending an answer fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            mocks.answer.mockRejectedValueOnce(new Error('offline'));
            renderQuestion();
            act(() => renderer.root.findAllByType('TouchableOpacity')[0].props.onPress());
            await act(async () => { await renderer.root.findAllByType('TouchableOpacity').at(-1).props.onPress(); });
            expect(renderer.root.findByType('TextInput').props.editable).toBe(true);
            expect(error).toHaveBeenCalledWith('Failed to submit question answer:', expect.any(Error));
        } finally { error.mockRestore(); }
    });
});
