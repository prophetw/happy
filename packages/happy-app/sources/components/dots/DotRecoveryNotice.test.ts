import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('react-native', async () => {
    const module = await import('react'); return Object.fromEntries(['View','Text','Pressable','ActivityIndicator'].map(name => [name, (props: any) => module.createElement(name, props, props.children)]));
});
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/sync/dotRecovery', () => ({ recoverDot: mocks.recover }));
import { DotRecoveryNotice } from './DotRecoveryNotice';
const props = { workspaceId: 'workspace', dotId: 'dot', sessionId: 'session', online: false };
let renderer: ReturnType<typeof create>;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; mocks.recover.mockReset(); vi.useFakeTimers();
    const original = console.error; vi.spyOn(console, 'error').mockImplementation((message, ...args) => { if (!String(message).startsWith('react-test-renderer is deprecated')) original(message, ...args); }); });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });
const button = () => renderer.root.findByType('Pressable');
it('starts once, waits for real presence, and preserves the original binding', async () => {
    mocks.recover.mockResolvedValue(undefined);
    await act(async () => { renderer = create(React.createElement(DotRecoveryNotice, props)); });
    await act(async () => { button().props.onPress(); button().props.onPress(); });
    expect(mocks.recover).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', dotId: 'dot', sessionId: 'session' });
    expect(button().props.disabled).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('等待 Dot 上线');
    await act(async () => renderer.update(React.createElement(DotRecoveryNotice, { ...props, online: true })));
    expect(renderer.toJSON()).toBeNull();
});
it('shows request errors and permits retry; a timeout never claims success', async () => {
    mocks.recover.mockRejectedValueOnce(new Error('宿主未能启动'));
    await act(async () => { renderer = create(React.createElement(DotRecoveryNotice, props)); });
    await act(async () => button().props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('宿主未能启动'); expect(button().props.disabled).toBe(false);
    mocks.recover.mockResolvedValue(undefined); await act(async () => button().props.onPress());
    await act(async () => vi.advanceTimersByTime(45000));
    expect(JSON.stringify(renderer.toJSON())).toContain('尚未上线'); expect(button().props.disabled).toBe(false);
});
