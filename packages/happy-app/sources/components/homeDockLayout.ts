const PROJECT_SHEET_HEIGHT_FRACTION = 0.7;
// Top header (8 + 32), the gap below the sheet (22), and composer padding (8).
const PROJECT_SHEET_FIXED_CHROME_HEIGHT = 70;

/**
 * Fits the directory sheet between the focus header and the real composer.
 * Keyboard height is negative while opening; its progress also determines how
 * much of the resting bottom inset the dock has given back.
 */
export function resolveHomeDockProjectSheetMaxHeight({
    windowHeight,
    safeAreaTop,
    safeAreaBottom,
    keyboardHeight,
    keyboardProgress,
    focusedComposerHeight,
}: {
    windowHeight: number;
    safeAreaTop: number;
    safeAreaBottom: number;
    keyboardHeight: number;
    keyboardProgress: number;
    focusedComposerHeight: number;
}) {
    'worklet';
    const availableHeight = windowHeight
        + keyboardHeight
        - safeAreaTop
        - safeAreaBottom * (1 - keyboardProgress)
        - focusedComposerHeight
        - PROJECT_SHEET_FIXED_CHROME_HEIGHT;
    return Math.max(0, Math.min(windowHeight * PROJECT_SHEET_HEIGHT_FRACTION, availableHeight));
}
