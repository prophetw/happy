import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable'), Image: host('Image'), ScrollView: host('ScrollView'),
        Platform: { OS: 'web', select: (values: any) => values.web ?? values.default } };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: {} } }),
    StyleSheet: { create: (factory: (theme: any) => unknown) => factory({ colors: {} }), hairlineWidth: 1 },
}));
vi.mock('react-native-gesture-handler', () => ({ Gesture: {}, GestureDetector: 'GestureDetector' }));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-web-browser', () => ({}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/sync/storage', () => ({ useLocalSetting: () => false }));
vi.mock('@/sync/persistence', () => ({ storeTempText: vi.fn() }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { MarkdownView } from './MarkdownView';

const renderers: ReturnType<typeof create>[] = [];
const command = '确认工具 173622e9-cfe9-4e54-a6aa-45733ac1b91b';
const markdown = `工具操作需要确认：Notes.write\n参数：{}\n\n<options>\n<option>${command}</option>\n</options>`;
function render(props: React.ComponentProps<typeof MarkdownView>) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(MarkdownView, props)); });
    renderers.push(renderer);
    return renderer;
}
afterEach(() => act(() => renderers.splice(0).forEach(renderer => renderer.unmount())));

it('renders the host confirmation as a short button while sending its complete command', () => {
    const onOptionPress = vi.fn();
    const renderer = render({ markdown, toolConfirmation: command, onOptionPress });
    const button = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '确认这次操作');
    expect(button).toBeDefined();
    expect(button.findByType('Text').props.children).toBe('确认这次操作');
    act(() => button.props.onPress());
    expect(onOptionPress).toHaveBeenCalledWith({ title: command });
});

it('disables only the submitting confirmation and keeps other options usable', () => {
    const onOptionPress = vi.fn();
    const renderer = render({ markdown: markdown.replace('</options>', '<option>查看进度</option>\n</options>'),
        toolConfirmation: command, toolConfirmationPending: true, onOptionPress });
    const buttons = renderer.root.findAllByType('Pressable');
    const confirm = buttons.find((node: any) => node.props.accessibilityLabel === '确认这次操作');
    const progress = buttons.find((node: any) => node.props.accessibilityLabel === '查看进度');
    expect(confirm.props.disabled).toBe(true);
    expect(confirm.props.accessibilityState.disabled).toBe(true);
    expect(confirm.findByType('Text').props.children).toBe('正在发送确认…');
    act(() => { confirm.props.onPress(); progress.props.onPress(); });
    expect(onOptionPress.mock.calls).toEqual([[{ title: '查看进度' }]]);
});

it.each([undefined, '确认工具 233d733a-7da7-49ee-a7b1-d596be44bca9'])('keeps an inactive confirmation as text (%s)', toolConfirmation => {
    const renderer = render({ markdown, toolConfirmation, onOptionPress: vi.fn() });
    expect(renderer.root.findAllByType('Pressable')).toEqual([]);
});

it.each(['继续查看', '确认工具 unknown', command + ' please'])('preserves ordinary option text and its sent value (%s)', value => {
    const onOptionPress = vi.fn();
    const renderer = render({ markdown: `<options>\n<option>${value}</option>\n</options>`, onOptionPress });
    const button = renderer.root.findByType('Pressable');
    expect(button.props.accessibilityLabel).toBe(value);
    expect(button.findByType('Text').props.children).toBe(value);
    act(() => button.props.onPress());
    expect(onOptionPress).toHaveBeenCalledWith({ title: value });
});
