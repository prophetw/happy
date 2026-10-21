import * as React from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useShallow } from 'zustand/react/shallow';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { selectCompletedSessionIds } from '@/sync/sessionCompletion';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { getSessionName } from '@/utils/sessionUtils';
import { t } from '@/text';
import { useBrowserCompletionNotifications } from './useBrowserCompletionNotifications';

export function SessionCompletionNotifications() {
    const { isAuthenticated } = useAuth();
    return isAuthenticated ? <CompletionNotifications /> : null;
}

function CompletionNotifications() {
    const completedIds = storage(useShallow(selectCompletedSessionIds));
    useBrowserCompletionNotifications(completedIds);
    const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
    const { width, height } = useWindowDimensions();

    // Dismissing a card leaves its unread badge intact. A new turn can notify again.
    React.useEffect(() => {
        setDismissed(previous => {
            const next = new Set([...previous].filter(id => completedIds.includes(id)));
            return next.size === previous.size ? previous : next;
        });
    }, [completedIds]);

    const visibleIds = completedIds.filter(id => !dismissed.has(id));
    if (visibleIds.length === 0) return null;
    return (
        <View style={[styles.container, { width: Math.min(360, width - 32) }]} pointerEvents="box-none" testID="session-completion-notifications">
            <View style={styles.heading}>
                <Text style={styles.headingText}>{t('status.completed')} ({visibleIds.length})</Text>
            </View>
            <ScrollView style={{ maxHeight: Math.max(120, height - 160) }} contentContainerStyle={styles.cards} accessibilityLiveRegion="polite">
                {visibleIds.map(id => (
                    <CompletionCard key={id} sessionId={id} onDismiss={() => setDismissed(previous => new Set(previous).add(id))} />
                ))}
            </ScrollView>
        </View>
    );
}

function CompletionCard({ sessionId, onDismiss }: { sessionId: string; onDismiss: () => void }) {
    const name = storage(state => state.sessions[sessionId] ? getSessionName(state.sessions[sessionId]) : '');
    const navigateToSession = useNavigateToSession();
    const { theme } = useUnistyles();
    return (
        <View style={styles.card} testID={`session-completion-${sessionId}`}>
            <Pressable
                style={styles.open}
                onPress={() => navigateToSession(sessionId)}
                accessibilityRole="button"
                accessibilityLabel={`${t('status.completed')}: ${name}. ${t('status.viewConversation')}`}
            >
                <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />
                <View style={styles.content}>
                    <Text style={styles.title} numberOfLines={2}>{name}</Text>
                    <Text style={styles.hint}>{t('status.viewConversation')}</Text>
                </View>
            </Pressable>
            <Pressable style={styles.dismiss} onPress={onDismiss} accessibilityRole="button" accessibilityLabel={t('status.dismissCompletion')}>
                <Ionicons name="close" size={17} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    container: { position: 'absolute', top: 64, right: 16, zIndex: 1000 },
    heading: { alignSelf: 'flex-end', backgroundColor: theme.colors.surface, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 5, marginBottom: 6 },
    headingText: { ...Typography.default('semiBold'), fontSize: 12, color: theme.dark ? theme.colors.success : '#187A33' },
    cards: { gap: 8, padding: 2 },
    card: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, borderLeftWidth: 3, borderLeftColor: theme.colors.success, borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' },
    open: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
    content: { flex: 1, gap: 5 },
    title: { ...Typography.default('semiBold'), fontSize: 13, color: theme.colors.text },
    hint: { ...Typography.default(), fontSize: 12, color: theme.colors.textSecondary },
    dismiss: { padding: 10 },
}));
