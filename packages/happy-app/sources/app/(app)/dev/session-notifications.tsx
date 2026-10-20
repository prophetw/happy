import * as React from 'react';
import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MobileSessionNotificationContent } from '@/components/MobileSessionNotifications';

/** Browser preview of the shared mobile presentation; no fixture data enters a shipped app. */
export default function SessionNotificationsPreview() {
    const { theme } = useUnistyles();
    if (!__DEV__) return <Redirect href="/" />;
    return <View style={{ flex: 1, backgroundColor: theme.colors.surface }}><MobileSessionNotificationContent /></View>;
}
