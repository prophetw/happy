import * as React from 'react';
import { AppState, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './StyledText';
import { Typography } from '@/constants/Typography';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { useDeepEqual } from '@/sync/storeSelectors';
import { selectHumanInterventions } from '@/sync/humanIntervention';
import { sessionReplyHumanIntervention } from '@/sync/ops';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { t } from '@/text';

export function HumanInterventionNotifications() {
    const { isAuthenticated } = useAuth();
    const ready = storage(state => state.isDataReady);
    return isAuthenticated && ready ? <HumanInterventionNotificationContent /> : null;
}

export function HumanInterventionNotificationContent() {
    const requests = storage(useDeepEqual(selectHumanInterventions));
    const active = storage(state => state.appIsActive);
    const haptics = storage(state => state.settings.sessionNotificationHaptics);
    const insets = useSafeAreaInsets();
    const navigate = useNavigateToSession();
    const [deferred, setDeferred] = React.useState<ReadonlySet<string>>(new Set());
    const [submitting, setSubmitting] = React.useState<string | null>(null);
    const busy = React.useRef(false);
    const [error, setError] = React.useState<{ id: string; message: string } | null>(null);
    const seen = React.useRef(new Set<string>());
    const request = requests.find(item => !deferred.has(item.id));

    React.useEffect(() => {
        if (!active) return;
        const incoming = requests.some(item => !seen.current.has(item.id));
        seen.current = new Set(requests.map(item => item.id));
        if (incoming && haptics && Platform.OS !== 'web' && AppState.currentState === 'active') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
                .catch(error => console.warn('Human intervention haptic unavailable', error));
        }
    }, [requests, active, haptics]);

    const defer = (id: string) => setDeferred(previous => new Set(previous).add(id));
    const reply = async (status: 'resolved' | 'cancelled') => {
        if (!request || busy.current) return;
        busy.current = true;
        setSubmitting(request.id);
        setError(null);
        const attentionEventId = storage.getState().sessionAttention[request.sessionId]?.eventId;
        try {
            await sessionReplyHumanIntervention(request.sessionId, request.id, status);
            // The CLI clears encrypted state only after durably queuing the follow-up.
            // Do not hide a newer request that arrived while this one was submitted.
            const state = storage.getState();
            if (attentionEventId && state.sessionAttention[request.sessionId]?.eventId === attentionEventId
                && state.sessionAttention[request.sessionId]?.kind === 'intervention') state.markSessionRead(request.sessionId);
            defer(request.id);
        } catch (error) {
            setError({ id: request.id, message: t('humanIntervention.sendFailed') });
        } finally {
            busy.current = false;
            setSubmitting(null);
        }
    };

    if (!active || requests.length === 0) return null;
    return (
        <>
            {!request && (
                <View style={[styles.reminder, { bottom: insets.bottom + 70 }]} pointerEvents="box-none">
                    <Pressable style={styles.reminderButton} onPress={() => setDeferred(new Set())} accessibilityRole="button" testID="human-intervention-reminder">
                        <Ionicons name="alert-circle" size={22} color="#FF9500" />
                        <Text style={styles.reminderText}>{t('status.interventionRequired')}</Text>
                    </Pressable>
                </View>
            )}
            <Modal visible={Boolean(request)} transparent animationType="fade" onRequestClose={() => {}}>
                {request && (
                    <View style={[styles.backdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
                        <View style={styles.dialog} testID="human-intervention-dialog" accessibilityViewIsModal>
                            <ScrollView>
                                <Text style={styles.title} accessibilityRole="header">{t('status.interventionRequired')}</Text>
                                <Text style={styles.name}>{request.name}</Text>
                                <Text style={styles.body}>{request.host ? t('humanIntervention.computer', { host: request.host }) : t('humanIntervention.thisComputer')}</Text>
                                <Text style={styles.body}>{t(`humanIntervention.${request.kind}`)}</Text>
                                <Text style={styles.instructions} testID="human-intervention-instructions">{request.instructions}</Text>
                                <Text style={styles.hint}>{t('humanIntervention.hint')}</Text>
                                {!request.online && <Text style={styles.error}>{t('humanIntervention.offline')}</Text>}
                                {error?.id === request.id && <Text style={styles.error} testID="human-intervention-error" accessibilityRole="alert">{error.message}</Text>}
                                <Pressable disabled={!request.online || submitting !== null || request.response === 'cancelled'} style={styles.primary} accessibilityRole="button" testID="human-intervention-resolve" onPress={() => void reply('resolved')}>
                                    <Text style={styles.primaryText}>{submitting === request.id ? t('humanIntervention.sending') : t('humanIntervention.continue')}</Text>
                                </Pressable>
                                <Pressable disabled={!request.online || submitting !== null || request.response === 'resolved'} style={styles.button} accessibilityRole="button" testID="human-intervention-cancel" onPress={() => void reply('cancelled')}>
                                    <Text style={styles.cancel}>{t('humanIntervention.cancel')}</Text>
                                </Pressable>
                                <Pressable disabled={submitting !== null} style={styles.button} accessibilityRole="button" onPress={() => { defer(request.id); navigate(request.sessionId); }} testID="human-intervention-open">
                                    <Text style={styles.body}>{t('status.viewConversation')}</Text>
                                </Pressable>
                                <Pressable disabled={submitting !== null} style={styles.button} accessibilityRole="button" onPress={() => defer(request.id)} testID="human-intervention-later">
                                    <Text style={styles.hint}>{t('humanIntervention.later')}</Text>
                                </Pressable>
                            </ScrollView>
                        </View>
                    </View>
                )}
            </Modal>
        </>
    );
}

const styles = StyleSheet.create(theme => ({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
    dialog: { width: '100%', maxWidth: 440, maxHeight: '100%', backgroundColor: theme.colors.surface, borderRadius: 18, padding: 20 },
    title: { ...Typography.default('semiBold'), fontSize: 22, color: theme.colors.text },
    name: { ...Typography.default('semiBold'), fontSize: 16, color: theme.colors.text, marginTop: 10 },
    body: { ...Typography.default(), fontSize: 15, lineHeight: 22, color: theme.colors.text, marginTop: 8 },
    instructions: { ...Typography.default('semiBold'), fontSize: 16, lineHeight: 24, color: theme.colors.text, marginVertical: 14 },
    hint: { ...Typography.default(), fontSize: 13, lineHeight: 19, color: theme.colors.textSecondary },
    error: { ...Typography.default(), fontSize: 14, color: '#FF453A', marginTop: 12 },
    primary: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 18 },
    primaryText: { ...Typography.default('semiBold'), fontSize: 15, color: '#FFFFFF' },
    button: { padding: 12, alignItems: 'center' },
    cancel: { ...Typography.default('semiBold'), fontSize: 15, color: '#FF453A' },
    reminder: { position: 'absolute', right: 16, left: 16, zIndex: 1100, alignItems: 'center' },
    reminderButton: { flexDirection: 'row', alignItems: 'center', gap: 8, borderColor: '#FF9500', borderWidth: 1, backgroundColor: theme.colors.surface, borderRadius: 12, padding: 14 },
    reminderText: { ...Typography.default('semiBold'), fontSize: 14, color: theme.colors.text },
}));
