import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DirectoryBrowser } from './DirectoryBrowser';
import { PickerSheet } from './PickerSheet';

/** Opens the remote machine's directories without changing the draft while browsing. */
export function DirectoryPicker(props: React.ComponentProps<typeof DirectoryBrowser>) {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(false);

    return (
        <>
            <Pressable
                onPress={() => setVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={t('machineLauncher.directoryPickerTitle')}
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
            >
                <Ionicons name="folder-open-outline" size={18} color={theme.colors.textSecondary} />
                <Text style={styles.label}>{t('machineLauncher.directoryPickerTitle')}</Text>
            </Pressable>
            {visible && (
                <PickerSheet
                    visible
                    title={t('machineLauncher.directoryPickerTitle')}
                    onClose={() => setVisible(false)}
                >
                    <DirectoryBrowser
                        {...props}
                        key={props.machineId ?? 'no-machine'}
                        onSelectDirectory={(path) => {
                            setVisible(false);
                            props.onSelectDirectory(path);
                        }}
                        onSelectRecent={(key) => {
                            setVisible(false);
                            props.onSelectRecent(key);
                        }}
                        onRequestCustomPath={() => {
                            setVisible(false);
                            props.onRequestCustomPath();
                        }}
                    />
                </PickerSheet>
            )}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    label: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    pressed: { backgroundColor: theme.colors.surfacePressedOverlay },
}));
