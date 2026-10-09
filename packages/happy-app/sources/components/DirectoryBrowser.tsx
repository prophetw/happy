import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useMachineDirectory } from '@/hooks/useMachineDirectory';
import { getDirectoryBrowserPath, getParentDirectory, joinDirectoryPath } from '@/utils/directoryBrowser';
import { PickerSheetOption, PickerSheetSection } from './PickerSheet';

/** Render inside PickerSheetPanel so navigation and recent paths share one scroll area. */
export function DirectoryBrowser(props: {
    machineId: string | null;
    homeDir?: string;
    initialPath: string | null;
    recentPaths: { key: string; name: string; description?: string | null }[];
    selectedKey?: string | null;
    onSelectDirectory: (path: string) => void;
    onSelectRecent: (key: string) => void;
    onRequestCustomPath: () => void;
}) {
    const { theme } = useUnistyles();
    const [path, setPath] = React.useState(() => getDirectoryBrowserPath(props.initialPath, props.homeDir));
    React.useEffect(() => {
        setPath(getDirectoryBrowserPath(props.initialPath, props.homeDir));
    }, [props.machineId, props.initialPath, props.homeDir]);
    const parent = path ? getParentDirectory(path) : null;
    const currentListing = useMachineDirectory(props.machineId, path);
    const parentListing = useMachineDirectory(props.machineId, parent);

    const renderNavigation = (label: string, destination: string, icon: 'folder-outline' | 'arrow-up-outline') => (
        <Pressable
            key={destination}
            onPress={() => setPath(destination)}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
            <Ionicons name={icon} size={20} color={theme.colors.textSecondary} />
            <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
            <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} />
        </Pressable>
    );

    const renderListing = (listing: ReturnType<typeof useMachineDirectory>, directory: string, siblings = false) => (
        <>
            {listing.loading ? <ActivityIndicator style={styles.status} color={theme.colors.textSecondary} /> : listing.error ? (
                <View style={styles.status}>
                    <Text style={styles.statusText}>{t('machineLauncher.directoryUnavailable')}</Text>
                    <Text style={styles.statusText}>{listing.error}</Text>
                    <Pressable onPress={listing.retry} accessibilityRole="button" style={styles.retry}>
                        <Text style={styles.rowLabel}>{t('common.retry')}</Text>
                    </Pressable>
                </View>
            ) : (
                <>
                    {listing.directories.filter((entry) => !siblings || joinDirectoryPath(directory, entry.name) !== path)
                        .map((entry) => renderNavigation(entry.name, joinDirectoryPath(directory, entry.name), 'folder-outline'))}
                    {!siblings && listing.directories.length === 0 && (
                        <Text style={[styles.status, styles.statusText]}>{t('machineLauncher.noSubdirectories')}</Text>
                    )}
                </>
            )}
        </>
    );

    return (
        <>
            {props.machineId && path ? (
                <>
                    <View style={styles.currentPath}>
                        <Text style={styles.pathText} numberOfLines={2}>{path}</Text>
                        <Pressable
                            onPress={() => props.onSelectDirectory(path)}
                            disabled={currentListing.loading || !!currentListing.error}
                            accessibilityRole="button"
                            accessibilityLabel={t('machineLauncher.selectDirectory')}
                            style={({ pressed }) => [styles.select, (currentListing.loading || !!currentListing.error) && styles.disabled, pressed && styles.pressed]}
                        >
                            <Ionicons name="checkmark" size={18} color={theme.colors.text} />
                            <Text style={styles.rowLabel}>{t('machineLauncher.selectDirectory')}</Text>
                        </Pressable>
                    </View>
                    {parent && renderNavigation(t('machineLauncher.parentDirectory'), parent, 'arrow-up-outline')}
                    <PickerSheetSection title={t('machineLauncher.subdirectories')} />
                    {renderListing(currentListing, path)}
                    {parent && (
                        <>
                            <PickerSheetSection title={t('machineLauncher.parentDirectories')} separated />
                            <Text style={styles.parentPath} numberOfLines={1}>{parent}</Text>
                            {renderListing(parentListing, parent, true)}
                        </>
                    )}
                </>
            ) : (
                <Text style={[styles.status, styles.statusText]}>{t('machineLauncher.directoryUnavailable')}</Text>
            )}
            {props.recentPaths.length > 0 && (
                <>
                    <PickerSheetSection title={t('machineLauncher.recentDirectories')} separated />
                    {props.recentPaths.map((recent) => (
                        <PickerSheetOption
                            key={recent.key}
                            label={recent.name}
                            description={recent.description}
                            selected={recent.key === props.selectedKey}
                            onPress={() => props.onSelectRecent(recent.key)}
                        />
                    ))}
                </>
            )}
            <PickerSheetSection separated />
            <PickerSheetOption
                label={t('machineLauncher.enterCustomPath')}
                selected={false}
                action
                onPress={props.onRequestCustomPath}
            />
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    currentPath: { paddingHorizontal: 24, paddingVertical: 8, gap: 8 },
    pathText: { color: theme.colors.text, fontSize: 14, ...Typography.mono() },
    select: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 12, borderRadius: 12, backgroundColor: theme.colors.surfacePressedOverlay },
    disabled: { opacity: 0.45 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 48, paddingHorizontal: 24, paddingVertical: 8 },
    rowLabel: { flex: 1, minWidth: 0, color: theme.colors.text, fontSize: 16, ...Typography.default() },
    pressed: { backgroundColor: theme.colors.surfacePressedOverlay },
    status: { paddingHorizontal: 24, paddingVertical: 12, gap: 4 },
    statusText: { color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
    retry: { minHeight: 48, justifyContent: 'center' },
    parentPath: { paddingHorizontal: 24, color: theme.colors.textSecondary, fontSize: 12, ...Typography.mono() },
}));
