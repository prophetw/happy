import React, { useRef, useState, useSyncExternalStore } from 'react';
import { View, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { RoundButton } from '@/components/RoundButton';
import { Switch } from '@/components/Switch';
import { Modal } from '@/modal';
import { layout } from '@/components/layout';
import { t } from '@/text';
import {
    getServerUrl,
    setServerUrl,
    validateServerUrl,
    getServerInfo,
    setUseCustomServerForVoice,
    shouldUseCustomServerForVoice,
} from '@/sync/serverConfig';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { cancelRelayMigration, getRelayMigrationStatus, subscribeRelayMigrations, type RelayMigrationTask } from '@/sync/relayMigrations';
import { normalizeServerUrl } from '@slopus/happy-wire/serverUrl';
import { checkServerConnection } from '@/sync/checkServerConnection';
import { useAuth } from '@/auth/AuthContext';

const stylesheet = StyleSheet.create((theme) => ({
    keyboardAvoidingView: {
        flex: 1,
    },
    itemListContainer: {
        flex: 1,
    },
    contentContainer: {
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        paddingHorizontal: 16,
        paddingVertical: 12,
        width: '100%',
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
    },
    labelText: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    textInput: {
        backgroundColor: Platform.select({ web: theme.colors.input.background, default: theme.colors.surfaceHigh }),
        paddingHorizontal: 14,
        paddingVertical: 12,
        minHeight: 44,
        borderRadius: 10,
        marginBottom: 8,
        ...Typography.mono(),
        fontSize: 15,
        color: theme.colors.input.text,
    },
    textInputValidating: {
        opacity: 0.6,
    },
    errorText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textDestructive,
        marginBottom: 12,
    },
    validatingText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.status.connecting,
        marginBottom: 12,
    },
    buttonColumn: {
        gap: 4,
        marginTop: 4,
        marginBottom: 12,
    },
    statusText: {
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export default function ServerConfigScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const auth = useAuth();
    const serverInfo = getServerInfo();
    const [inputUrl, setInputUrl] = useState(serverInfo.isCustom ? getServerUrl() : '');
    const [isCustomServer, setIsCustomServer] = useState(serverInfo.isCustom);
    const [useCustomServerForVoice, setUseCustomServerForVoiceState] = useState(shouldUseCustomServerForVoice());
    const [error, setError] = useState<string | null>(null);
    const [isValidating, setIsValidating] = useState(false);
    const [cancellingTask, setCancellingTask] = useState<string | null>(null);
    const switching = useRef(false);
    const migration = useSyncExternalStore(subscribeRelayMigrations, getRelayMigrationStatus, getRelayMigrationStatus);

    const handleSave = async () => {
        if (!inputUrl.trim()) {
            Modal.alert(t('common.error'), t('server.enterServerUrl'));
            return;
        }

        const validation = validateServerUrl(inputUrl);
        if (!validation.valid) {
            setError(validation.error || t('errors.invalidFormat'));
            return;
        }

        await applyServer(inputUrl);
    };

    const applyServer = async (url: string | null) => {
        if (switching.current || cancellingTask) return;
        if (url !== null && normalizeServerUrl(url) === getServerUrl()) return;
        switching.current = true;
        setIsValidating(true);
        setError(null);
        try {
            if (url !== null) {
                const result = await checkServerConnection(url);
                if (!result.valid) {
                    setError(result.error === 'connection' ? t('server.failedToConnectToServer')
                        : result.error === 'response' ? t('server.serverReturnedError')
                        : t('server.notValidHappyServer'));
                    return;
                }
            }
            await auth.switchServer(url);
            setInputUrl(getServerUrl());
            setIsCustomServer(getServerInfo().isCustom);
        } catch (error) {
            setError(error instanceof Error ? error.message : t('errors.operationFailed'));
        } finally {
            switching.current = false;
            setIsValidating(false);
        }
    };

    const handleReset = async () => {
        await applyServer(null);
    };

    const handleUseCustomServerForVoice = (enabled: boolean) => {
        setUseCustomServerForVoice(enabled);
        setUseCustomServerForVoiceState(enabled);
    };

    const handleStopReconnecting = async (task: RelayMigrationTask) => {
        if (switching.current || cancellingTask) return;
        const confirmed = await Modal.confirm(
            t('server.relayMigrationStop'),
            `${task.name}\n\n${t('server.relayMigrationStopDescription')}`,
            { confirmText: t('server.relayMigrationStop'), destructive: true },
        );
        if (!confirmed) return;
        setCancellingTask(`${task.kind}:${task.entityId}`);
        try {
            await cancelRelayMigration(task);
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed'));
        } finally {
            setCancellingTask(null);
        }
    };

    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: t('server.title'),
                    headerTitleAlign: 'center',
                    headerBackTitle: t('common.back'),
                }}
            />

            <KeyboardAvoidingView 
                style={styles.keyboardAvoidingView}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <ItemList style={styles.itemListContainer}>
                    <ItemGroup footer={t('server.selfHostFooter')}>
                        <View style={styles.contentContainer}>
                            <Text style={styles.labelText}>{t('server.serverUrlLabel').toUpperCase()}</Text>
                            <TextInput
                                style={[
                                    styles.textInput,
                                    isValidating && styles.textInputValidating
                                ]}
                                value={inputUrl}
                                onChangeText={(text) => {
                                    setInputUrl(text);
                                    setError(null);
                                }}
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                                editable={!isValidating}
                            />
                            {error && (
                                <Text style={styles.errorText}>
                                    {error}
                                </Text>
                            )}
                            {isValidating && (
                                <Text style={styles.validatingText}>
                                    {t('server.validatingServer')}
                                </Text>
                            )}
                            {migration.pending > 0 && (
                                <Text style={styles.statusText}>
                                    {t('server.relayMigrationPending', { count: migration.pending })}
                                </Text>
                            )}
                            {migration.lastError && (
                                <Text style={styles.statusText}>{migration.lastError}</Text>
                            )}
                            <View style={styles.buttonColumn}>
                                <RoundButton
                                    title={isValidating ? t('server.validating') : t('common.save')}
                                    size="normal"
                                    action={handleSave}
                                    disabled={isValidating || cancellingTask !== null}
                                />
                                {isCustomServer && (
                                    <RoundButton
                                        title={t('server.resetToDefault')}
                                        size="normal"
                                        display="inverted"
                                        onPress={handleReset}
                                        disabled={isValidating || cancellingTask !== null}
                                    />
                                )}
                            </View>
                            {isCustomServer && (
                                <Text style={styles.statusText}>
                                    {t('server.currentlyUsingCustomServer')}
                                </Text>
                            )}
                        </View>
                    </ItemGroup>

                    {migration.tasks.length > 0 && (
                        <ItemGroup title={t('server.relayMigrationTasks')} footer={t('server.relayMigrationTasksHint')}>
                            {migration.tasks.map(task => (
                                <Item
                                    key={`${task.kind}:${task.entityId}`}
                                    title={task.name}
                                    subtitle={task.lastError ?? undefined}
                                    detail={t('server.relayMigrationStop')}
                                    onPress={() => { void handleStopReconnecting(task); }}
                                    loading={cancellingTask === `${task.kind}:${task.entityId}`}
                                    disabled={isValidating || cancellingTask !== null}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>
                    )}

                    {isCustomServer && (
                        <ItemGroup
                            title={t('server.services')}
                            footer={t('server.customServerVoiceFooter')}
                        >
                            <Item
                                title={t('server.useCustomServerForVoice')}
                                subtitle={useCustomServerForVoice
                                    ? t('server.customServerVoiceEnabled')
                                    : t('server.customServerVoiceDisabled')}
                                icon={<Ionicons name="mic-outline" size={29} color="#34C759" />}
                                rightElement={
                                    <Switch
                                        value={useCustomServerForVoice}
                                        onValueChange={handleUseCustomServerForVoice}
                                    />
                                }
                                showChevron={false}
                            />
                        </ItemGroup>
                    )}

                    </ItemList>
            </KeyboardAvoidingView>
        </>
    );
}
