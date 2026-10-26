import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textSecondary: 'secondary' } } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({
    t: (key: string, values?: { speed?: string; tokens?: string; seconds?: string; requests?: number }) => {
        if (key === 'agentInput.context.outputSpeed') return `模型 ${values?.speed} tok/s`;
        if (key === 'agentInput.context.outputSpeedCalculation') {
            return `本轮采样 ${values?.requests} 次模型请求：${values?.tokens} 输出 token ÷ ${values?.seconds} 秒 = ${values?.speed} tok/s`;
        }
        return key;
    },
}));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));

import { OutputTokenSpeed, formatTokenSpeed } from './OutputTokenSpeed';
import { Modal } from '@/modal';

const renderers: ReturnType<typeof create>[] = [];
afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.clearAllMocks();
});

function render(tokensPerSecond?: number, sample?: { tokens: number; durationMs: number; requests: number }) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(OutputTokenSpeed, { tokensPerSecond, sample })); });
    renderers.push(renderer);
    return renderer;
}

describe('OutputTokenSpeed', () => {
    it('shows model tokens per second and opens its sampling explanation', () => {
        const renderer = render(50);
        expect(renderer.root.findByType('Text').props.children).toBe('模型 50.0 tok/s');
        act(() => renderer.root.findByType('Pressable').props.onPress());
        expect(Modal.alert).toHaveBeenCalledWith('agentInput.context.outputSpeedTitle', 'agentInput.context.outputSpeedDescription');
    });

    it('explains the sampled tokens, duration and request count', () => {
        const renderer = render(50, { tokens: 1234, durationMs: 24680, requests: 2 });
        act(() => renderer.root.findByType('Pressable').props.onPress());
        const [title, body] = vi.mocked(Modal.alert).mock.calls[0];
        expect(title).toBe('agentInput.context.outputSpeedTitle');
        expect(body).toBe('本轮采样 2 次模型请求：1,234 输出 token ÷ 24.68 秒 = 50.0 tok/s\n\nagentInput.context.outputSpeedDescription');
    });

    it('falls back to the general explanation without sample totals', () => {
        const renderer = render(50, { tokens: 0, durationMs: 0, requests: 0 });
        act(() => renderer.root.findByType('Pressable').props.onPress());
        expect(Modal.alert).toHaveBeenCalledWith('agentInput.context.outputSpeedTitle', 'agentInput.context.outputSpeedDescription');
    });

    it.each([undefined, 0, -1, NaN, Infinity])('hides unavailable or invalid rates: %s', (rate) => {
        expect(render(rate).toJSON()).toBeNull();
    });

    it('keeps slow valid rates distinct from zero', () => {
        expect(formatTokenSpeed(0.01)).toBe('<0.1');
        expect(formatTokenSpeed(12.345)).toBe('12.3');
    });
});
