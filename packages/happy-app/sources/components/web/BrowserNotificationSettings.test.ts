import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ setEnabled: vi.fn(), requestPermission: vi.fn(), alert: vi.fn(), queryPermission: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/components/Item', () => ({ Item: (props: any) => React.createElement('Item', props, props.rightElement) }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: (props: any) => React.createElement('Group', props, props.children) }));
vi.mock('@/components/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('@/sync/storage', () => ({ useLocalSettingMutable: () => {
    const [value, setValue] = React.useState(false);
    return [value, (next: boolean) => { mocks.setEnabled(next); setValue(next); }];
} }));

import { BrowserNotificationSettings } from './BrowserNotificationSettings';

let tree: ReturnType<typeof create>;
let notification: { permission: NotificationPermission; requestPermission: typeof mocks.requestPermission };
let permissionStatus: EventTarget;
const control = () => tree.root.findByType('Switch');
const item = () => tree.root.findByType('Item');
function render() { act(() => { tree = create(React.createElement(BrowserNotificationSettings)); }); }

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { isSecureContext: true }));
    vi.stubGlobal('document', new EventTarget());
    notification = { permission: 'default', requestPermission: mocks.requestPermission };
    vi.stubGlobal('Notification', notification);
    permissionStatus = new EventTarget();
    mocks.queryPermission.mockReset().mockResolvedValue(permissionStatus);
    vi.stubGlobal('navigator', { permissions: { query: mocks.queryPermission } });
    mocks.alert.mockReset();
    mocks.setEnabled.mockReset();
    mocks.requestPermission.mockReset().mockImplementation(async () => {
        notification.permission = 'granted';
        return 'granted';
    });
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterEach(() => {
    if (tree) act(() => tree.unmount());
    tree = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('desktop notification settings', () => {
    it('replaces the disabled switch with clickable recovery instructions when blocked', () => {
        notification.permission = 'denied';
        render();
        expect(tree.root.findAllByType('Switch')).toHaveLength(0);
        expect(item().props.title).toBe('browserNotifications.manage');
        expect(item().props.onPress).toBeTypeOf('function');
        act(() => item().props.onPress());
        expect(mocks.alert).toHaveBeenCalledWith('browserNotifications.title', 'browserNotifications.instructions');
        expect(mocks.requestPermission).not.toHaveBeenCalled();
    });

    it('restores the switch when website permission changes without reloading or changing window focus', async () => {
        notification.permission = 'denied';
        await act(async () => render());
        notification.permission = 'granted';
        act(() => permissionStatus.dispatchEvent(new Event('change')));
        expect(control().props.disabled).toBe(false);
        await act(async () => control().props.onValueChange(true));
        expect(control().props.value).toBe(true);
        expect(mocks.requestPermission).not.toHaveBeenCalled();
    });

    it('requests permission synchronously from the user action and saves only a grant', async () => {
        render();
        expect(mocks.requestPermission).not.toHaveBeenCalled();
        await act(async () => {
            control().props.onValueChange(true);
            expect(mocks.requestPermission).toHaveBeenCalledOnce();
        });
        expect(mocks.setEnabled).toHaveBeenLastCalledWith(true);
        expect(control().props.value).toBe(true);
        await act(async () => control().props.onValueChange(false));
        expect(control().props.value).toBe(false);
        expect(mocks.requestPermission).toHaveBeenCalledOnce();
    });

    it('does not request permission again when the browser already granted it', async () => {
        notification.permission = 'granted';
        render();
        await act(async () => control().props.onValueChange(true));
        expect(control().props.value).toBe(true);
        expect(mocks.requestPermission).not.toHaveBeenCalled();
        notification.permission = 'denied';
        act(() => window.dispatchEvent(new Event('focus')));
        expect(tree.root.findAllByType('Switch')).toHaveLength(0);
        expect(item().props.subtitle).toBe('browserNotifications.blocked');
    });

    it('shows browser settings guidance after a denial without enabling notifications', async () => {
        mocks.requestPermission.mockImplementation(async () => { notification.permission = 'denied'; return 'denied'; });
        render();
        await act(async () => control().props.onValueChange(true));
        expect(tree.root.findAllByType('Switch')).toHaveLength(0);
        expect(item().props.onPress).toBeTypeOf('function');
        expect(item().props.subtitle).toBe('browserNotifications.blocked');
        expect(mocks.setEnabled).toHaveBeenLastCalledWith(false);
    });

    it.each(['insecure', 'unsupported'])('disables the control for %s environments', (reason) => {
        if (reason === 'insecure') Object.assign(window, { isSecureContext: false });
        else vi.stubGlobal('Notification', undefined);
        render();
        expect(control().props.disabled).toBe(true);
        expect(item().props.subtitle).toBe(`browserNotifications.${reason}`);
        expect(mocks.requestPermission).not.toHaveBeenCalled();
    });

    it('reports permission request failures and allows retrying', async () => {
        mocks.requestPermission.mockRejectedValue(new Error('request failed'));
        render();
        await act(async () => control().props.onValueChange(true));
        expect(control().props.value).toBe(false);
        expect(control().props.disabled).toBe(false);
        expect(item().props.subtitle).toBe('browserNotifications.error');
    });
});
