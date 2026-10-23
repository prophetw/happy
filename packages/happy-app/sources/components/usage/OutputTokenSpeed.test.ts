import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', () => ({ Pressable: 'Pressable', Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { textSecondary: 'secondary' } } }) }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string, values?: { speed: string }) => values ? `平均 ${values.speed} tok/s` : key }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));

import { OutputTokenSpeed, formatTokenSpeed } from './OutputTokenSpeed';
import { Modal } from '@/modal';

const renderers: ReturnType<typeof create>[] = [];
afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.clearAllMocks();
});

function render(tokensPerSecond?: number) {
    let renderer!: ReturnType<typeof create>;
    act(() => { renderer = create(React.createElement(OutputTokenSpeed, { tokensPerSecond })); });
    renderers.push(renderer);
    return renderer;
}

describe('OutputTokenSpeed', () => {
    it('shows tokens per second and explains the average when pressed', () => {
        const renderer = render(50);
        expect(renderer.root.findByType('Text').props.children).toBe('平均 50.0 tok/s');
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
