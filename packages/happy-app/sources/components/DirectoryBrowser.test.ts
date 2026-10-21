import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn() }));
vi.mock('@/sync/ops', () => ({ machineListDirectory: listDirectory }));
vi.mock('@/sync/persistence', () => ({ loadNewSessionDraft: () => null, saveNewSessionDraft: vi.fn() }));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), TextInput: host('TextInput'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { OS: 'web', select: (values: any) => values.web ?? values.default },
        Keyboard: { dismiss: vi.fn() },
    };
});
vi.mock('react-native-unistyles', () => {
    const theme = { colors: { text: '#000', textSecondary: '#666', surfacePressedOverlay: '#eee' } };
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./PickerSheet', async () => {
    const ReactModule = await import('react');
    return {
        PickerSheet: (props: any) => ReactModule.createElement('View', {},
            ReactModule.createElement('Pressable', { onPress: props.onClose, accessibilityLabel: 'dismiss-directory-picker' }),
            props.children),
        PickerSheetSection: (props: any) => ReactModule.createElement('Text', {}, props.title),
        PickerSheetOption: (props: any) => ReactModule.createElement('Pressable', {
            onPress: props.onPress, accessibilityLabel: props.label, testID: props.testID,
            selected: props.selected, description: props.description,
            disabled: props.disabled,
        }, ReactModule.createElement('Text', {}, props.label)),
    };
});

import { DirectoryBrowser } from './DirectoryBrowser';
import { DirectoryPicker } from './DirectoryPicker';
import { ProjectDirectoryPicker } from './ProjectDirectoryPicker';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import type { ProjectSearchOption } from '@/sync/recentProjects';

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
    listDirectory.mockReset();
    listDirectory.mockImplementation(async (_machine: string, path: string) => ({
        success: true,
        entries: path === '/work/repo'
            ? [{ name: 'z-dir', type: 'directory' }, { name: 'README.md', type: 'file' }, { name: 'a-dir', type: 'directory' }]
            : path === '/work'
                ? [{ name: 'repo', type: 'directory' }, { name: 'sibling', type: 'directory' }]
                : [],
    }));
});

async function renderBrowser(
    overrides: Partial<React.ComponentProps<typeof DirectoryBrowser>> = {},
    component = DirectoryBrowser,
) {
    const props: React.ComponentProps<typeof DirectoryBrowser> = {
        machineId: 'machine-1', homeDir: '/work', initialPath: '/work/repo',
        recentPaths: [{ key: '/recent', name: 'Recent repo' }, { key: 'project:catalog', name: 'Catalog project' }],
        onSelectDirectory: vi.fn(), onSelectRecent: vi.fn(), onRequestCustomPath: vi.fn(), ...overrides,
    };
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(component, props)); });
    renderers.push(renderer!);
    return { renderer: renderer!, props };
}

function button(renderer: ReturnType<typeof create>, label: string) {
    return renderer.root.findAllByType('Pressable').find((node: any) => node.props.accessibilityLabel === label);
}

async function press(renderer: ReturnType<typeof create>, label: string) {
    const target = button(renderer, label);
    expect(target, `Missing button: ${label}`).toBeDefined();
    await act(async () => target.props.onPress());
}

