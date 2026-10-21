import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolViewProps } from './_all';

const mocks = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), TextInput: host('TextInput'),
        TouchableOpacity: host('TouchableOpacity'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { select: (value: any) => value.web ?? value.default },
    };
});
vi.mock('react-native-unistyles', async () => {
    const { lightTheme } = await import('@/theme');
    return {
        StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles(lightTheme) : styles },
        useUnistyles: () => ({ theme: lightTheme }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/ops', () => ({ sessionAllow: mocks.allow }));
vi.mock('../ToolSectionView', async () => {
    const React = await import('react');
    return { ToolSectionView: (props: any) => React.createElement('Section', props, props.children) };
});

import { AskUserQuestionView } from './AskUserQuestionView';

let renderer: any;
beforeAll(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterEach(() => {
    if (renderer) act(() => renderer.unmount());
    vi.clearAllMocks();
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function renderQuestion(multiSelect = false) {
    const tool: ToolViewProps['tool'] = {
        name: 'AskUserQuestion', state: 'running', description: null, createdAt: 1,
        startedAt: 1, completedAt: null,
        permission: { id: 'question-permission', status: 'pending' },
        input: {
            questions: [{
                header: '输入密码', question: '请在此输入密码', multiSelect,
                options: [{ label: '在此输入密码', description: '直接在此框输入' }, { label: '跳过收工' }],
            }],
        },
    };
    act(() => {
        renderer = create(React.createElement(AskUserQuestionView, {
            tool, sessionId: 'session', metadata: null, messages: [],
        }));
    });
}

describe('Claude question card', () => {
    it('offers an editable custom answer without requiring an allowCustom flag', async () => {
        renderQuestion();
        const buttons = () => renderer.root.findAllByType('TouchableOpacity');
        expect(buttons().at(-1).props.disabled).toBe(true);
        act(() => buttons()[0].props.onPress());

        const input = renderer.root.findByType('TextInput');
        expect(input.props.editable).toBe(true);
        act(() => input.props.onChangeText('typed-answer'));
        await act(async () => { await buttons().at(-1).props.onPress(); });

        expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
            'session', 'question-permission', undefined, undefined, 'approved',
            { answers: { '请在此输入密码': 'typed-answer' } },
        );
    });

    it('accepts a typed answer without selecting a predefined option', async () => {
        renderQuestion();
        const submit = () => renderer.root.findAllByType('TouchableOpacity').at(-1);
        act(() => renderer.root.findByType('TextInput').props.onChangeText('   '));
        expect(submit().props.disabled).toBe(true);
        act(() => renderer.root.findByType('TextInput').props.onChangeText(' typed-answer '));
        expect(submit().props.disabled).toBe(false);
        await act(async () => { await submit().props.onPress(); });

        expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
            'session', 'question-permission', undefined, undefined, 'approved',
            { answers: { '请在此输入密码': 'typed-answer' } },
        );
    });

    it('clears a typed answer when switching back to a predefined single choice', async () => {
        renderQuestion();
        act(() => renderer.root.findByType('TextInput').props.onChangeText('typed-answer'));
        act(() => renderer.root.findAllByType('TouchableOpacity')[1].props.onPress());
        expect(renderer.root.findByType('TextInput').props.value).toBe('');
        await act(async () => {
            await renderer.root.findAllByType('TouchableOpacity').at(-1).props.onPress();
        });

        expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
            'session', 'question-permission', undefined, undefined, 'approved',
            { answers: { '请在此输入密码': '跳过收工' } },
        );
    });

    it('preserves selected options alongside a typed answer for multiple choice', async () => {
        renderQuestion(true);
        act(() => renderer.root.findAllByType('TouchableOpacity')[0].props.onPress());
        act(() => renderer.root.findByType('TextInput').props.onChangeText('typed-answer'));
        await act(async () => {
            await renderer.root.findAllByType('TouchableOpacity').at(-1).props.onPress();
        });

        expect(mocks.allow).toHaveBeenCalledExactlyOnceWith(
            'session', 'question-permission', undefined, undefined, 'approved',
            { answers: { '请在此输入密码': '在此输入密码, typed-answer' } },
        );
    });
});
