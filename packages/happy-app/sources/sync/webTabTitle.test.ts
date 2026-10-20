import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

let tab: EventTarget & { title: string; visibilityState: string; hasFocus: () => boolean; head: object };
let focused: boolean;
let titleChanged: () => void;

beforeEach(() => {
    vi.resetModules();
    focused = false;
    tab = Object.assign(new EventTarget(), {
        title: 'Happy', visibilityState: 'hidden', hasFocus: () => focused, head: {},
    });
    vi.stubGlobal('document', tab);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('MutationObserver', class {
        constructor(callback: () => void) { titleChanged = callback; }
        observe() {}
    });
});
afterEach(() => vi.unstubAllGlobals());

describe('browser tab title', () => {
    it('shows completed conversations, updates their count and restores the screen title', async () => {
        const { setCompletedSessionCount } = await import('./webTabTitle');
        setCompletedSessionCount(2);
        expect(tab.title).toBe('✓ (2) Happy');
        setCompletedSessionCount(1);
        expect(tab.title).toBe('✓ (1) Happy');
        setCompletedSessionCount(0);
        expect(tab.title).toBe('Happy');
    });

    it('preserves other unread completions on focus while resetting lifecycle event counts', async () => {
        const { notifyUnreadMessage, setCompletedSessionCount } = await import('./webTabTitle');
        notifyUnreadMessage();
        expect(tab.title).toBe('(1) Happy');
        setCompletedSessionCount(2);
        expect(tab.title).toBe('✓ (2) Happy');
        tab.visibilityState = 'visible';
        focused = true;
        window.dispatchEvent(new Event('focus'));
        expect(tab.title).toBe('✓ (2) Happy');
        setCompletedSessionCount(0);
        expect(tab.title).toBe('Happy');
    });

    it('reapplies the completion prefix when navigation replaces the title, without looping on its own writes', async () => {
        const { setCompletedSessionCount } = await import('./webTabTitle');
        setCompletedSessionCount(1);
        tab.title = 'Settings';
        titleChanged();
        expect(tab.title).toBe('✓ (1) Settings');
        const write = vi.fn();
        Object.defineProperty(tab, 'title', { get: () => '✓ (1) Settings', set: write });
        titleChanged();
        expect(write).not.toHaveBeenCalled();
    });
});