describe('directory browser selection flow', () => {
    it('loads current and parent directories, sorts folders and excludes files and the current sibling', async () => {
        const { renderer } = await renderBrowser();
        expect(listDirectory).toHaveBeenCalledWith('machine-1', '/work/repo');
        expect(listDirectory).toHaveBeenCalledWith('machine-1', '/work');
        expect(button(renderer, 'sibling')).toBeUndefined();
        await press(renderer, 'machineLauncher.parentDirectories');
        const labels = renderer.root.findAllByType('Pressable').map((node: any) => node.props.accessibilityLabel);
        expect(labels.indexOf('Recent repo')).toBeLessThan(labels.indexOf('a-dir'));
        expect(labels.indexOf('a-dir')).toBeLessThan(labels.indexOf('z-dir'));
        expect(labels).toContain('sibling');
        expect(labels).not.toContain('repo');
        expect(labels).not.toContain('README.md');
    });

    it('enters a child without changing the draft, then confirms the browsed directory', async () => {
        const { renderer, props } = await renderBrowser();
        await press(renderer, 'a-dir');
        expect(listDirectory).toHaveBeenCalledWith('machine-1', '/work/repo/a-dir');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo/a-dir');
    });

    it('opens a sibling directly and navigates upward', async () => {
        const { renderer, props } = await renderBrowser();
        await press(renderer, 'machineLauncher.parentDirectories');
        await press(renderer, 'sibling');
        expect(listDirectory).toHaveBeenCalledWith('machine-1', '/work/sibling');
        await press(renderer, 'machineLauncher.parentDirectory');
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work');
    });

    it('does not navigate above the root and allows choosing an empty directory', async () => {
        const { renderer, props } = await renderBrowser({ initialPath: '/' });
        expect(button(renderer, 'machineLauncher.parentDirectory')).toBeUndefined();
        expect(listDirectory).toHaveBeenCalledExactlyOnceWith('machine-1', '/');
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/');
    });

    it('preserves path and catalog project selections and the manual input fallback when browsing is unavailable', async () => {
        const { renderer, props } = await renderBrowser({ machineId: null });
        expect(listDirectory).not.toHaveBeenCalled();
        await press(renderer, 'Recent repo');
        expect(props.onSelectRecent).toHaveBeenCalledWith('/recent');
        await press(renderer, 'Catalog project');
        expect(props.onSelectRecent).toHaveBeenCalledWith('project:catalog');
        await press(renderer, 'machineLauncher.enterCustomPath');
        expect(props.onRequestCustomPath).toHaveBeenCalledOnce();
    });

    it('shows a read failure and retries without committing an invalid directory', async () => {
        listDirectory.mockResolvedValueOnce({ success: false, error: 'Permission denied' });
        const { renderer } = await renderBrowser();
        expect(button(renderer, 'machineLauncher.selectDirectory').props.disabled).toBe(true);
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Permission denied')).toBe(true);
        const retry = renderer.root.findAllByType('Pressable').find((node: any) => !node.props.accessibilityLabel);
        await act(async () => retry.props.onPress());
        expect(button(renderer, 'machineLauncher.selectDirectory').props.disabled).toBe(false);
        expect(button(renderer, 'a-dir')).toBeDefined();
    });

    it('discards a late current-directory reply after navigating to its parent', async () => {
        let resolveOld: (response: any) => void = () => {};
        listDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
        const { renderer, props } = await renderBrowser();
        expect(button(renderer, 'machineLauncher.selectDirectory').props.disabled).toBe(true);
        await press(renderer, 'machineLauncher.parentDirectory');
        await act(async () => resolveOld({ success: true, entries: [{ name: 'stale-child', type: 'directory' }] }));
        expect(button(renderer, 'stale-child')).toBeUndefined();
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work');
    });

    it('discards an old machine reply when the computer changes', async () => {
        let resolveOld: (response: any) => void = () => {};
        listDirectory.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
        const { renderer, props } = await renderBrowser();
        await act(async () => renderer.update(React.createElement(DirectoryBrowser, { ...props, machineId: 'machine-2', initialPath: '/other' })));
        await act(async () => resolveOld({ success: true, entries: [{ name: 'wrong-computer', type: 'directory' }] }));
        expect(listDirectory).toHaveBeenCalledWith('machine-2', '/other');
        expect(button(renderer, 'wrong-computer')).toBeUndefined();
    });

    it('waits for a known remote home instead of using the daemon working directory', async () => {
        const { renderer, props } = await renderBrowser({ initialPath: '~', homeDir: undefined });
        expect(listDirectory).not.toHaveBeenCalled();
        await act(async () => renderer.update(React.createElement(DirectoryBrowser, { ...props, homeDir: '/work' })));
        expect(listDirectory).toHaveBeenCalledWith('machine-1', '/work');
    });
});

async function search(renderer: ReturnType<typeof create>, query: string) {
    await act(async () => renderer.root.findByType('TextInput').props.onChangeText(query));
}

