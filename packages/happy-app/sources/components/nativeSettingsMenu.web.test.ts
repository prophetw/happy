import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => ReactModule.forwardRef((props: any, ref: any) =>
        ReactModule.createElement(name, { ...props, ref }, props.children)
    );
    return {
        Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web ?? choices.default },
        StyleSheet: {
            absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
            create: (styles: unknown) => styles,
            hairlineWidth: 1,
        },
        View: host('View'),
        Text: host('Text'),
        Pressable: host('Pressable'),
        Modal: host('Modal'),
        ScrollView: host('ScrollView'),
        useWindowDimensions: () => ({ width: 1024, height: 768 }),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: '#000000',
                textSecondary: '#666666',
                surface: '#ffffff',
                surfaceSelected: '#eaeaea',
                divider: '#eeeeee',
                modal: { border: 'rgba(0,0,0,0.1)' },
                shadow: { color: '#000000', opacity: 0.1 },
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => typeof factory === 'function'
            ? factory({
                dark: false,
                colors: {
                    text: '#000000',
                    textSecondary: '#666666',
                    surface: '#ffffff',
                    surfaceSelected: '#eaeaea',
                    divider: '#eeeeee',
                    modal: { border: 'rgba(0,0,0,0.1)' },
                    shadow: { color: '#000000', opacity: 0.1 },
                },
            })
            : factory,
        absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({ fontFamily: 'System' }),
    },
}));

import { NativeSettingsMenu } from './NativeSettingsMenu.web';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});

afterAll(() => vi.restoreAllMocks());

function render(element: React.ReactElement): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(element);
    });
    return renderer;
}

describe('Web native settings menu', () => {
    it('opens menu when trigger is pressed and triggers onMenuOpen', () => {
        const onMenuOpen = vi.fn();
        const onSelect = vi.fn();

        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'usage',
                label: 'Usage',
                selectedKey: null,
                options: [
                    { key: 'session', label: 'Session · 32%\nResets at 6:00 PM' },
                    { key: 'week', label: 'Week · 99%\nResets Mon 9:00 AM' },
                ],
                onSelect,
            }],
            onMenuOpen,
            children: React.createElement('Text', {}, 'Trigger Text'),
        }));

        // Initially modal is not open
        expect(renderer.root.findAllByType('Modal' as any)).toHaveLength(0);

        // Find trigger Pressable
        const trigger = renderer.root.findByType('Pressable' as any);
        act(() => {
            trigger.props.onPress();
        });

        expect(onMenuOpen).toHaveBeenCalledTimes(1);

        // Modal should now be open
        const modal = renderer.root.findByType('Modal' as any);
        expect(modal.props.visible).toBe(true);

        // Option items should be rendered
        const texts = renderer.root.findAllByType('Text' as any);
        const textContents = texts.map((t: any) => t.props.children).flat();
        expect(textContents).toContain('Session · 32%');
        expect(textContents).toContain('Resets at 6:00 PM');
        expect(textContents).toContain('Week · 99%');
        expect(textContents).toContain('Resets Mon 9:00 AM');
    });

    it('handles option click and calls onSelect, then closes menu', () => {
        const onSelect = vi.fn();

        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'settings',
                label: 'Settings',
                selectedKey: null,
                options: [
                    { key: 'opt1', label: 'Option 1' },
                    { key: 'opt2', label: 'Option 2', disabled: true },
                ],
                onSelect,
            }],
            children: React.createElement('Text', {}, 'Click me'),
        }));

        // Open menu
        act(() => {
            renderer.root.findByType('Pressable' as any).props.onPress();
        });

        // Find the options (inside the modal)
        const pressables = renderer.root.findAllByType('Pressable' as any);
        const opt1 = pressables.find((p: any) => p.props.accessibilityRole === 'menuitem' && p.props.accessibilityState?.disabled === false);
        const opt2 = pressables.find((p: any) => p.props.accessibilityRole === 'menuitem' && p.props.accessibilityState?.disabled === true);

        expect(opt1).toBeDefined();
        expect(opt2).toBeDefined();

        // Clicking disabled option does not call onSelect
        act(() => {
            opt2.props.onPress();
        });
        expect(onSelect).not.toHaveBeenCalled();

        // Clicking enabled option calls onSelect and closes modal
        act(() => {
            opt1.props.onPress();
        });
        expect(onSelect).toHaveBeenCalledWith('opt1');
        expect(renderer.root.findAllByType('Modal' as any)).toHaveLength(0);
    });

    it('closes menu when backdrop is clicked', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'usage',
                label: 'Usage',
                selectedKey: null,
                options: [{ key: 'session', label: 'Session' }],
                onSelect: vi.fn(),
            }],
            children: React.createElement('Text', {}, 'Trigger'),
        }));

        // Open menu
        act(() => {
            renderer.root.findByType('Pressable' as any).props.onPress();
        });
        expect(renderer.root.findAllByType('Modal' as any)).toHaveLength(1);

        // First pressable inside Modal is the backdrop
        const modal = renderer.root.findByType('Modal' as any);
        const backdrop = modal.findAllByType('Pressable' as any)[0];
        act(() => {
            backdrop.props.onPress();
        });

        expect(renderer.root.findAllByType('Modal' as any)).toHaveLength(0);
    });

    it('shows checkmark for selected option in choice groups', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'theme',
                label: 'Theme',
                selectedKey: 'dark',
                options: [
                    { key: 'light', label: 'Light' },
                    { key: 'dark', label: 'Dark' },
                ],
                onSelect: vi.fn(),
            }],
            children: React.createElement('Text', {}, 'Theme'),
        }));

        act(() => {
            renderer.root.findByType('Pressable' as any).props.onPress();
        });

        const ionicons = renderer.root.findAllByType('Ionicons' as any);
        const checkmarks = ionicons.filter((i: any) => i.props.name === 'checkmark');
        expect(checkmarks).toHaveLength(1);
    });

    it('renders group headers unless flat is true', () => {
        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'group1',
                label: 'Group 1',
                title: 'Section Header',
                selectedKey: null,
                options: [{ key: 'item1', label: 'Item 1' }],
                onSelect: vi.fn(),
            }],
            flat: false,
            children: React.createElement('Text', {}, 'Trigger'),
        }));

        act(() => {
            renderer.root.findByType('Pressable' as any).props.onPress();
        });

        const texts = renderer.root.findAllByType('Text' as any);
        const textContents = texts.map((t: any) => t.props.children).flat();
        expect(textContents).toContain('Section Header');
    });

    it('does not open menu when options are empty', () => {
        const onMenuOpen = vi.fn();

        const renderer = render(React.createElement(NativeSettingsMenu, {
            groups: [{
                key: 'empty',
                label: 'Empty',
                selectedKey: null,
                options: [],
                onSelect: vi.fn(),
            }],
            onMenuOpen,
            children: React.createElement('Text', {}, 'Empty'),
        }));

        act(() => {
            renderer.root.findByType('Pressable' as any).props.onPress();
        });

        expect(onMenuOpen).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Modal' as any)).toHaveLength(0);
    });
});
