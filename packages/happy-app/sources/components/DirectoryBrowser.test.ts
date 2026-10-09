import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { listDirectory } = vi.hoisted(() => ({ listDirectory: vi.fn() }));
vi.mock('@/sync/ops', () => ({ machineListDirectory: listDirectory }));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'), ActivityIndicator: host('ActivityIndicator'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
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
        PickerSheetSection: (props: any) => ReactModule.createElement('Text', {}, props.title),
        PickerSheetOption: (props: any) => ReactModule.createElement('Pressable', {
            onPress: props.onPress, accessibilityLabel: props.label,
        }, ReactModule.createElement('Text', {}, props.label)),
    };
});

import { DirectoryBrowser } from './DirectoryBrowser';

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

async function renderBrowser(overrides: Partial<React.ComponentProps<typeof DirectoryBrowser>> = {}) {
    const props: React.ComponentProps<typeof DirectoryBrowser> = {
        machineId: 'machine-1', homeDir: '/work', initialPath: '/work/repo',
        recentPaths: [{ key: '/recent', name: 'Recent repo' }, { key: 'project:catalog', name: 'Catalog project' }],
        onSelectDirectory: vi.fn(), onSelectRecent: vi.fn(), onRequestCustomPath: vi.fn(), ...overrides,
    };
    let renderer: ReturnType<typeof create>;
    await act(async () => { renderer = create(React.createElement(DirectoryBrowser, props)); });
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
        const labels = renderer.root.findAllByType('Pressable').map((node: any) => node.props.accessibilityLabel);
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