describe('directory browser search', () => {
    it('searches names and paths locally without changing the draft or requesting more directories', async () => {
        const { renderer, props } = await renderBrowser();
        const calls = listDirectory.mock.calls.length;
        await search(renderer, '/work/repo/A-');
        expect(button(renderer, 'a-dir')).toBeDefined();
        expect(button(renderer, 'z-dir')).toBeUndefined();
        expect(button(renderer, 'Recent repo')).toBeUndefined();
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        expect(props.onSelectRecent).not.toHaveBeenCalled();
        expect(listDirectory).toHaveBeenCalledTimes(calls);
        await press(renderer, 'a-dir');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo/a-dir');
    });

    it('finds a collapsed sibling and selects its actual path in one click', async () => {
        const { renderer, props } = await renderBrowser();
        await search(renderer, 'sibling');
        await press(renderer, 'sibling');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/sibling');
    });

    it('keeps recent and catalog projects searchable when browsing is unavailable', async () => {
        const { renderer, props } = await renderBrowser({ machineId: null });
        await search(renderer, 'catalog');
        expect(button(renderer, 'Recent repo')).toBeUndefined();
        await press(renderer, 'Catalog project');
        expect(props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('project:catalog');
        expect(listDirectory).not.toHaveBeenCalled();
        expect(button(renderer, 'machineLauncher.enterCustomPath')).toBeDefined();
    });

    it('shows no matches and clears the query without changing the selected directory', async () => {
        const { renderer, props } = await renderBrowser();
        await search(renderer, 'nonexistent-project');
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'machineLauncher.noMatchingDirectories')).toBe(true);
        await press(renderer, 'machineLauncher.clearDirectorySearch');
        expect(renderer.root.findByType('TextInput').props.value).toBe('');
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo');
    });

    it('deduplicates a recent path that is also in the directory listing', async () => {
        const { renderer, props } = await renderBrowser({ recentPaths: [{ key: '/work/repo/a-dir', name: 'My directory' }] });
        await search(renderer, 'a-dir');
        expect(button(renderer, 'My directory')).toBeDefined();
        expect(button(renderer, 'a-dir')).toBeUndefined();
        await press(renderer, 'My directory');
        expect(props.onSelectRecent).toHaveBeenCalledExactlyOnceWith('/work/repo/a-dir');
    });

    it('clears search on a machine change and retains loading errors while searching', async () => {
        listDirectory.mockResolvedValueOnce({ success: false, error: 'Permission denied' });
        const { renderer, props } = await renderBrowser();
        await search(renderer, 'catalog');
        expect(renderer.root.findAllByType('Text').some((node: any) => node.props.children === 'Permission denied')).toBe(true);
        await act(async () => renderer.update(React.createElement(DirectoryBrowser, { ...props, machineId: 'machine-2', initialPath: '/other' })));
        expect(renderer.root.findByType('TextInput').props.value).toBe('');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
    });
});

describe('iOS cross-machine project selection', () => {
    const projects: ProjectSearchOption[] = [
        { key: 'linux-happy', machineId: 'linux', machineName: 'Linux', online: true, path: '/code/happy', name: 'happy', lastUsedAt: 3, description: '/code/happy Linux' },
        { key: 'windows-happy', machineId: 'windows', machineName: 'Windows', online: true, path: 'D:\\code\\happy', name: 'happy', lastUsedAt: 2, description: 'D:\\code\\happy Windows' },
        { key: 'offline-happy', machineId: 'offline', machineName: 'Offline', online: false, path: '/code/happy', name: 'happy', lastUsedAt: 1, description: '/code/happy Offline' },
        { key: 'catalog', machineId: 'linux', machineName: 'Linux', online: true, path: null, projectId: 'catalog', name: 'Catalog project', lastUsedAt: 0, description: 'Linux' },
    ];
    const projectRows = (renderer: ReturnType<typeof create>) => renderer.root.findAllByType('Pressable')
        .filter((node: any) => node.props.testID === 'directory-project-result');
    const select = vi.fn((project: ProjectSearchOption) => useNewSessionDraft.getState().selectPlace(project));
    const projectSearch = { options: projects, machineId: 'linux', onSelect: select };

    beforeEach(() => {
        select.mockClear();
        const draft = useNewSessionDraft.getState();
        draft.selectPlace({ machineId: 'linux', path: '/code/happy' });
        draft.setInput('keep my task');
        draft.setWorktreeKey('/old/worktree');
    });

    it('searches every computer locally and selects its machine and actual path together', async () => {
        const { renderer } = await renderBrowser({ projectSearch, selectedKey: '/code/happy' });
        const reads = listDirectory.mock.calls.length;
        await search(renderer, 'happy');
        expect(projectRows(renderer)).toHaveLength(3);
        expect(projectRows(renderer).map((row: any) => row.props.selected)).toEqual([true, false, false]);
        expect(projectRows(renderer)[1].props.description).toContain('Windows');
        expect(listDirectory).toHaveBeenCalledTimes(reads);
        expect(select).not.toHaveBeenCalled();
        await act(async () => projectRows(renderer)[1].props.onPress());
        expect(useNewSessionDraft.getState()).toMatchObject({
            selectedMachineId: 'windows', selectedPath: 'D:\\code\\happy', input: 'keep my task', worktreeKey: null,
        });
    });

    it('keeps offline projects selectable while the currently selected computer cannot browse', async () => {
        const { renderer } = await renderBrowser({ machineId: null, projectSearch });
        await search(renderer, 'Offline');
        expect(projectRows(renderer)).toHaveLength(1);
        expect(projectRows(renderer)[0].props.description).toContain('status.offline');
        await act(async () => projectRows(renderer)[0].props.onPress());
        expect(useNewSessionDraft.getState().selectedMachineId).toBe('offline');
        expect(listDirectory).not.toHaveBeenCalled();
    });

    it('selects a catalog project by identity without inventing a directory or consuming the task', async () => {
        const { renderer } = await renderBrowser({ machineId: null, projectSearch, selectedKey: null });
        await search(renderer, 'Catalog');
        expect(projectRows(renderer)[0].props.selected).toBe(false);
        await act(async () => projectRows(renderer)[0].props.onPress());
        expect(useNewSessionDraft.getState()).toMatchObject({
            selectedProjectId: 'catalog', selectedPath: null, selectedMachineId: 'linux', agentType: 'rig', input: 'keep my task',
        });
    });

    it('deduplicates a saved project against the current directory listing while retaining another computer’s copy', async () => {
        const matching = projects.slice(0, 2).map((project) => ({ ...project, path: '/work/repo/a-dir', name: 'a-dir', description: '/work/repo/a-dir' }));
        const { renderer } = await renderBrowser({ projectSearch: { ...projectSearch, options: matching } });
        await search(renderer, 'a-dir');
        expect(projectRows(renderer)).toHaveLength(2);
        expect(renderer.root.findAllByType('Pressable').filter((node: any) => node.props.accessibilityLabel === 'a-dir')).toHaveLength(2);
    });
});

