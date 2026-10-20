import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), haptic: vi.fn(async () => {}), badge: vi.fn(async () => true) }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ScrollView: host('ScrollView'),
        Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
        AppState: { currentState: 'active' }, useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: '#fff', textSecondary: '#ccc', success: '#32D74B', surface: '#212121', divider: '#444' } };
    return { useUnistyles: () => ({ theme }), StyleSheet: { hairlineWidth: 1, create: (factory: any) => typeof factory === 'function' ? factory(theme) : factory } };
});
vi.mock('@expo/vector-icons', async () => {
    const React = await import('react');
    return { Ionicons: (props: any) => React.createElement('Icon', props) };
});
vi.mock('expo-haptics', () => ({ notificationAsync: mocks.haptic, NotificationFeedbackType: { Error: 'error', Success: 'success' } }));
vi.mock('expo-notifications', () => ({ setBadgeCountAsync: mocks.badge }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (session: Session) => session.id }));
vi.mock('@/text', () => ({ t: (key: string, args?: { completed: number; action: number }) => args ? `${args.completed} completed, ${args.action} action` : key }));
vi.mock('@/sync/storage', async () => {
    const { create } = await import('zustand');
    return { storage: create(() => ({
        sessions: {} as Record<string, Session>, unreadSessionIds: new Set<string>(), sessionAttention: {},
        archivingSessionIds: new Set<string>(), currentViewingSessionId: null as string | null,
        appIsActive: true, isDataReady: true, settings: { sessionNotificationHaptics: true },
    })) };
});

import { storage } from '@/sync/storage';
import { MobileSessionNotificationContent } from './MobileSessionNotifications';

const session = (id: string, patch: Partial<Session> = {}): Session => ({ id, active: true, presence: 'online', thinking: false, agentState: null, metadata: null, updatedAt: 1, ...patch } as Session);
let tree: ReturnType<typeof create>;
const update = (patch: Partial<ReturnType<typeof storage.getState>>) => act(() => storage.setState(patch));
const views = (id: string) => tree.root.findAllByType('View').filter((node: any) => node.props.testID === id);
const button = (name: string) => tree.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === name);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.clearAllMocks();
    storage.setState({ sessions: {}, unreadSessionIds: new Set(), sessionAttention: {}, archivingSessionIds: new Set(), currentViewingSessionId: null, appIsActive: true });
    storage.setState(state => ({ settings: { ...state.settings, sessionNotificationHaptics: true } }));
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
    act(() => { tree = create(React.createElement(MobileSessionNotificationContent)); });
});
afterEach(() => { act(() => tree.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('iOS in-app session reminders', () => {
    it('uses one haptic and a temporary banner while the summary remains until the result is read', () => {
        update({ sessions: { a: session('a') }, unreadSessionIds: new Set(['a']) });
        expect(mocks.haptic).toHaveBeenCalledOnce();
        expect(views('mobile-attention-banner')).toHaveLength(1);
        update({ sessionAttention: { a: { kind: 'done', eventId: 'done:2:1', seq: 2, at: 20, read: false, version: 0 } } });
        expect(mocks.haptic).toHaveBeenCalledOnce();
        expect(views('mobile-attention-banner')).toHaveLength(1);
        act(() => vi.advanceTimersByTime(4000));
        expect(views('mobile-attention-banner')).toHaveLength(0);
        expect(tree.root.findAllByType('Pressable').some((node: any) => node.props.testID === 'mobile-attention-summary')).toBe(true);
        update({ sessions: { ...storage.getState().sessions } });
        expect(mocks.haptic).toHaveBeenCalledOnce();
        expect(mocks.badge).toHaveBeenLastCalledWith(1);
    });

    it('opens the reminder list, preserves unread when dismissed, and navigates to the exact conversation', () => {
        update({ sessions: { a: session('a') }, unreadSessionIds: new Set(['a']) });
        const pill = () => tree.root.findAllByType('Pressable').find((node: any) => node.props.testID === 'mobile-attention-summary');
        act(() => pill()!.props.onPress());
        act(() => button('sessionNotifications.close')!.props.onPress());
        expect(storage.getState().unreadSessionIds.has('a')).toBe(true);
        act(() => pill()!.props.onPress());
        act(() => button('a')!.props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('a');
    });

    it('prioritizes blocked and failed conversations and respects background and haptic preferences', () => {
        update({ appIsActive: false, sessions: { a: session('a', { attentionKind: 'failed' }) }, unreadSessionIds: new Set(['a']) });
        expect(mocks.haptic).not.toHaveBeenCalled();
        update({ appIsActive: true, currentViewingSessionId: 'a' });
        expect(mocks.badge).toHaveBeenLastCalledWith(0);
        update({ currentViewingSessionId: null, settings: { ...storage.getState().settings, sessionNotificationHaptics: false } });
        expect(mocks.haptic).not.toHaveBeenCalled();
    });
});
