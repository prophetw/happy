import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DotMemoryHint } from '@/utils/dotMemoryTool';

const mocks = vi.hoisted(() => {
    const strings: Record<string, string | ((params: any) => string)> = {
        'dots.memoryHint.recallFound': ({ count }: { count: number }) => `检索到 ${count} 条相关记忆`,
        'dots.memoryHint.recallEmpty': '查找了记忆 · 未找到匹配',
        'dots.memoryHint.recallRunning': '正在检索记忆…',
        'dots.memoryHint.recallFailed': '记忆检索失败',
        'dots.memoryHint.recallUnreadable': '记忆检索结果无法解析',
        'dots.memoryHint.writeSaved': '已保存到记忆',
        'dots.memoryHint.writeForgotten': '已在当前记忆中忘记',
        'dots.memoryHint.writeRunning': '正在保存记忆…',
        'dots.memoryHint.writeFailed': '记忆保存失败',
        'dots.memoryHint.writeUnreadable': '记忆保存结果无法解析',
        'dots.memoryHint.writePending': '记忆操作已返回，状态待核对',
        'dots.memoryHint.confirmRunning': '正在确认记忆…',
        'dots.memoryHint.confirmFailed': '确认记忆失败',
        'dots.memoryHint.confirmUnreadable': '确认记忆结果无法解析',
        'dots.memoryHint.proposePending': '记忆变更待确认',
        'dots.memoryHint.proposeRunning': '正在准备记忆提案…',
        'dots.memoryHint.proposeFailed': '记忆提案失败',
        'dots.memoryHint.proposeUnreadable': '记忆提案结果无法解析',
        'dots.memoryHint.proposeReturned': '记忆提案已返回，状态待核对',
        'dots.memoryHint.expand': '展开详情',
        'dots.memoryHint.collapse': '收起详情',
        'dots.memoryHint.viewMemory': '查看这条记忆',
        'dots.memoryHint.viewRecallItem': ({ key }: { key: string }) => `查看召回记忆：${key}`,
        'dots.memoryHint.sourceValue': ({ source }: { source: string }) => `来源：${source}`,
        'dots.memoryHint.scopeValue': ({ scope }: { scope: string }) => `范围：${scope}`,
        'dots.memoryHint.scopeDot': 'Dot 级',
        'dots.memoryHint.scopeUser': '用户级',
    };
    return {
        strings,
        t: (key: string, params?: any) => {
            const value = strings[key];
            return typeof value === 'function' ? value(params ?? {}) : value ?? key;
        },
    };
});

vi.mock('@/text', () => ({ t: mocks.t }));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return { View: host('View'), Text: host('Text'), Pressable: host('Pressable') };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: '#000', textSecondary: '#666', surfaceHigh: '#eee' } } }),
}));

import { DotMemoryToolHint } from './DotMemoryToolHint';

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const dotTarget = { keyDigest: digest('a'), scope: 'dot' as const };
const userTarget = { keyDigest: digest('b'), scope: 'user' as const };
const renderers: ReturnType<typeof create>[] = [];

function item(key: string, target: typeof dotTarget | typeof userTarget | null, source: string | null, value: string | null) {
    return { key, keyDigest: target?.keyDigest ?? null, scope: target?.scope ?? null, source, valueSummary: value, target };
}

function render(hint: DotMemoryHint, onOpen = vi.fn()) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(DotMemoryToolHint, { hint, onOpen })); });
    renderers.push(renderer);
    const pressable = (label: string) => renderer.root.findAllByType('Pressable')
        .find((node: any) => node.props.accessibilityLabel === label);
    return { renderer, onOpen, pressable, text: () => JSON.stringify(renderer.toJSON()) };
}

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const original = console.error;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        original(message, ...args);
    });
});
afterAll(() => vi.restoreAllMocks());
afterEach(() => act(() => renderers.splice(0).forEach(renderer => renderer.unmount())));

