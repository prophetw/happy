import * as React from 'react';
import { Keyboard, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { DirectoryBrowser } from './DirectoryBrowser';
import { PickerSheet, PickerSheetOption } from './PickerSheet';

type Props = Omit<React.ComponentProps<typeof DirectoryBrowser>, 'onRequestCustomPath'> & {
    visible: boolean;
    onClose: () => void;
};

/** The iOS project picker keeps search, browsing and manual entry in one keyboard-aware modal. */
export function ProjectDirectoryPicker({ visible, onClose, ...browser }: Props) {
    const { theme } = useUnistyles();
    const [customPath, setCustomPath] = React.useState<string | null>(null);
    const close = () => {
        setCustomPath(null);
        Keyboard.dismiss();
        onClose();
    };
    const chooseDirectory = (path: string) => {
        browser.onSelectDirectory(path);
        close();
    };
    const applyCustomPath = () => {
        if (customPath?.trim()) chooseDirectory(customPath.trim());
    };
    return (
        <PickerSheet visible={visible} avoidKeyboard
            title={t(customPath === null ? 'machineLauncher.allMachines' : 'machineLauncher.enterCustomPath')}
            onClose={close}>
            {customPath === null ? (
                <DirectoryBrowser
                    {...browser}
                    projectSearch={browser.projectSearch ? {
                        ...browser.projectSearch,
                        onSelect: (project) => { browser.projectSearch!.onSelect(project); close(); },
                    } : undefined}
                    onSelectDirectory={chooseDirectory}
                    onSelectRecent={(key) => { browser.onSelectRecent(key); close(); }}
                    onRequestCustomPath={() => setCustomPath(browser.initialPath ?? '~')}
                />
            ) : (
                <>
                    <View style={styles.inputWrap}>
                        <TextInput
                            autoFocus
                            value={customPath}
                            onChangeText={setCustomPath}
                            onSubmitEditing={applyCustomPath}
                            accessibilityLabel={t('machineLauncher.enterCustomPath')}
                            placeholder="~/path/to/project"
                            placeholderTextColor={theme.colors.textSecondary}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="done"
                            style={styles.input}
                        />
                    </View>
                    <PickerSheetOption label={t('machineLauncher.selectDirectory')} selected={false} action
                        disabled={!customPath.trim()} onPress={applyCustomPath} />
                    <PickerSheetOption label={t('common.back')} selected={false} action onPress={() => setCustomPath(null)} />
                </>
            )}
        </PickerSheet>
    );
}

const styles = StyleSheet.create((theme) => ({
    inputWrap: { paddingHorizontal: 24, paddingVertical: 8 },
    input: { minHeight: 48, borderRadius: 12, paddingHorizontal: 12, color: theme.colors.text,
        backgroundColor: theme.colors.surfaceHigh, fontSize: 15, ...Typography.default() },
}));
