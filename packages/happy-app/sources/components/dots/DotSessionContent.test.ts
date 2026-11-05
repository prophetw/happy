import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), visibility: vi.fn() }));
vi.mock('react-native', async () => {
    const module = await import('react'), host = (name: string) => (props: any) => module.createElement(name, props, props.children);
    return Object.fromEntries(['View', 'Text', 'Pressable', 'ActivityIndicator', 'ScrollView', 'Modal', 'TextInput'].map(name => [name, host(name)]));
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#eee', divider: '#ccc' } } }) }));
vi.mock('@react-navigation/native', async () => {
    const module = await import('react'); return { useFocusEffect: (callback: () => void) => module.useEffect(callback, [callback]) };
});
vi.mock('@/hooks/useNavigateToSession', () => ({ useNavigateToSession: () => mocks.navigate }));
vi.mock('@/hooks/useSessionVisibility', () => ({ useSessionVisibility: mocks.visibility }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) }, useRealtimeStatus: () => 'connected' }));
vi.mock('@/sync/sync', () => ({ sync: { ensureSessionReady: vi.fn() } }));
vi.mock('./DotsConnectionsPanel', () => ({ DotsConnectionsPanel: () => null }));
vi.mock('./DotObservationPanel', async () => {
    const module = await import('react'); return { DotObservationPanel: (props: any) => module.createElement('ObservationPanel', props) };
});
vi.mock('./useDotsWorkspace', () => ({ useDotsWorkspace: () => ({ ready: true, pending: null, error: null, retry: vi.fn(),
    projection: { snapshot: { dots: [{ id: 'dot-id', sessionId: 'dot-session' }] }, details: { 'dot-id': { asOf: '2026-11-05T00:00:00Z',
        data: { dotId: 'dot-id', taskTotal: 0, tasks: [], memory: { access: ['read', 'write', 'forget'], total: 0, items: [], omittedCount: 0 } } } } },
}) }));
import { DotSessionContent } from './DotSessionContent';
beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
it('keeps the real composer mounted through observer tabs and routes memory editing into that conversation', async () => {
    let mounts = 0; const requests: unknown[] = [];
    function Composer({ request }: { request: unknown }) {
        React.useEffect(() => { mounts++; }, []);
        const [draft, setDraft] = React.useState('原有草稿');
        React.useEffect(() => { if (request) requests.push(request); }, [request]);
        return React.createElement('Composer', { draft, setDraft });
    }
    let renderer!: ReturnType<typeof create>;
    const props = { session: { id: 'dot-session', presence: 'online' } as any, active: true,
        metadata: { schemaVersion: 1 as const, kind: 'dot' as const, workspaceId: 'workspace-id', workspaceSessionId: 'workspace-session', dotId: 'dot-id' },
        children: (request: unknown) => React.createElement(Composer, { request }) };
    await act(async () => { renderer = create(React.createElement(DotSessionContent, props)); });
    const tabs = () => renderer.root.findAllByType('Pressable').filter((node: any) => node.props.accessibilityRole === 'tab');
    const switchTo = async (title: string) => act(async () => tabs().find((node: any) => node.findByType('Text').props.children === title).props.onPress());
    await switchTo('记忆');
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    const panel = renderer.root.findByType('ObservationPanel'); expect(panel.props.mode).toBe('memory'); expect(panel.props.active).toBe(true);
    await act(async () => panel.props.onEditMemory('偏好', { revision: 2, value: '新偏好', kind: 'preference', expiresAt: null }));
    const confirm = renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === '带入对话并确认');
    await act(async () => confirm.props.onPress());
    expect(requests).toHaveLength(1); expect(JSON.stringify(requests)).toContain('新偏好');
    expect(renderer.root.findByType('Composer').props.draft).toBe('原有草稿'); expect(mounts).toBe(1);
    await switchTo('本轮依据'); expect(renderer.root.findByType('ObservationPanel').props.mode).toBe('basis');
    await act(async () => renderer.unmount());
});