describe('DotMemoryToolHint', () => {
    const multiple: DotMemoryHint = {
        kind: 'recall', status: 'ready', count: 2,
        memories: [item('偏好', dotTarget, 'user', '中文'), item('时区', userTarget, 'agent', 'UTC+8')],
    };

    it('starts a multi-memory recall collapsed under a stable testID and expands real rows', () => {
        const f = render(multiple);
        expect(f.renderer.root.findAllByProps({ testID: 'dot-memory-recall-hint' }).length).toBeGreaterThan(0);
        expect(f.text()).toContain('检索到 2 条相关记忆');
        expect(f.text()).not.toContain('偏好');

        act(() => f.pressable('展开详情')!.props.onPress());
        expect(f.text()).toContain('偏好');
        expect(f.text()).toContain('中文');
        expect(f.text()).toContain('来源：user');
        expect(f.text()).toContain('范围：Dot 级');
        expect(f.text()).toContain('时区');
        expect(f.text()).toContain('范围：用户级');

        act(() => f.pressable('查看召回记忆：偏好')!.props.onPress());
        expect(f.onOpen).toHaveBeenCalledExactlyOnceWith(dotTarget);
        act(() => f.pressable('收起详情')!.props.onPress());
        expect(f.text()).not.toContain('偏好');
    });

    it('keeps a single recalled memory collapsed until explicitly expanded', () => {
        const f = render({ kind: 'recall', status: 'ready', count: 1, memories: [item('偏好', userTarget, 'user', '中文')] });
        expect(f.text()).toContain('检索到 1 条相关记忆');
        expect(f.text()).not.toContain('偏好');
        expect(f.pressable('查看召回记忆：偏好')).toBeUndefined();
        act(() => f.pressable('展开详情')!.props.onPress());
        expect(f.text()).toContain('范围：用户级');
        expect(f.pressable('查看召回记忆：偏好')).toBeTruthy();
    });

    it('does not make rows clickable when the reply lacked a digest', () => {
        const f = render({ kind: 'recall', status: 'ready', count: 1, memories: [item('偏好', null, 'user', '中文')] });
        act(() => f.pressable('展开详情')!.props.onPress());
        expect(f.text()).toContain('偏好');
        expect(f.pressable('查看召回记忆：偏好')).toBeUndefined();
    });

    it.each([
        [{ kind: 'recall', status: 'ready', count: 0, memories: [] } as DotMemoryHint, '查找了记忆 · 未找到匹配'],
        [{ kind: 'recall', status: 'running', count: 0, memories: [] } as DotMemoryHint, '正在检索记忆…'],
        [{ kind: 'recall', status: 'failed', count: 0, memories: [] } as DotMemoryHint, '记忆检索失败'],
        [{ kind: 'recall', status: 'unreadable', count: 0, memories: [] } as DotMemoryHint, '记忆检索结果无法解析'],
    ])('states the exact recall outcome without offering a fake success (%#)', (hint, text) => {
        const f = render(hint as DotMemoryHint);
        expect(f.text()).toContain(text);
        expect(f.text()).not.toContain('检索到');
        expect(f.pressable('展开详情')).toBeUndefined();
    });

    it('reports a saved write and opens its receipt target', () => {
        const f = render({ kind: 'write', tool: 'dot_memory_write', status: 'saved', target: userTarget });
        expect(f.renderer.root.findAllByProps({ testID: 'dot-memory-write-hint' }).length).toBeGreaterThan(0);
        expect(f.text()).toContain('已保存到记忆');
        act(() => f.pressable('查看这条记忆')!.props.onPress());
        expect(f.onOpen).toHaveBeenCalledExactlyOnceWith(userTarget);
    });

    it('shows a forgotten write and keeps writes without a target non-clickable', () => {
        const f = render({ kind: 'write', tool: 'dot_memory_write', status: 'forgotten', target: null });
        expect(f.text()).toContain('已在当前记忆中忘记');
        expect(f.pressable('查看这条记忆')).toBeUndefined();
    });

    it.each([
        [{ kind: 'write', tool: 'dot_memory_write', status: 'running', target: null } as DotMemoryHint, '正在保存记忆…'],
        [{ kind: 'write', tool: 'dot_memory_write', status: 'failed', target: null } as DotMemoryHint, '记忆保存失败'],
        [{ kind: 'write', tool: 'dot_memory_write', status: 'unreadable', target: null } as DotMemoryHint, '记忆保存结果无法解析'],
        [{ kind: 'write', tool: 'dot_memory_write', status: 'pending', target: null } as DotMemoryHint, '记忆操作已返回，状态待核对'],
        [{ kind: 'write', tool: 'dot_memory_confirm', status: 'running', target: null } as DotMemoryHint, '正在确认记忆…'],
        [{ kind: 'write', tool: 'dot_memory_confirm', status: 'failed', target: null } as DotMemoryHint, '确认记忆失败'],
        [{ kind: 'write', tool: 'dot_memory_confirm', status: 'unreadable', target: null } as DotMemoryHint, '确认记忆结果无法解析'],
    ])('keeps non-terminal write states accurate (%#)', (hint, text) => {
        expect(render(hint as DotMemoryHint).text()).toContain(text);
    });

    it('shows a proposal as awaiting confirmation and never claims it was saved', () => {
        const f = render({ kind: 'propose', status: 'proposed' });
        expect(f.renderer.root.findAllByProps({ testID: 'dot-memory-propose-hint' }).length).toBeGreaterThan(0);
        expect(f.text()).toContain('记忆变更待确认');
        expect(f.text()).not.toContain('已保存到记忆');
        const running = render({ kind: 'propose', status: 'running' });
        expect(running.text()).toContain('正在准备记忆提案…');
    });
});