describe('iOS project picker manual entry', () => {
    async function renderProjectPicker() {
        const props = { visible: true, machineId: null, initialPath: '/work/repo', recentPaths: [],
            onClose: vi.fn(), onSelectDirectory: vi.fn(), onSelectRecent: vi.fn() };
        let renderer!: ReturnType<typeof create>;
        await act(async () => { renderer = create(React.createElement(ProjectDirectoryPicker, props)); });
        renderers.push(renderer);
        return { renderer, props };
    }

    it('keeps a custom path local until confirmed and cancels without changing the draft', async () => {
        const { renderer, props } = await renderProjectPicker();
        await press(renderer, 'machineLauncher.enterCustomPath');
        await search(renderer, '/not-applied');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        await press(renderer, 'dismiss-directory-picker');
        expect(props.onClose).toHaveBeenCalledOnce();
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
    });

    it('rejects an empty custom path and applies a confirmed path in the same modal', async () => {
        const { renderer, props } = await renderProjectPicker();
        await press(renderer, 'machineLauncher.enterCustomPath');
        await search(renderer, '   ');
        expect(button(renderer, 'machineLauncher.selectDirectory').props.disabled).toBe(true);
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        await search(renderer, ' /chosen/path ');
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/chosen/path');
        expect(props.onClose).toHaveBeenCalledOnce();
    });
});

describe('web directory picker', () => {
    it('loads only after opening and applies the browsed directory on confirmation', async () => {
        const { renderer, props } = await renderBrowser({}, DirectoryPicker);
        expect(listDirectory).not.toHaveBeenCalled();
        await press(renderer, 'machineLauncher.directoryPickerTitle');
        await press(renderer, 'a-dir');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo/a-dir');
        expect(button(renderer, 'dismiss-directory-picker')).toBeUndefined();
    });

    it('cancels navigation without changing the selection and reopens at the original path', async () => {
        const { renderer, props } = await renderBrowser({}, DirectoryPicker);
        await press(renderer, 'machineLauncher.directoryPickerTitle');
        await press(renderer, 'a-dir');
        await press(renderer, 'dismiss-directory-picker');
        expect(props.onSelectDirectory).not.toHaveBeenCalled();
        expect(props.onSelectRecent).not.toHaveBeenCalled();
        await press(renderer, 'machineLauncher.directoryPickerTitle');
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/work/repo');
    });

    it('keeps recent paths, catalog projects and manual input available without an online daemon', async () => {
        const { renderer, props } = await renderBrowser({ machineId: null }, DirectoryPicker);
        for (const [label, key] of [['Recent repo', '/recent'], ['Catalog project', 'project:catalog']]) {
            await press(renderer, 'machineLauncher.directoryPickerTitle');
            await press(renderer, label);
            expect(props.onSelectRecent).toHaveBeenLastCalledWith(key);
            expect(button(renderer, 'dismiss-directory-picker')).toBeUndefined();
        }
        await press(renderer, 'machineLauncher.directoryPickerTitle');
        await press(renderer, 'machineLauncher.enterCustomPath');
        expect(props.onRequestCustomPath).toHaveBeenCalledOnce();
        expect(button(renderer, 'dismiss-directory-picker')).toBeUndefined();
        expect(listDirectory).not.toHaveBeenCalled();
    });

    it('resets navigation when the selected computer changes while open', async () => {
        const { renderer, props } = await renderBrowser({}, DirectoryPicker);
        await press(renderer, 'machineLauncher.directoryPickerTitle');
        await press(renderer, 'a-dir');
        await act(async () => renderer.update(React.createElement(DirectoryPicker, {
            ...props, machineId: 'machine-2', homeDir: '/other', initialPath: null,
        })));
        await press(renderer, 'machineLauncher.selectDirectory');
        expect(listDirectory).toHaveBeenCalledWith('machine-2', '/other');
        expect(props.onSelectDirectory).toHaveBeenCalledExactlyOnceWith('/other');
    });
});
