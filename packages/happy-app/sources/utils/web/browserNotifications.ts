export type BrowserNotificationPermission = NotificationPermission | 'unsupported' | 'insecure';

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
    // Browsers treat HTTP localhost and loopback addresses as secure contexts too.
    if (!window.isSecureContext) return 'insecure';
    return Notification.permission;
}

/** Call directly from a click handler, before awaiting any other work. */
export function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
    const permission = getBrowserNotificationPermission();
    return permission === 'default' ? Notification.requestPermission() : Promise.resolve(permission);
}

export function showCompletionNotification(sessionId: string, name: string, title: string, onOpen: () => void): Notification | null {
    if (getBrowserNotificationPermission() !== 'granted') return null;
    try {
        const notification = new Notification(title, {
            body: name,
            icon: '/favicon.ico',
            tag: `happy-completed-${sessionId}`,
            data: { sessionId },
        });
        notification.onclick = event => {
            event.preventDefault();
            onOpen();
            window.focus();
            notification.close();
        };
        return notification;
    } catch (error) {
        // Unsupported constructors (including some mobile browsers) must not
        // interrupt the in-page completion cards or tab indicators.
        console.warn('Unable to show desktop completion notification', error);
        return null;
    }
}
