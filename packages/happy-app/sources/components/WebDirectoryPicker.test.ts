import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { listDirectory, viewport } = vi.hoisted(() => ({
    listDirectory: vi.fn(), viewport: { width: 1200, height: 800 },
}));
vi.mock('@/sync/ops', () => ({ machineListDirectory: listDirectory }));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'),
        ScrollView: host('ScrollView'), Modal: host('Modal'), ActivityIndicator: host('ActivityIndicator'),
        useWindowDimensions: () => viewport,
    };
});
vi.mock('react-native-unistyles', () => {
    const theme = { colors: {
        text: '#000', textSecondary: '#666', textLink: '#08f', surface: '#fff', surfaceHigh: '#eee',
        surfacePressed: '#eee', surfaceSelected: '#ddd', divider: '#ccc', input: { background: '#eee' }, radio: { active: '#08f' },
    } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { WebDirectoryPicker } from './WebDirectoryPicker';
import { DirectoryPicker } from './DirectoryPicker.web';

const renderers: ReturnType<typeof create>[] = [];
beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const originalError = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalError(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach((renderer) => renderer.unmount())));
beforeEach(() => {
    viewport.width = 1200;
    listDirectory.mockReset();
    listDirectory.mockImplementation(async (_machine: string, path: string) => ({
        success: true,
        entries: path === '/work/repo'
            ? [{ name: 'z-dir', type: 'directory' }, { name: 'a-dir', type: 'directory' }, { name: 'file.txt', type: 'file' }]
            : path === '/work' ? [{ name: 'repo', type: 'directory' }, { name: 'sibling', type: 'directory' }] : [],
    }));
});

async function render(overrides: Partial<React.ComponentProps<typeof WebDirectoryPicker>> = {}, wrapper = false) {
    const props: React.ComponentProps<typeof WebDirectoryPicker> = {
        machineId: 'machine-1', machineName: 'Windows PC', homeDir: '/work', initialPath: '/work/repo',
        recentPaths: [{ key: '/recent', name: 'Recent repo' }, { key: 'project:catalog', name: 'Catalog project' }],
        onSelectDirectory: vi.fn(), onSelectRecent: vi.fn(), onRequestCustomPath: vi.fn(), onClose: vi.fn(), ...overrides,
    };
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(wrapper ? DirectoryPicker : WebDirectoryPicker, props)); });
    renderers.push(renderer);
    const hosts = (type: string) => renderer.root.findAllByType(type);
    const testId = (id: string) => hosts(id === 'directory-search' || id === 'directory-path-input' ? 'TextInput'
        : id === 'directory-pending-path' ? 'Text' : id === 'web-directory-dialog' ? 'View' : 'Pressable')
        .find((node: any) => node.props.testID === id);
    const press = async (label: string) => {
        const button = hosts('Pressable').find((node: any) => node.props.accessibilityLabel === label);
        expect(button, `Missing button ${label}`).toBeDefined();
        await act(async () => button.props.onPress());
    };
    const confirm = async () => act(async () => testId('confirm-directory').props.onPress());
    const typeSearch = async (value: string) => act(async () => testId('directory-search').props.onChangeText(value));
    const enterPath = async (value: string) => {
        await press('machineLauncher.enterCustomPath');
        await act(async () => testId('directory-path-input').props.onChangeText(value));
        await act(async () => testId('directory-path-input').props.onSubmitEditing());
    };
    const key = async (value: string, overrides: Record<string, unknown> = {}) => {
        const event = {
            key: value, ctrlKey: false, metaKey: false, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(),
            target: { getAttribute: () => 'directory-search', closest: () => null }, ...overrides,
        };
        await act(async () => testId('web-directory-dialog').props.onKeyDownCapture(event));
        return event;
    };
    const texts = () => hosts('Text').map((node: any) => node.props.children);
    return { props, renderer, hosts, testId, press, confirm, typeSearch, enterPath, key, texts };
}

