import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolViewProps } from './_all';

const mocks = vi.hoisted(() => ({
    image: { uri: null as string | null, loading: false, error: null as string | null },
    loadImage: vi.fn(),
    dismissKeyboard: vi.fn(),
}));

vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'), Modal: host('Modal'),
        Keyboard: { dismiss: mocks.dismissKeyboard },
        StyleSheet: { create: (styles: any) => styles },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('expo-image', async () => {
    const React = await import('react');
    return { Image: (props: any) => React.createElement('Image', props) };
});
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => typeof styles === 'function' ? styles() : styles },
    useUnistyles: () => ({ theme: { colors: { textSecondary: '#888', surfaceHigh: '#333' } } }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('react-native-gesture-handler', async () => {
    const React = await import('react');
    const gesture = () => {
        const builder: any = { handlers: {} };
        for (const method of ['onStart', 'onUpdate', 'onEnd', 'numberOfTaps', 'maxPointers']) {
            builder[method] = (value: unknown) => { builder.handlers[method] = value; return builder; };
        }
        return builder;
    };
    return {
        Gesture: { Pinch: gesture, Pan: gesture, Tap: gesture, Simultaneous: (...items: any[]) => items },
        GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
        GestureHandlerRootView: (props: any) => React.createElement('GestureHandlerRootView', props, props.children),
    };
});
vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        default: { View: (props: any) => React.createElement('AnimatedView', props, props.children) },
        useSharedValue: (value: number) => React.useRef({ value }).current,
        useAnimatedStyle: (callback: () => { transform: unknown }) => ({ get transform() { return callback().transform; } }),
    };
});
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: mocks.loadImage }));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: () => 'data:image/png;base64,placeholder' }));

import { FileView } from './FileView';

let renderer: ReturnType<typeof create> | undefined;
const input = {
    ref: 'sessions/session/attachments/image', name: 'IMG_3051.jpg',
    image: { width: 1170, height: 4000, thumbhash: 'hash' },
};
function props(attachment: unknown = input): ToolViewProps {
    return {
        tool: { name: 'file', input: attachment, state: 'completed', description: null, createdAt: 1, startedAt: 1, completedAt: 2 },
        metadata: null, messages: [], sessionId: 'session',
    };
}
function render(attachment: unknown = input) {
    act(() => { renderer = create(React.createElement(FileView, props(attachment))); });
    return renderer!;
}

beforeAll(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
beforeEach(() => {
    mocks.image = { uri: 'data:image/jpeg;base64,decrypted', loading: false, error: null };
    mocks.loadImage.mockImplementation(() => mocks.image);
});
afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    vi.clearAllMocks();
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('sent image preview', () => {
    it('opens the decrypted image at full screen when the thumbnail is pressed', () => {
        const tree = render();
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
        const thumbnail = tree.root.findByType('Pressable');
        expect(thumbnail.props.disabled).toBe(false);
        act(() => thumbnail.props.onPress());
        expect(mocks.dismissKeyboard).toHaveBeenCalledOnce();
        const modal = tree.root.findByType('Modal');
        expect(modal.props).toMatchObject({ visible: true, presentationStyle: 'fullScreen' });
        expect(modal.findByType('Image').props).toMatchObject({
            source: { uri: mocks.image.uri }, contentFit: 'contain',
        });
        expect(mocks.loadImage).toHaveBeenCalledWith('session', input.ref);
    });

    it.each([
        { uri: null, loading: true, error: null },
        { uri: null, loading: false, error: 'decrypt_failed' },
    ])('does not open a placeholder or a failed attachment: %j', state => {
        mocks.image = state;
        const tree = render();
        const thumbnail = tree.root.findByType('Pressable');
        expect(thumbnail.props.disabled).toBe(true);
        act(() => thumbnail.props.onPress());
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
        expect(mocks.dismissKeyboard).not.toHaveBeenCalled();
    });

    it('enables preview once a pending image finishes loading', () => {
        mocks.image = { uri: null, loading: true, error: null };
        const tree = render();
        mocks.image = { uri: 'data:image/png;base64,ready', loading: false, error: null };
        act(() => tree.update(React.createElement(FileView, props({ ...input }))));
        act(() => tree.root.findByType('Pressable').props.onPress());
        expect(tree.root.findByType('Modal').findByType('Image').props.source.uri).toBe(mocks.image.uri);
    });

    it('previews older messages without image dimensions', () => {
        const tree = render({ ref: input.ref, name: input.name });
        act(() => tree.root.findByType('Pressable').props.onPress());
        expect(tree.root.findByType('Modal').findByType('Image').props.contentFit).toBe('contain');
    });

    it.each(['close button', 'system back'])('dismisses through %s and can reopen', method => {
        const tree = render();
        act(() => tree.root.findByType('Pressable').props.onPress());
        const modal = tree.root.findByType('Modal');
        act(() => method === 'close button'
            ? modal.findByType('Pressable').props.onPress()
            : modal.props.onRequestClose());
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
        act(() => tree.root.findByType('Pressable').props.onPress());
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
    });

    it('closes the preview when a chat row is reused for another attachment', () => {
        const tree = render();
        act(() => tree.root.findByType('Pressable').props.onPress());
        act(() => tree.update(React.createElement(FileView, props({ ...input, ref: 'another-image' }))));
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
    });

    it('can recover from an incomplete file event without changing hook order', () => {
        const tree = render({});
        expect(tree.toJSON()).toBeNull();
        act(() => tree.update(React.createElement(FileView, props())));
        act(() => tree.root.findByType('Pressable').props.onPress());
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
    });

    function openMeasuredPreview() {
        const tree = render();
        act(() => tree.root.findByType('Pressable').props.onPress());
        act(() => tree.root.findByType('GestureDetector').findByType('View').props.onLayout({
            nativeEvent: { layout: { width: 390, height: 700 } },
        }));
        act(() => tree.root.findByType('Modal').findByType('Image').props.onLoad({ source: { width: 1170, height: 4000 } }));
        const gestures = tree.root.findByType('GestureDetector').props.gesture;
        const transform = () => tree.root.findByType('AnimatedView').props.style[1].transform;
        return { tree, gestures, transform };
    }

    it('zooms and pans a long screenshot within its bounds, then resets on double tap', () => {
        const { gestures: [pinch, pan, doubleTap], transform } = openMeasuredPreview();
        pinch.handlers.onStart();
        pinch.handlers.onUpdate({ scale: 3 });
        expect(transform()[2]).toEqual({ scale: 3 });
        pan.handlers.onStart();
        pan.handlers.onUpdate({ translationX: 10000, translationY: -10000 });
        expect(transform()[0].translateX).toBeCloseTo(112.125);
        expect(transform()[1]).toEqual({ translateY: -700 });
        doubleTap.handlers.onEnd({ x: 195, y: 350 }, true);
        expect(transform()).toEqual([{ translateX: 0 }, { translateY: 0 }, { scale: 1 }]);
    });

    it('limits pinch zoom and zooms towards a double-tapped point', () => {
        const { gestures: [pinch, , doubleTap], transform } = openMeasuredPreview();
        pinch.handlers.onStart();
        pinch.handlers.onUpdate({ scale: 100 });
        expect(transform()[2]).toEqual({ scale: 5 });
        pinch.handlers.onUpdate({ scale: 0.1 });
        expect(transform()[2]).toEqual({ scale: 1 });
        doubleTap.handlers.onEnd({ x: 195, y: 200 }, true);
        expect(transform()).toEqual([{ translateX: 0 }, { translateY: 300 }, { scale: 3 }]);
    });
});
