import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions, replace, alert, state } = vi.hoisted(() => ({
    machineRPC: vi.fn(), refreshSessions: vi.fn(), replace: vi.fn(), alert: vi.fn(),
    state: { metadata: { flavor: 'codex', machineId: 'machine-1' } as Record<string, string> },
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), ScrollView: host('ScrollView'),
        Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
        useWindowDimensions: () => ({ width: 900, height: 700 }),
    };
});
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { glass: {}, button: { primary: {} } } };
    return {
        StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory(theme) },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('./MobileGlass', async () => {
    const ReactModule = await import('react');
    return { MobileGlassSurface: (props: any) => ReactModule.createElement('Surface', props, props.children) };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ metadata: state.metadata }),
    storage: { getState: () => ({ sessions: {} }) },
}));
vi.mock('@/sync/apiSocket', () => ({ apiSocket: { machineRPC } }));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/modal', () => ({ Modal: { alert } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { ResumeNativeSessionSheet } from './ResumeNativeSessionSheet';

const renderers: ReturnType<typeof create>[] = [];
const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalConsoleError(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach((renderer) => renderer.unmount())));
beforeEach(() => {
    vi.clearAllMocks();
    state.metadata = { flavor: 'codex', machineId: 'machine-1' };
    refreshSessions.mockResolvedValue(undefined);
});

async function renderSheet() {
    let renderer: ReturnType<typeof create>;
    const onClose = vi.fn();
    await act(async () => { renderer = create(React.createElement(ResumeNativeSessionSheet, { sessionId: 'happy-source', onClose })); });
    renderers.push(renderer!);
    return { renderer: renderer!, onClose };
}

function confirmButton(renderer: ReturnType<typeof create>) {
    return renderer.root.findAllByType('Pressable').find((node: any) => (
        node.findAllByType('Text').some((text: any) => text.props.children === 'session.resumeSheetConfirm')
    ));
}

describe('native resume picker user flow', () => {
    it.each(['codex', 'claude'])('lists and resumes the selected native %s conversation', async (flavor) => {
        state.metadata.flavor = flavor;
        machineRPC.mockImplementation(async (_machineId: string, method: string) => (
            method === 'spawn-happy-session'
                ? { type: 'success', sessionId: 'happy-resumed' }
                : { type: 'success', sessions: [{ sessionId: 'native-1', cwd: '/native/repo', gitBranch: 'main', summary: 'Native conversation', firstUserMessage: 'hello', timestamp: Date.now() }] }
        ));
        const { renderer, onClose } = await renderSheet();
        expect(machineRPC).toHaveBeenCalledWith('machine-1', `${flavor}-list-native-sessions`, { directory: undefined });
        expect(confirmButton(renderer).props.disabled).toBe(true);
        const row = renderer.root.findAllByType('Pressable').find((node: any) => (
            node.findAllByType('Text').some((text: any) => text.props.children === 'Native conversation')
        ));
        await act(async () => { row.props.onPress(); });
        expect(confirmButton(renderer).props.disabled).toBe(false);
        await act(async () => { confirmButton(renderer).props.onPress(); });
        expect(machineRPC).toHaveBeenLastCalledWith('machine-1', 'spawn-happy-session', expect.objectContaining({
            agent: flavor,
            directory: '/native/repo',
            [flavor === 'codex' ? 'resumeCodexThreadId' : 'resumeClaudeSessionId']: 'native-1',
        }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(replace).toHaveBeenCalledWith('/session/happy-resumed');
    });

    it('displays daemon list errors and keeps confirmation disabled', async () => {
        machineRPC.mockResolvedValue({ error: 'Codex history unavailable' });
        const { renderer } = await renderSheet();
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Codex history unavailable')).toBe(true);
        expect(confirmButton(renderer).props.disabled).toBe(true);
        expect(replace).not.toHaveBeenCalled();
    });

    it('shows an empty-state message when there are no native Codex conversations', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessions: [] });
        const { renderer } = await renderSheet();
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'session.resumeSheetEmpty')).toBe(true);
        expect(confirmButton(renderer).props.disabled).toBe(true);
    });

    it('keeps the picker open and surfaces failed resume launches', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => (
            method === 'spawn-happy-session'
                ? { type: 'error', errorMessage: 'Thread no longer exists' }
                : { type: 'success', sessions: [{ sessionId: 'native-1', cwd: '/native/repo', summary: 'Native conversation', timestamp: Date.now() }] }
        ));
        const { renderer, onClose } = await renderSheet();
        await act(async () => { renderer.root.findAllByType('Pressable')[0].props.onPress(); });
        await act(async () => { confirmButton(renderer).props.onPress(); });
        expect(alert).toHaveBeenCalledWith('common.error', 'Thread no longer exists');
        expect(onClose).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
    });
});
