import * as React from 'react';
import { AppState, Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { useDeepEqual } from '@/sync/storeSelectors';
import { selectMobileSessionAttention, type MobileAttentionItem } from '@/sync/mobileSessionAttention';
import { SESSION_ATTENTION_COLORS } from '@/utils/sessionListStatus';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';

export function MobileSessionNotifications() {
    const { isAuthenticated } = useAuth();
    const ready = storage(state => state.isDataReady);
    return isAuthenticated && ready ? <MobileSessionNotificationContent /> : null;
}

export function MobileSessionNotificationContent() {
    const items = storage(useDeepEqual(selectMobileSessionAttention));
    const active = storage(state => state.appIsActive);
    const haptics = storage(state => state.settings.sessionNotificationHaptics);
    const insets = useSafeAreaInsets();
    const { height, width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const navigate = useNavigateToSession();
    const [expanded, setExpanded] = React.useState(false);
    const [banner, setBanner] = React.useState<MobileAttentionItem | null>(null);
    const seen = React.useRef<Set<string> | null>(null);

    React.useEffect(() => {
        // Live presence and its durable push event can describe the same change.
        // Re-arm only after the conversation leaves this status (for example, runs again).
        const keys = new Set(items.map(item => `${item.id}:${item.status}`));
        const incoming = seen.current ? items.find(item => !seen.current!.has(`${item.id}:${item.status}`)) : undefined;
        seen.current = keys;
        if (!active) { setBanner(null); return; }
        if (!incoming) {
            setBanner(previous => previous ? items.find(item => item.id === previous.id && item.status === previous.status) ?? null : null);
            return;
        }
        setBanner(incoming);
        if (haptics && Platform.OS === 'ios' && AppState.currentState === 'active') {
            void Haptics.notificationAsync(incoming.status === 'failed' ? Haptics.NotificationFeedbackType.Error : Haptics.NotificationFeedbackType.Success)
                .catch(error => console.warn('Session notification haptic unavailable', error));
        }
    }, [items, active, haptics]);

    React.useEffect(() => {
        if (!banner) return;
        const timeout = setTimeout(() => setBanner(null), 3500);
        return () => clearTimeout(timeout);
    }, [banner]);

    React.useEffect(() => { if (items.length === 0) setExpanded(false); }, [items.length]);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;
        void Notifications.setBadgeCountAsync(items.length).catch(error => console.warn('Unable to update session badge', error));
    }, [items.length]);

    const open = (id: string) => { setExpanded(false); setBanner(null); navigate(id); };
    const completed = items.filter(item => item.status === 'completed').length;
    const action = items.length - completed;
    const summary = t('sessionNotifications.summary', { completed, action });
    return (
        <>
            {items.length > 0 && active && (
                <View style={[styles.overlay, { top: insets.top + 54, maxWidth: width - 32 }]} pointerEvents="box-none">
                    <Pressable style={styles.pill} onPress={() => setExpanded(true)} accessibilityRole="button" accessibilityLabel={`${summary}. ${t('sessionNotifications.open')}`} testID="mobile-attention-summary">
                        <Ionicons name="notifications-outline" size={16} color={action ? '#FF9500' : theme.colors.success} />
                        <Text style={styles.summary}>{summary}</Text>
                        <Ionicons name="chevron-down" size={13} color={theme.colors.textSecondary} />
                    </Pressable>
                    {banner && items.some(item => item.id === banner.id && item.eventId === banner.eventId) && (
                        <View style={[styles.banner, { width: Math.min(340, width - 32) }]} testID="mobile-attention-banner">
                            <Pressable style={styles.bannerOpen} onPress={() => open(banner.id)} accessibilityRole="button">
                                <AttentionRow item={banner} />
                            </Pressable>
                            <Pressable style={styles.close} onPress={() => setBanner(null)} accessibilityRole="button" accessibilityLabel={t('sessionNotifications.close')}>
                                <Ionicons name="close" size={17} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                    )}
                </View>
            )}
            <Modal visible={expanded} transparent animationType="slide" onRequestClose={() => setExpanded(false)}>
                <View style={styles.backdrop}>
                    <Pressable style={styles.dismissArea} onPress={() => setExpanded(false)} accessibilityRole="button" accessibilityLabel={t('sessionNotifications.close')} />
                    <View style={[styles.sheet, { maxHeight: height * 0.75, paddingBottom: insets.bottom + 12 }]}>
                        <View style={styles.sheetHeader}>
                            <Text style={styles.heading}>{t('sessionNotifications.title')}</Text>
                            <Pressable style={styles.close} onPress={() => setExpanded(false)} accessibilityRole="button" accessibilityLabel={t('sessionNotifications.close')}>
                                <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                            </Pressable>
                        </View>
                        <ScrollView testID="mobile-attention-list">
                            {items.map(item => (
                                <Pressable key={item.id} style={styles.row} onPress={() => open(item.id)} accessibilityRole="button" accessibilityLabel={item.name}>
                                    <AttentionRow item={item} />
                                    <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            ))}
                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </>
    );
}

function AttentionRow({ item }: { item: MobileAttentionItem }) {
    const { theme } = useUnistyles();
    const color = SESSION_ATTENTION_COLORS[item.status];
    const label = item.status === 'completed' ? t('status.completed') : item.status === 'failed' ? t('status.failed')
        : item.status === 'permission_required' ? t('status.permissionRequired') : t('status.inputRequired');
    return (
        <>
            <Ionicons name={item.status === 'completed' ? 'checkmark-circle' : 'alert-circle'} size={22} color={color} />
            <View style={styles.rowText}>
                <Text style={styles.title} numberOfLines={2}>{item.name}</Text>
                <Text style={[styles.label, { color: theme.dark ? color : item.status === 'completed' ? '#187A33' : item.status === 'failed' ? '#B42318' : '#995700' }]}>{label}</Text>
            </View>
        </>
    );
}

const styles = StyleSheet.create(theme => ({
    overlay: { position: 'absolute', right: 16, zIndex: 1000, alignItems: 'flex-end', gap: 8 },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.surface, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 9 },
    summary: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text },
    banner: { flexDirection: 'row', maxWidth: 340, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12 },
    bannerOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
    close: { padding: 12 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
    dismissArea: { flex: 1 },
    sheet: { backgroundColor: theme.colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 20, paddingTop: 8 },
    heading: { ...Typography.default('semiBold'), fontSize: 18, color: theme.colors.text },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider },
    rowText: { flex: 1, gap: 4 },
    title: { ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text },
    label: { ...Typography.default(), fontSize: 12 },
}));
