import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({
    authenticated: true, navigate: vi.fn(), foreground: true,
    setCompletedSessionCount: vi.fn(), updateFavicon: vi.fn(), resetFavicon: vi.fn(),
}));

vi.mock('@/sync/webTabTitle', () => ({
    isWebTabActive: () => mocks.foreground,
    setCompletedSessionCount: mocks.setCompletedSessionCount,
}));
vi.mock('@/utils/web/faviconGenerator', () => ({
    updateFaviconWithNotification: mocks.updateFavicon,
    resetFavicon: mocks.resetFavicon,
}));

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
    const store = create(() => ({
        sessions: {} as Record<string, Session>, unreadSessionIds: new Set<string>(),
        archivingSessionIds: new Set<string>(), currentViewingSessionId: null as string | null,
        isDataReady: true, localSettings: { desktopNotificationsEnabled: false },
        setCurrentViewingSession: (id: string | null) => storage.setState({ currentViewingSessionId: id }),
        markSessionRead: (id: string) => {
            const next = new Set(storage.getState().unreadSessionIds);
            next.delete(id);
            storage.setState({ unreadSessionIds: next });
        },
    }));
    return { storage: store, useLocalSetting: (name: 'desktopNotificationsEnabled') => store(state => state.localSettings[name]) };
});

import { storage } from '@/sync/storage';
import { SessionCompletionNotifications } from './SessionCompletionNotifications';
import { SessionStatusBadge } from '@/components/SessionStatusBadge';
import { WebTabStatus } from './WebTabStatus';

const desktopNotifications: TestNotification[] = [];
class TestNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn();
    close = vi.fn();
    onclick: ((event: Event) => void) | null = null;
    constructor(public title: string, public options: NotificationOptions) { desktopNotifications.push(this); }
}

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
    mocks.foreground = true;
    mocks.setCompletedSessionCount.mockReset();
    mocks.updateFavicon.mockReset();
    mocks.resetFavicon.mockReset();
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('window', Object.assign(new EventTarget(), { isSecureContext: true, focus: vi.fn() }));
    vi.stubGlobal('Notification', TestNotification);
    TestNotification.permission = 'granted';
    TestNotification.requestPermission.mockReset();
    desktopNotifications.length = 0;
    storage.setState({ sessions: { a: session('a'), b: session('b') }, unreadSessionIds: new Set(), archivingSessionIds: new Set(), currentViewingSessionId: null,
        isDataReady: true, localSettings: { ...storage.getState().localSettings, desktopNotificationsEnabled: false },
    });
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});

