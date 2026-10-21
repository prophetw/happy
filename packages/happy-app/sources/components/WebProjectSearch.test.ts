import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectSearchOption } from '@/sync/recentProjects';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'), ScrollView: host('ScrollView') };
});
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: '#000', textSecondary: '#666', surface: '#fff', surfacePressedOverlay: '#eee', divider: '#ddd' } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { WebProjectSearch } from './WebProjectSearch';

const options: ProjectSearchOption[] = [
    { key: 'linux', machineId: 'linux', machineName: 'Linux', online: true, name: 'happy', path: '/code/happy', description: '/code/happy Linux', lastUsedAt: 20 },
    { key: 'windows', machineId: 'windows', machineName: 'Windows', online: false, name: 'happy', path: 'D:\\code\\happy', description: 'D:\\code\\happy Windows', lastUsedAt: 10 },
];
const renderers: ReturnType<typeof create>[] = [];
beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalError = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalError(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach((renderer) => renderer.unmount())));
function render(onSelect = vi.fn()) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(WebProjectSearch, { options, onSelect })); });
    renderers.push(renderer);
    const input = () => renderer.root.findByType('TextInput');
    const rows = () => renderer.root.findAllByType('Pressable').filter((row: any) => row.props.testID === 'project-search-result');
    const picker = () => renderer.root.findAllByType('View').find((node: any) => node.props.testID === 'web-project-search');
    return { renderer, onSelect, input, rows, picker };
}

describe('Web cross-machine project picker', () => {
    it('searches all machines without selecting anything until a result is pressed', () => {
        const view = render();
        act(() => view.input().props.onChangeText('happy'));
        expect(view.rows()).toHaveLength(2);
        expect(view.onSelect).not.toHaveBeenCalled();
        act(() => view.rows()[1].props.onPress());
        expect(view.onSelect).toHaveBeenCalledWith(options[1]);
        expect(view.input().props.value).toBe('');
        expect(view.rows()).toHaveLength(0);
    });

    it('supports keyboard selection and Escape without applying search text as a directory', () => {
        const view = render();
        act(() => view.input().props.onFocus());
        const key = (value: string) => act(() => view.input().props.onKeyPress({ nativeEvent: { key: value }, preventDefault: vi.fn() }));
        key('ArrowDown');
        key('Enter');
        expect(view.onSelect).toHaveBeenCalledWith(options[1]);
        act(() => view.input().props.onChangeText('happy'));
        key('Escape');
        expect(view.rows()).toHaveLength(0);
        expect(view.onSelect).toHaveBeenCalledTimes(1);
    });

    it('keeps an offline project selectable and renders a useful no-results state', () => {
        const view = render();
        act(() => view.input().props.onChangeText('D:\\code\\happy'));
        expect(view.rows()).toHaveLength(1);
        expect(view.rows()[0].props.accessibilityLabel).toContain('Windows');
        act(() => view.input().props.onChangeText('unknown-zzzzzz-project'));
        expect(view.rows()).toHaveLength(0);
        expect(view.renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'machineLauncher.noMatchingDirectories')).toBe(true);
        expect(view.onSelect).not.toHaveBeenCalled();
    });

    it('keeps a result mounted when input blur happens before press-in and focus moves to the result', () => {
        const view = render();
        act(() => view.input().props.onFocus());
        act(() => view.picker().props.onBlur({ currentTarget: { contains: () => true }, relatedTarget: {} }));
        expect(view.rows()).toHaveLength(2);
        act(() => view.rows()[1].props.onPress());
        expect(view.onSelect).toHaveBeenCalledWith(options[1]);
    });

    it('closes the results when focus leaves the whole picker', () => {
        const view = render();
        act(() => view.input().props.onFocus());
        act(() => view.picker().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }));
        expect(view.rows()).toHaveLength(0);
        expect(view.onSelect).not.toHaveBeenCalled();
    });

    it('does not select a project when Enter is confirming IME composition', () => {
        const view = render();
        act(() => view.input().props.onFocus());
        act(() => view.input().props.onKeyPress({ nativeEvent: { key: 'Enter', isComposing: true }, preventDefault: vi.fn() }));
        expect(view.onSelect).not.toHaveBeenCalled();
    });
});
