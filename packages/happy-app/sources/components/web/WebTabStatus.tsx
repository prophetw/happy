import React from 'react';
import { Platform } from 'react-native';
import { storage } from '@/sync/storage';
import { selectCompletedSessionIds } from '@/sync/sessionCompletion';
import { isWebTabActive, setCompletedSessionCount } from '@/sync/webTabTitle';
import { updateFaviconWithNotification, resetFavicon } from '@/utils/web/faviconGenerator';

/**
 * Keep browser chrome in sync with unread completions and pending permissions.
 * One favicon owner prevents the two indicators from clearing each other.
 */
export const WebTabStatus = React.memo(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof document === 'undefined') {
        return null;
    }

    const completedCount = storage(state => selectCompletedSessionIds(state).length);
    const hasOnlineSessionWithPermissions = storage((state) => {
        return Object.values(state.sessions).some(session => {
            // Use centralized presence logic - only "online" sessions matter
            const isOnline = session.presence === 'online';

            const hasPermissions = session.agentState?.requests &&
                Object.keys(session.agentState.requests).length > 0;

            return isOnline && hasPermissions;
        });
    });

    const hasAttention = hasOnlineSessionWithPermissions || completedCount > 0;
    React.useLayoutEffect(() => {
        setCompletedSessionCount(completedCount);
    }, [completedCount]);

    React.useLayoutEffect(() => {
        if (hasAttention) {
            updateFaviconWithNotification();
        } else {
            resetFavicon();
        }
    }, [hasAttention]);

    React.useLayoutEffect(() => {
        const markVisibleSessionRead = () => {
            if (!isWebTabActive()) return;
            const { currentViewingSessionId, markSessionRead } = storage.getState();
            if (currentViewingSessionId) markSessionRead(currentViewingSessionId);
        };
        document.addEventListener('visibilitychange', markVisibleSessionRead);
        window.addEventListener('focus', markVisibleSessionRead);
        markVisibleSessionRead();
        return () => {
            document.removeEventListener('visibilitychange', markVisibleSessionRead);
            window.removeEventListener('focus', markVisibleSessionRead);
            setCompletedSessionCount(0);
            resetFavicon();
        };
    }, []);

    return null;
});

WebTabStatus.displayName = 'WebTabStatus';