describe('desktop completion notifications', () => {
    function enable() {
        mocks.foreground = false;
        storage.setState({ localSettings: { ...storage.getState().localSettings, desktopNotificationsEnabled: true } });
    }

    it('notifies once per background turn, opens the right session and closes after reading', () => {
        enable();
        render();
        update({ unreadSessionIds: new Set(['a']) });
        expect(desktopNotifications).toHaveLength(1);
        const notification = desktopNotifications[0];
        expect(notification.title).toBe('Happy · status.completed');
        expect(notification.options).toMatchObject({ body: 'Title a', tag: 'happy-completed-a', data: { sessionId: 'a' } });
        update({ sessions: { ...storage.getState().sessions } });
        press('status.dismissCompletion');
        expect(desktopNotifications).toHaveLength(1);
        act(() => notification.onclick!(new Event('click', { cancelable: true })));
        expect(window.focus).toHaveBeenCalled();
        expect(mocks.navigate).toHaveBeenCalledWith('a');
        update({ unreadSessionIds: new Set() });
        expect(notification.close).toHaveBeenCalled();
        update({ unreadSessionIds: new Set(['a']) });
        expect(desktopNotifications).toHaveLength(2);
        expect(TestNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('claims the clicked destination before focus so another unread conversation stays unread', () => {
        enable();
        render();
        update({ currentViewingSessionId: 'b', unreadSessionIds: new Set(['b']) });
        update({ unreadSessionIds: new Set(['b', 'a']) });
        vi.mocked(window.focus).mockImplementation(() => {
            const state = storage.getState();
            if (state.currentViewingSessionId) state.markSessionRead(state.currentViewingSessionId);
        });
        act(() => desktopNotifications[1].onclick!(new Event('click', { cancelable: true })));
        expect(storage.getState().currentViewingSessionId).toBe('a');
        expect(storage.getState().unreadSessionIds).toEqual(new Set(['b']));
        expect(mocks.navigate).toHaveBeenCalledWith('a');
    });

    it('does not replay old results when enabled, or notify for results received in the foreground', () => {
        render();
        update({ unreadSessionIds: new Set(['a']) });
        mocks.foreground = false;
        update({ localSettings: { ...storage.getState().localSettings, desktopNotificationsEnabled: true } });
        expect(desktopNotifications).toHaveLength(0);
        mocks.foreground = true;
        update({ unreadSessionIds: new Set(['a', 'b']) });
        mocks.foreground = false;
        update({ sessions: { ...storage.getState().sessions } });
        expect(desktopNotifications).toHaveLength(0);
        update({ unreadSessionIds: new Set(['a']) });
        update({ unreadSessionIds: new Set(['a', 'b']) });
        expect(desktopNotifications).toHaveLength(1);
    });

    it('does not replay completion history restored during initial account sync', () => {
        enable();
        storage.setState({ isDataReady: false });
        render();
        update({ isDataReady: true, unreadSessionIds: new Set(['a']) });
        expect(desktopNotifications).toHaveLength(0);
        update({ unreadSessionIds: new Set(['a', 'b']) });
        expect(desktopNotifications).toHaveLength(1);
    });

    it('keeps page indicators working when permission is denied or notification construction fails', () => {
        enable();
        TestNotification.permission = 'denied';
        render();
        update({ unreadSessionIds: new Set(['a']) });
        expect(cards()).toHaveLength(1);
        expect(desktopNotifications).toHaveLength(0);
        TestNotification.permission = 'granted';
        vi.stubGlobal('Notification', class {
            static permission = 'granted';
            constructor() { throw new TypeError('unsupported constructor'); }
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        update({ unreadSessionIds: new Set(['a', 'b']) });
        expect(cards()).toHaveLength(2);
        expect(warning).toHaveBeenCalled();
    });

    it('closes outstanding notifications when disabled or logged out', () => {
        enable();
        render();
        update({ unreadSessionIds: new Set(['a']) });
        update({ localSettings: { ...storage.getState().localSettings, desktopNotificationsEnabled: false } });
        expect(desktopNotifications[0].close).toHaveBeenCalled();
        update({ unreadSessionIds: new Set() });
        update({ localSettings: { ...storage.getState().localSettings, desktopNotificationsEnabled: true } });
        update({ unreadSessionIds: new Set(['b']) });
        mocks.authenticated = false;
        act(() => tree!.update(React.createElement(SessionCompletionNotifications)));
        expect(desktopNotifications[1].close).toHaveBeenCalled();
    });
});

describe('browser tab completion indicator', () => {
    it('updates the title count and favicon from completed sessions without a session-event push', () => {
        mocks.foreground = false;
        render(React.createElement(WebTabStatus));
        update({ unreadSessionIds: new Set(['a', 'b']) });
        expect(mocks.setCompletedSessionCount).toHaveBeenLastCalledWith(2);
        expect(mocks.updateFavicon).toHaveBeenCalled();
        update({ unreadSessionIds: new Set(['b']) });
        expect(mocks.setCompletedSessionCount).toHaveBeenLastCalledWith(1);
        update({ unreadSessionIds: new Set() });
        expect(mocks.setCompletedSessionCount).toHaveBeenLastCalledWith(0);
        expect(mocks.resetFavicon).toHaveBeenCalled();
    });

    it('marks only the open conversation read when the tab becomes visible and focused again', () => {
        mocks.foreground = false;
        storage.setState({ currentViewingSessionId: 'a', unreadSessionIds: new Set(['a', 'b']) });
        render(React.createElement(WebTabStatus));
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        expect(storage.getState().unreadSessionIds.has('a')).toBe(true);
        mocks.foreground = true;
        act(() => window.dispatchEvent(new Event('focus')));
        expect(storage.getState().unreadSessionIds).toEqual(new Set(['b']));
        expect(mocks.setCompletedSessionCount).toHaveBeenLastCalledWith(1);
    });

    it('preserves the permission favicon after the last completion is read', () => {
        const a = session('a');
        a.agentState = { requests: { permission: { tool: 'Bash', arguments: {} } } } as Session['agentState'];
        storage.setState({ sessions: { a, b: session('b') }, unreadSessionIds: new Set(['b']) });
        render(React.createElement(WebTabStatus));
        mocks.resetFavicon.mockClear();
        update({ unreadSessionIds: new Set() });
        expect(mocks.resetFavicon).not.toHaveBeenCalled();
        expect(mocks.updateFavicon).toHaveBeenCalled();
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
