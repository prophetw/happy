import * as React from 'react';
import { View, Text, ScrollView, Pressable, Platform, ActivityIndicator, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSession } from '@/sync/storage';
import { useHappyAction } from '@/hooks/useHappyAction';
import { getDuplicateSheetFrame } from '@/utils/duplicateSheetLayout';
import {
    claudeListNativeSessions,
    resumeNativeClaudeSession,
    type NativeClaudeSession,
} from '@/sync/ops';
import { MobileGlassSurface } from './MobileGlass';

export interface ResumeNativeSessionSheetProps {
    sessionId: string;
    /** Injected by the modal infra. */
    onClose?: () => void;
}

/**
 * Picker behind the chat-local `/resume` command. Lists the machine's
 * native Claude conversations (straight from the on-disk JSONL, including
 * ones that never went through Happy) and, on confirm, spawns a fresh
 * Happy session that mounts the chosen conversation via `claude --resume`.
 */
export const ResumeNativeSessionSheet = React.memo(function ResumeNativeSessionSheet(props: ResumeNativeSessionSheetProps) {
    const { sessionId, onClose } = props;
    const session = useSession(sessionId);
    const router = useRouter();
    const { theme } = useUnistyles();
    const windowSize = useWindowDimensions();
    const sheetFrame = React.useMemo(
        () => getDuplicateSheetFrame(windowSize),
        [windowSize.width, windowSize.height],
    );

    const machineId = session?.metadata?.machineId ?? null;
    const isClaude = session?.metadata?.flavor === 'claude';

    const [sessions, setSessions] = React.useState<NativeClaudeSession[] | null>(null);
    const [sessionsError, setSessionsError] = React.useState<string | null>(null);
    const [selectedId, setSelectedId] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        async function load() {
            if (!isClaude) {
                if (!cancelled) {
                    setSessionsError(t('session.resumeClaudeOnly'));
                    setSessions([]);
                }
                return;
            }
            if (!machineId) {
                if (!cancelled) {
                    setSessionsError(t('session.resumeErrorMissingMetadata'));
                    setSessions([]);
                }
                return;
            }
            const result = await claudeListNativeSessions({ machineId });
            if (cancelled) return;
            if (result.type === 'success') {
                setSessions(result.sessions);
                setSessionsError(null);
            } else {
                setSessions([]);
                setSessionsError(result.errorMessage);
            }
        }
        void load();
        return () => { cancelled = true; };
    }, [isClaude, machineId]);

    const selected = (sessions && selectedId)
        ? sessions.find((s) => s.sessionId === selectedId) ?? null
        : null;

    const [loading, doResume] = useHappyAction(async () => {
        if (!machineId) {
            Modal.alert(t('common.error'), t('session.resumeErrorMissingMetadata'));
            return;
        }
        if (!selected) {
            return;
        }

        const result = await resumeNativeClaudeSession({
            machineId,
            directory: selected.cwd,
            claudeSessionId: selected.sessionId,
        });

        if (result.type === 'success') {
            onClose?.();
            router.replace(`/session/${result.sessionId}`);
            return;
        }

        const message = result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric');
        Modal.alert(t('common.error'), message);
    });

    return (
        <MobileGlassSurface
            enabled={Platform.OS !== 'web'}
            nativeEffect
            glassEffectStyle="regular"
            intensity={88}
            tintColor={theme.colors.glass.overlayTint}
            style={[styles.sheet, sheetFrame]}
        >
            <View style={styles.header}>
                <Text style={styles.title}>{t('session.resumeSheetTitle')}</Text>
                <Text style={styles.subtitle}>{t('session.resumeSheetSubtitle')}</Text>
            </View>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
                {sessions === null ? (
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator />
                    </View>
                ) : sessionsError ? (
                    <Text style={styles.emptyText}>{sessionsError}</Text>
                ) : sessions.length === 0 ? (
                    <Text style={styles.emptyText}>{t('session.resumeSheetEmpty')}</Text>
                ) : (
                    sessions.map((s) => {
                        const isSelected = s.sessionId === selectedId;
                        const title = s.summary ?? s.firstUserMessage ?? t('session.resumeSheetNoPreview');
                        const preview = title.trim().replace(/\s+/g, ' ');
                        const truncated = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
                        const metaParts = [formatRelativeTime(s.timestamp)];
                        if (s.gitBranch) metaParts.push(s.gitBranch);
                        metaParts.push(s.cwd);

                        return (
                            <Pressable
                                key={s.sessionId}
                                onPress={() => setSelectedId(s.sessionId)}
                                style={({ pressed }) => [
                                    styles.row,
                                    isSelected && styles.rowSelected,
                                    pressed && styles.rowPressed,
                                ]}
                            >
                                <Text style={styles.rowText} numberOfLines={3}>
                                    {truncated}
                                </Text>
                                <Text style={styles.rowMeta} numberOfLines={1}>
                                    {metaParts.join(' · ')}
                                </Text>
                            </Pressable>
                        );
                    })
                )}
            </ScrollView>

            <View style={styles.actions}>
                <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [styles.button, styles.buttonSecondary, pressed && styles.buttonPressed]}
                >
                    <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    onPress={doResume}
                    disabled={loading || !selected}
                    style={({ pressed }) => [
                        styles.button,
                        styles.buttonPrimary,
                        (loading || !selected) && styles.buttonDisabled,
                        pressed && styles.buttonPressed,
                    ]}
                >
                    <Text style={styles.buttonPrimaryText}>
                        {loading ? t('common.loading') : t('session.resumeSheetConfirm')}
                    </Text>
                </Pressable>
            </View>
        </MobileGlassSurface>
    );
});

function formatRelativeTime(timestampMs: number): string {
    const diffMs = Date.now() - timestampMs;
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return t('time.justNow');
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    const days = Math.floor(hours / 24);
    return t('time.daysAgo', { count: days });
}

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: Platform.select({
            web: theme.colors.surface,
            ios: theme.colors.glass.overlay,
            android: theme.colors.glass.backgroundStrong,
            default: theme.colors.surface,
        }),
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: Platform.OS === 'web' ? 0 : StyleSheet.hairlineWidth,
        borderColor: theme.colors.glass.border,
        alignSelf: 'center',
        minWidth: 0,
    },
    header: {
        paddingHorizontal: 20,
        paddingTop: 20,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        fontWeight: '600' as const,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 4,
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    list: {
        flexGrow: 0,
        flexShrink: 1,
        maxHeight: 420,
        minHeight: 0,
    },
    listContent: {
        paddingVertical: 8,
    },
    emptyText: {
        textAlign: 'center',
        color: theme.colors.textSecondary,
        paddingVertical: 32,
        paddingHorizontal: 20,
        fontSize: 14,
    },
    row: {
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    rowSelected: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowPressed: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    rowText: {
        fontSize: 14,
        color: theme.colors.text,
        lineHeight: 19,
    },
    rowMeta: {
        marginTop: 4,
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    loadingContainer: {
        paddingVertical: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    actions: {
        flexDirection: 'row',
        gap: 8,
        padding: 16,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    button: {
        flex: 1,
        paddingVertical: Platform.select({ ios: 11, default: 12 }),
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonPressed: {
        opacity: 0.7,
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    buttonPrimary: {
        backgroundColor: theme.colors.button.primary.background,
    },
    buttonSecondary: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    buttonPrimaryText: {
        color: theme.colors.button.primary.tint,
        fontSize: 15,
        fontWeight: '600' as const,
    },
    buttonSecondaryText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '500' as const,
    },
}));
