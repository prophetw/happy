import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

const mocks = vi.hoisted(() => ({ send: vi.fn(), rpc: vi.fn(), navigate: vi.fn(), haptic: vi.fn(async () => {}), read: vi.fn() }));
vi.mock('react-native', async () => {
    const React = await import('react');
    const host = (name: string) => (props: any) => React.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ScrollView: host('ScrollView'),
        Modal: (props: any) => props.visible ? React.createElement('Modal', props, props.children) : null,
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
        AppState: { currentState: 'active' },
    };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34 }) }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ colors: { text: '#fff', textSecondary: '#ccc', surface: '#222' } }) } }));
vi.mock('@expo/vector-icons', async () => {
    const React = await import('react');
    return { Ionicons: (props: any) => React.createElement('Icon', props) };
});
vi.mock('expo-haptics', () => ({ notificationAsync: mocks.haptic, NotificationFeedbackType: { Warning: 'warning' } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { sessionRPC: mocks.rpc } }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: mocks.send } }));
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: (session: Session) => session.id }));
vi.mock('@/text', () => ({ t: (key: string, args?: { host: string }) => args ? `${key}: ${args.host}` : key }));
vi.mock('@/sync/storage', async () => {
    const { create } = await import('zustand');
    return { storage: create(() => ({
        sessions: {} as Record<string, Session>, archivingSessionIds: new Set<string>(), sessionAttention: {},
        appIsActive: true, isDataReady: true, settings: { sessionNotificationHaptics: true }, markSessionRead: mocks.read,
    })) };
});

import { storage } from '@/sync/storage';
import { HumanInterventionNotificationContent } from './HumanInterventionNotifications';
import { AgentStateSchema } from '@/sync/storageTypes';
import { getSessionAttentionStatus } from '@/utils/sessionListStatus';

const session = (id = 'a', requestId = 'request-1', patch: Partial<Session> = {}): Session => ({
    id, active: true, presence: 'online', thinking: false, updatedAt: 1,
    metadata: { host: 'workstation' }, agentState: { humanIntervention: { id: requestId, kind: 'sudo', instructions: 'Use the local terminal', createdAt: 1 } }, ...patch,
} as Session);
let tree: ReturnType<typeof create>;
const update = (patch: Partial<ReturnType<typeof storage.getState>>) => act(() => storage.setState(patch));
const find = (id: string) => tree.root.findAllByType('Pressable').find((node: any) => node.props.testID === id);

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.clearAllMocks();
    vi.useFakeTimers();
    storage.setState({ sessions: {}, archivingSessionIds: new Set(), sessionAttention: {}, appIsActive: true });
    storage.setState(state => ({ settings: { ...state.settings, sessionNotificationHaptics: true } }));
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
    act(() => { tree = create(React.createElement(HumanInterventionNotificationContent)); });
});
afterEach(() => { act(() => tree.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('human intervention reminders', () => {
    it('opens immediately, names the computer, persists past normal banner timeouts and vibrates once', () => {
        update({ sessions: { a: session() } });
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
        expect(JSON.stringify(tree.toJSON())).toContain('workstation');
        expect(JSON.stringify(tree.toJSON())).toContain('Use the local terminal');
        act(() => vi.advanceTimersByTime(60_000));
        update({ sessions: { a: session() } });
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
        expect(mocks.haptic).toHaveBeenCalledExactlyOnceWith('warning');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('defers or opens the conversation without resolving, then reopens from the persistent reminder', () => {
        update({ sessions: { a: session() } });
        act(() => find('human-intervention-open')!.props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('a');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(find('human-intervention-reminder')).toBeDefined();
        act(() => find('human-intervention-reminder')!.props.onPress());
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
        act(() => find('human-intervention-later')!.props.onPress());
        expect(storage.getState().sessions.a.agentState?.humanIntervention).toBeTruthy();
    });

    it('offers only navigation and deferral, with no automatic continue or cancel action', () => {
        update({ sessions: { a: session() } });
        expect(find('human-intervention-resolve')).toBeUndefined();
        expect(find('human-intervention-cancel')).toBeUndefined();
        expect(tree.root.findAllByType('Pressable')).toHaveLength(2);
        expect(JSON.stringify(tree.toJSON())).toContain('humanIntervention.reply');
        act(() => tree.root.findByType('Modal').props.onRequestClose());
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(storage.getState().sessions.a.agentState?.humanIntervention?.id).toBe('request-1');
        expect(find('human-intervention-reminder')).toBeDefined();
    });

    it('removes the persistent reminder after a reply clears the pending request', () => {
        update({ sessions: { a: session() } });
        act(() => find('human-intervention-open')!.props.onPress());
        update({ sessions: { a: session('a', 'request-1', { agentState: { humanIntervention: null } }) } });
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
        expect(find('human-intervention-reminder')).toBeUndefined();
    });

    it('allows opening an offline conversation to draft a reply, waits for foreground, and ignores archived sessions', () => {
        update({ appIsActive: false, sessions: { a: session('a', 'request-1', { presence: 1 }) } });
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
        expect(mocks.haptic).not.toHaveBeenCalled();
        update({ appIsActive: true });
        expect(JSON.stringify(tree.toJSON())).toContain('humanIntervention.offline');
        expect(find('human-intervention-open')!.props.disabled).not.toBe(true);
        act(() => find('human-intervention-open')!.props.onPress());
        expect(mocks.navigate).toHaveBeenCalledWith('a');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        update({ archivingSessionIds: new Set(['a']) });
        expect(tree.root.findAllByType('Modal')).toHaveLength(0);
    });

    it('does not defer a newer request or mark it read when the previous reminder is closed', () => {
        update({ sessions: { a: session() }, sessionAttention: { a: { kind: 'intervention', eventId: 'intervention:1:1', at: 1, read: false, version: 0 } } });
        act(() => find('human-intervention-later')!.props.onPress());
        update({ sessions: { a: session('a', 'request-2') }, sessionAttention: { a: { kind: 'intervention', eventId: 'intervention:2:1', at: 2, read: false, version: 1 } } });
        expect(mocks.read).not.toHaveBeenCalled();
        expect(tree.root.findAllByType('Modal')).toHaveLength(1);
        expect(find('human-intervention-open')).toBeDefined();
    });

    it('parses persisted requests and never turns an old intervention notification into completion', () => {
        expect(AgentStateSchema.parse(session().agentState).humanIntervention?.id).toBe('request-1');
        expect(getSessionAttentionStatus('intervention_required', false, 'done')).toBe('intervention_required');
        expect(getSessionAttentionStatus('waiting', true, 'intervention')).toBeNull();
    });
});
