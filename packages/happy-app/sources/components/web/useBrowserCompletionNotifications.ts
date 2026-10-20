import * as React from 'react';
import { storage, useLocalSetting } from '@/sync/storage';
import { isWebTabActive } from '@/sync/webTabTitle';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
import { showCompletionNotification } from '@/utils/web/browserNotifications';
import { t } from '@/text';

export function useBrowserCompletionNotifications(completedIds: readonly string[]) {
    const enabled = useLocalSetting('desktopNotificationsEnabled');
    const ready = storage(state => state.isDataReady);
    const navigateToSession = useNavigateToSession();
    const previous = React.useRef(new Set(completedIds));
    const wasReady = React.useRef(ready);
    const wasEnabled = React.useRef(enabled);
    const notifications = React.useRef(new Map<string, Notification>());

    React.useEffect(() => {
        const current = new Set(completedIds);
        for (const [id, notification] of notifications.current) {
            if (!enabled || !current.has(id)) {
                notification.close();
                notifications.current.delete(id);
            }
        }
        // Restoring history or enabling notifications must not replay old results.
        if (enabled && wasEnabled.current && ready && wasReady.current && !isWebTabActive()) {
            for (const id of current) {
                if (previous.current.has(id)) continue;
                const session = storage.getState().sessions[id];
                if (!session) continue;
                const notification = showCompletionNotification(id, getSessionName(session), `Happy · ${t('status.completed')}`, () => {
                    const state = storage.getState();
                    if (!state.sessions[id]) return;
                    // Claim the destination before focusing the window, so the
                    // focus listener cannot mark a different conversation read.
                    state.setCurrentViewingSession(id);
                    navigateToSession(id);
                });
                if (notification) notifications.current.set(id, notification);
            }
        }
        previous.current = current;
        wasReady.current = ready;
        wasEnabled.current = enabled;
    }, [completedIds, enabled, ready, navigateToSession]);

    React.useEffect(() => () => {
        for (const notification of notifications.current.values()) notification.close();
        notifications.current.clear();
    }, []);
}
