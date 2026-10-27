import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DirectoryPickerProps } from './DirectoryPicker';
import { WebDirectoryPicker } from './WebDirectoryPicker';

export function DirectoryPicker(props: DirectoryPickerProps) {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(false);
    return <>
        <Pressable onPress={() => setVisible(true)} accessibilityRole="button"
            accessibilityLabel={t('machineLauncher.directoryPickerTitle')}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Ionicons name="folder-open-outline" size={18} color={theme.colors.textSecondary} />
            <Text style={styles.label}>{t('machineLauncher.directoryPickerTitle')}</Text>
        </Pressable>
        {visible && <WebDirectoryPicker {...props} onClose={() => setVisible(false)}
            onSelectDirectory={(path) => { setVisible(false); props.onSelectDirectory(path); }}
            onSelectRecent={(key) => { setVisible(false); props.onSelectRecent(key); }} />}
    </>;
}

const styles = StyleSheet.create((theme) => ({
    button: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 8, borderRadius: 8, cursor: 'pointer' },
    label: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    pressed: { backgroundColor: theme.colors.surfacePressedOverlay },
}));
