import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import type { SessionState } from '@/sync/sessionState';
import { getSessionAttentionStatus, SESSION_ATTENTION_COLORS } from '@/utils/sessionListStatus';
import { StatusDot } from './StatusDot';

/** A steady colour plus text makes the state readable without watching a pulse. */
export const SessionStatusBadge = React.memo(({ state, hasUnread }: { state: SessionState; hasUnread: boolean }) => {
    const { theme } = useUnistyles();
    const status = getSessionAttentionStatus(state, hasUnread);
    if (!status) return null;
    const color = SESSION_ATTENTION_COLORS[status];
    const textColor = theme.dark ? color
        : status === 'completed' ? '#187A33' : status === 'running' ? '#0066CC' : '#995700';
    const label = status === 'permission_required' ? t('status.permissionRequired')
        : status === 'input_required' ? t('status.inputRequired')
            : status === 'running' ? t('status.running') : t('status.completed');

    return (
        <View style={[styles.badge, { backgroundColor: `${color}18` }]} accessibilityLabel={label} accessibilityRole="text">
            {status === 'completed'
                ? <Ionicons name="checkmark-circle" size={13} color={color} />
                : <StatusDot color={color} size={6} />}
            <Text style={[styles.label, { color: textColor }]} numberOfLines={1}>{label}</Text>
        </View>
    );
});

const styles = StyleSheet.create({
    badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6, flexShrink: 0 },
    label: { ...Typography.default('semiBold'), fontSize: 11, lineHeight: 14 },
});