describe('Web directory dialog', () => {
    it('browses folders without committing and confirms the exact path shown in the footer', async () => {
        const view = await render();
        const names = view.hosts('Pressable').map((node: any) => node.props.accessibilityLabel);
        expect(names.indexOf('a-dir')).toBeLessThan(names.indexOf('z-dir'));
        expect(names).not.toContain('file.txt');
        await view.press('a-dir');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo/a-dir');
        expect(view.texts()).toContain('directoryPicker.emptyHint');
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo/a-dir');
    });

    it('uses the same preview and confirmation for recent projects and search results', async () => {
        const view = await render();
        await view.press('Recent repo');
        expect(view.props.onSelectRecent).not.toHaveBeenCalled();
        expect(view.testId('directory-pending-path').props.children).toBe('/recent');
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('/recent');
        await view.enterPath('/work/repo');
        await view.typeSearch('sibling');
        await view.key('Enter');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        expect(view.testId('directory-pending-path').props.children).toBe('/work/sibling');
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/sibling');
    });

    it('keeps catalog project identity without inventing or reading a directory', async () => {
        const view = await render({ machineId: null });
        await view.press('Catalog project');
        expect(view.props.onSelectRecent).not.toHaveBeenCalled();
        expect(listDirectory).not.toHaveBeenCalled();
        expect(view.texts()).toContain('directoryPicker.catalogHint');
        expect(view.testId('directory-pending-path').props.children).toBe('Catalog project');
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('project:catalog');
    });

    it('opens an already selected catalog project without browsing the home directory', async () => {
        const view = await render({ selectedKey: 'project:catalog', initialPath: null });
        expect(listDirectory).not.toHaveBeenCalled();
        expect(view.texts()).toContain('directoryPicker.catalogHint');
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('project:catalog');
    });

    it('preserves an existing catalog identity even before its recent-project row is available', async () => {
        const view = await render({ selectedKey: 'project:waiting', initialPath: null, recentPaths: [] });
        expect(listDirectory).not.toHaveBeenCalled();
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('project:waiting');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
    });

    it('preserves manual Windows paths and recent choices while the daemon is offline', async () => {
        const view = await render({ machineId: null });
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.press('Recent repo');
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledWith('/recent');
        await view.enterPath('  D:/code/wifi-debug/  ');
        expect(view.props.onRequestCustomPath).not.toHaveBeenCalled();
        expect(view.testId('directory-pending-path').props.children).toBe('D:\\code\\wifi-debug');
        expect(view.texts()).toContain('directoryPicker.manualHint');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('D:\\code\\wifi-debug');
        expect(listDirectory).not.toHaveBeenCalled();
    });

    it('rejects relative manual paths without silently choosing home or confirming an older selection', async () => {
        const view = await render();
        await view.enterPath('wrong/relative/path');
        expect(view.texts()).toContain('directoryPicker.invalidPath');
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.key('Enter', { ctrlKey: true });
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo');
        await act(async () => view.testId('directory-path-input').props.onChangeText('~/new-project'));
        await act(async () => view.testId('directory-path-input').props.onSubmitEditing());
        expect(view.testId('directory-pending-path').props.children).toBe('/work/new-project');
    });

    it('can leave an invalid path edit by previewing a recent project', async () => {
        const view = await render();
        await view.enterPath('relative/path');
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.press('Recent repo');
        expect(view.testId('directory-path-input')).toBeUndefined();
        expect(view.testId('confirm-directory').props.disabled).toBe(false);
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('/recent');
    });

    it('shows read errors, disables unverified browsing and allows a retry', async () => {
        listDirectory.mockResolvedValueOnce({ success: false, error: 'Permission denied' });
        const view = await render();
        expect(view.texts()).toContain('Permission denied');
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.confirm();
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        await view.press('common.retry');
        expect(view.testId('confirm-directory').props.disabled).toBe(false);
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledWith('/work/repo');
    });

    it('ignores late replies after navigating with a breadcrumb', async () => {
        let resolveOld!: (value: unknown) => void;
        listDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
        const view = await render();
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.press('/work');
        await act(async () => resolveOld({ success: true, entries: [{ name: 'stale', type: 'directory' }] }));
        expect(view.texts()).not.toContain('stale');
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work');
    });

    it('supports arrow navigation, Enter to browse and Ctrl/Cmd+Enter to confirm', async () => {
        const view = await render();
        await view.key('ArrowDown');
        await view.key('ArrowDown');
        await view.key('Enter');
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo/z-dir');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        await view.key('Enter', { metaKey: true });
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo/z-dir');
    });

    it('does not treat IME confirmation or Enter on other controls as a directory choice', async () => {
        const view = await render();
        const requests = listDirectory.mock.calls.length;
        await view.key('Enter', { nativeEvent: { isComposing: true } });
        await view.key('Enter', { ctrlKey: true, nativeEvent: { keyCode: 229 } });
        await view.key('Enter', { target: { getAttribute: () => null, closest: () => null } });
        expect(listDirectory).toHaveBeenCalledTimes(requests);
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
    });

    it('searches known candidates without new requests and retains the path when there are no results', async () => {
        const view = await render();
        const requests = listDirectory.mock.calls.length;
        await view.typeSearch('unknown-zzzzzz');
        expect(view.texts()).toContain('machineLauncher.noMatchingDirectories');
        expect(view.texts()).toContain('directoryPicker.searchEmptyHint');
        expect(listDirectory).toHaveBeenCalledTimes(requests);
        await view.key('Enter');
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo');
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
    });

    it('switches between recent projects and browsing on narrow screens', async () => {
        viewport.width = 390;
        const view = await render();
        expect(view.texts()).not.toContain('Recent repo');
        await view.press('machineLauncher.recentDirectories');
        await view.press('Recent repo');
        expect(view.testId('directory-pending-path').props.children).toBe('/recent');
        expect(view.props.onSelectRecent).not.toHaveBeenCalled();
        await view.confirm();
        expect(view.props.onSelectRecent).toHaveBeenCalledWith('/recent');
    });

    it('resets pending selection and search when the selected machine changes', async () => {
        const view = await render();
        await view.press('a-dir');
        await view.typeSearch('repo');
        await act(async () => view.renderer.update(React.createElement(WebDirectoryPicker, {
            ...view.props, machineId: 'machine-2', initialPath: '/other',
        })));
        expect(view.testId('directory-search').props.value).toBe('');
        expect(view.testId('directory-pending-path').props.children).toBe('/other');
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/other');
    });

    it('discards a manual draft when switching between offline machines with the same home path', async () => {
        const view = await render({ machineId: null, machineKey: 'offline-1' });
        await view.enterPath('/wrong-machine');
        await act(async () => view.renderer.update(React.createElement(WebDirectoryPicker, {
            ...view.props, machineKey: 'offline-2',
        })));
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo');
        expect(view.testId('confirm-directory').props.disabled).toBe(true);
        await view.confirm();
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        expect(listDirectory).not.toHaveBeenCalled();
    });
});

describe('Web directory picker entry', () => {
    it('loads only while open, closes on confirmation and discards pending navigation on cancellation', async () => {
        const view = await render({}, true);
        expect(listDirectory).not.toHaveBeenCalled();
        await view.press('machineLauncher.directoryPickerTitle');
        await view.press('a-dir');
        await act(async () => view.testId('close-directory-picker').props.onPress());
        expect(view.props.onSelectDirectory).not.toHaveBeenCalled();
        expect(view.props.onSelectRecent).not.toHaveBeenCalled();
        expect(view.hosts('Modal')).toHaveLength(0);
        await view.press('machineLauncher.directoryPickerTitle');
        expect(view.testId('directory-pending-path').props.children).toBe('/work/repo');
        await view.confirm();
        expect(view.props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo');
        expect(view.hosts('Modal')).toHaveLength(0);
    });

    it('dismisses through the modal Escape handler without applying the pending selection', async () => {
        const view = await render({}, true);
        await view.press('machineLauncher.directoryPickerTitle');
        await view.press('Recent repo');
        await act(async () => view.hosts('Modal')[0].props.onRequestClose());
        expect(view.props.onSelectRecent).not.toHaveBeenCalled();
        expect(view.hosts('Modal')).toHaveLength(0);
    });
});
