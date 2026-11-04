import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text } from './StyledText';
import { usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { FlatSessionRow } from './FlatSessionRow';
import { toFlatSessionRow } from '@/utils/flatSessionList';
import { useIsTablet } from '@/utils/responsive';
import type { SessionRowData } from '@/sync/storage';

/** A standing assistant is a direct conversation, with no machine presence implied. */
export const DotsSessionsGroup = React.memo(({ sessions }: { sessions: readonly SessionRowData[] }) => {
    const { theme } = useUnistyles();
    const pathname = usePathname();
    const isTablet = useIsTablet();
    const selected = isTablet && pathname.startsWith('/session/') ? pathname.split('/')[2] : undefined;
    const count = sessions.filter(session => session.testloopDotsKind === 'dot').length;
    const styles = React.useMemo(() => StyleSheet.create({
        group: { marginHorizontal: 8, marginTop: 8, marginBottom: 16, overflow: 'hidden', borderRadius: 14,
            borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
        header: { paddingHorizontal: 14, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
        title: { flex: 1, color: theme.colors.text, fontSize: 13, fontWeight: '600' },
        count: { color: theme.colors.textSecondary, fontSize: 12 },
    }), [theme]);
    return <View testID="testloop-dots-group" style={styles.group}>
        <View style={styles.header}>
            <Ionicons name="grid-outline" size={15} color={theme.colors.textSecondary} />
            <Text accessibilityRole="header" style={styles.title}>个人助理 / Dots</Text>
            <Text style={styles.count}>{count} 个助理</Text>
        </View>
        {sessions.map((session, index) => <FlatSessionRow key={session.id} row={toFlatSessionRow(session)}
            selected={session.id === selected} showBorder={index !== sessions.length - 1} />)}
    </View>;
});
