import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({ authenticated: true, navigate: vi.fn() }));

vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ScrollView: host('ScrollView'),
        Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
        useWindowDimensions: () => ({ width: 1280, height: 800 }),
    };
});
vi.mock('react-native-unistyles', () => {
    const theme = { dark: true, colors: { text: '#fff', textSecondary: '#ccc', success: '#32D74B', surface: '#212121', divider: '#444' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { create: (factory: any) => typeof factory === 'function' ? factory(theme) : factory } };
});
vi.mock('@expo/vector-icons', async () => {
    const React = await import('react');
    return { Ionicons: (props: any) => React.createElement('Icon', props) };
});
vi.mock('@/components/StatusDot', async () => {
    const React = await import('react');
    return { StatusDot: (props: any) => React.createElement('StatusDot', props) };
});
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: mocks.authenticated }) }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (session: Session) => session.metadata?.summary?.text ?? session.id }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/storage', async () => {
    const { create } = await import('zustand');
    return { storage: create(() => ({
        sessions: {} as Record<string, Session>, unreadSessionIds: new Set<string>(),
        archivingSessionIds: new Set<string>(), currentViewingSessionId: null as string | null,
    })) };
});

import { storage } from '@/sync/storage';
import { SessionCompletionNotifications } from './SessionCompletionNotifications';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';

function session(id: string, thinking = false): Session {
    return {
        id, thinking, presence: 'online', active: true, agentState: null,
        metadata: { summary: { text: `Title ${id}`, updatedAt: 1 } },
    } as Session;
}
let tree: ReturnType<typeof create> | undefined;
function render(element: React.ReactElement = React.createElement(SessionCompletionNotifications)) {
    act(() => { tree = create(element); });
    return tree!;
}
function update(patch: Partial<ReturnType<typeof storage.getState>>) {
    act(() => storage.setState(patch));
}
function cards() {
    return tree!.root.findAllByType('View').filter((node: any) => node.props.testID?.startsWith('session-completion-') && node.props.testID !== 'session-completion-notifications');
}
function press(label: string) {
    const button = tree!.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel.includes(label));
    expect(button).toBeDefined();
    act(() => button!.props.onPress());
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.authenticated = true;
    mocks.navigate.mockReset();
    storage.setState({ sessions: { a: session('a'), b: session('b') }, unreadSessionIds: new Set(), archivingSessionIds: new Set(), currentViewingSessionId: null });
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterEach(() => {
    if (tree) act(() => tree.unmount());
    tree = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('web completion notifications', () => {
    it('keeps completed cards visible without a timeout and does not duplicate them on updates', () => {
        vi.useFakeTimers();
        render();
        expect(cards()).toHaveLength(0);
        update({ unreadSessionIds: new Set(['a', 'b']) });
        expect(cards().map((card: any) => card.props.testID)).toEqual(['session-completion-b', 'session-completion-a']);
        act(() => vi.advanceTimersByTime(60 * 60 * 1000));
        update({ sessions: { ...storage.getState().sessions } });
        expect(cards()).toHaveLength(2);
    });

    it('opens the correct conversation and removes its card when it becomes read', () => {
        render();
        update({ unreadSessionIds: new Set(['a']) });
        press('Title a');
        expect(mocks.navigate).toHaveBeenCalledWith('a');
        update({ currentViewingSessionId: 'a', unreadSessionIds: new Set() });
        expect(cards()).toHaveLength(0);
    });

    it('dismisses only the card, preserves unread, and notifies again on the next completed turn', () => {
        render();
        update({ unreadSessionIds: new Set(['a']) });
        press('status.dismissCompletion');
        expect(cards()).toHaveLength(0);
        expect(storage.getState().unreadSessionIds.has('a')).toBe(true);
        update({ sessions: { ...storage.getState().sessions } });
        expect(cards()).toHaveLength(0);
        update({ sessions: { a: session('a', true) }, unreadSessionIds: new Set() });
        update({ sessions: { a: session('a') }, unreadSessionIds: new Set(['a']) });
        expect(cards()).toHaveLength(1);
    });

    it('removes cards when archived or deleted and keeps the rest of the queue', () => {
        render();
        update({ unreadSessionIds: new Set(['a', 'b']) });
        update({ archivingSessionIds: new Set(['a']) });
        expect(cards().map((card: any) => card.props.testID)).toEqual(['session-completion-b']);
        update({ sessions: {} });
        expect(cards()).toHaveLength(0);
    });

    it('does not show completion notifications when logged out', () => {
        mocks.authenticated = false;
        storage.setState({ unreadSessionIds: new Set(['a']) });
        render();
        expect(tree!.toJSON()).toBeNull();
    });
});

describe('web session status badge', () => {
    it.each([
        ['thinking', true, 'status.running', '#007AFF'],
        ['waiting', true, 'status.completed', '#34C759'],
        ['permission_required', true, 'status.permissionRequired', '#FF9500'],
        ['input_required', true, 'status.inputRequired', '#FF9500'],
    ] as const)('shows %s with a steady, explicitly labelled signal', (state, hasUnread, label, color) => {
        render(React.createElement(SessionStatusBadge, { state, hasUnread }));
        expect(tree!.root.findByType('View').props.accessibilityLabel).toBe(label);
        if (state === 'waiting') {
            expect(tree!.root.findByType('Icon').props).toMatchObject({ name: 'checkmark-circle', color });
        } else {
            expect(tree!.root.findByType('StatusDot').props).toMatchObject({ color });
            expect(tree!.root.findByType('StatusDot').props.isPulsing).toBeUndefined();
        }
    });
});
