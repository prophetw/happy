import { describe, expect, it } from 'vitest';
import { resolveHomeDockProjectSheetMaxHeight } from './homeDockLayout';

const baseLayout = {
    windowHeight: 852,
    safeAreaTop: 59,
    safeAreaBottom: 34,
    keyboardHeight: -336,
    keyboardProgress: 1,
    focusedComposerHeight: 102,
};

describe('HomeDock project sheet layout', () => {
    it('uses the space left by the open keyboard and the actual composer', () => {
        expect(resolveHomeDockProjectSheetMaxHeight(baseLayout)).toBe(285);
    });

    it('matches the dock translation while the keyboard closes', () => {
        expect(resolveHomeDockProjectSheetMaxHeight({
            ...baseLayout,
            keyboardHeight: -168,
            keyboardProgress: 0.5,
        })).toBe(436);
        expect(resolveHomeDockProjectSheetMaxHeight({
            ...baseLayout,
            keyboardHeight: 0,
            keyboardProgress: 0,
        })).toBe(587);
    });

    it('gives back the height used by a growing composer', () => {
        expect(resolveHomeDockProjectSheetMaxHeight({
            ...baseLayout,
            focusedComposerHeight: 186,
        })).toBe(201);
    });

    it('caps the sheet at 70 percent of a large window', () => {
        expect(resolveHomeDockProjectSheetMaxHeight({
            ...baseLayout,
            windowHeight: 1200,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            keyboardHeight: 0,
            keyboardProgress: 0,
        })).toBe(840);
    });

    it('does not force the sheet over other controls on a tiny window', () => {
        expect(resolveHomeDockProjectSheetMaxHeight({
            ...baseLayout,
            windowHeight: 500,
            safeAreaTop: 20,
            safeAreaBottom: 20,
            keyboardHeight: -400,
            focusedComposerHeight: 186,
        })).toBe(0);
    });
});
