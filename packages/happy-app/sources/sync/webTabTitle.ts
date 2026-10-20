/**
 * Web-only: show unread completed conversations as "✓ (N) " in the tab title.
 * Lifecycle events retain their "(N) " fallback until the tab regains focus.
 *
 * The base title (e.g. screen-specific titles set by Expo Router) is recovered
 * by stripping our own prefix. Observe navigation title changes so the
 * indicator survives Expo Router updates as well.
 */

import { Platform } from 'react-native';

let unreadCount = 0;
let completedSessionCount = 0;
let initialized = false;

export function isWebTabActive(): boolean {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
        return true;
    }
    const visible = document.visibilityState === 'visible';
    const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return visible && focused;
}

function applyTitle() {
    if (typeof document === 'undefined') {
        return;
    }
    const stripped = document.title.replace(/^(?:✓\s+)?\(\d+\)\s*/, '');
    const prefix = completedSessionCount > 0 ? `✓ (${completedSessionCount}) ` : unreadCount > 0 ? `(${unreadCount}) ` : '';
    const title = prefix + stripped;
    if (document.title !== title) document.title = title;
}

function ensureInit() {
    if (initialized || Platform.OS !== 'web' || typeof document === 'undefined') {
        return;
    }
    initialized = true;
    const reset = () => {
        if (isWebTabActive() && unreadCount !== 0) {
            unreadCount = 0;
            applyTitle();
        }
    };
    document.addEventListener('visibilitychange', reset);
    window.addEventListener('focus', reset);
    if (typeof MutationObserver !== 'undefined' && document.head) {
        new MutationObserver(applyTitle).observe(document.head, { childList: true, subtree: true, characterData: true });
    }
}

export function setCompletedSessionCount(count: number) {
    if (Platform.OS !== 'web') return;
    ensureInit();
    completedSessionCount = count;
    applyTitle();
}

export function notifyUnreadMessage() {
    if (Platform.OS !== 'web') {
        return;
    }
    ensureInit();
    if (isWebTabActive()) {
        return;
    }
    unreadCount++;
    applyTitle();
}
