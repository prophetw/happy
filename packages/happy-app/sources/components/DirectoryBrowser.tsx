import * as React from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useMachineDirectory } from '@/hooks/useMachineDirectory';
import { getDirectoryBrowserPath, getParentDirectory, joinDirectoryPath } from '@/utils/directoryBrowser';
import { formatDirectorySearchOption, searchDirectoryOptions } from '@/utils/directorySearch';
import { PickerSheetOption, PickerSheetSection } from './PickerSheet';
import type { ProjectSearchOption } from '@/sync/recentProjects';
import { projectPlaceKey } from '@/sync/agentSessionPlaces';

type DirectorySearchCandidate = {
    key: string;
    name: string;
    description?: string | null;
    recent: boolean;
    project?: ProjectSearchOption;
};

/** Render inside PickerSheetPanel so navigation and recent paths share one scroll area. */
export function DirectoryBrowser(props: {
    machineId: string | null;
    homeDir?: string;
    initialPath: string | null;
    recentPaths: { key: string; name: string; description?: string | null }[];
    selectedKey?: string | null;
    /** iOS offers projects from every computer alongside browsing the selected computer. */
    projectSearch?: {
        options: readonly ProjectSearchOption[];
        machineId: string | null;
        onSelect: (project: ProjectSearchOption) => void;
    };
    onSelectDirectory: (path: string) => void;
    onSelectRecent: (key: string) => void;
    onRequestCustomPath: () => void;
}) {
    const { theme } = useUnistyles();
    const [path, setPath] = React.useState(() => getDirectoryBrowserPath(props.initialPath, props.homeDir));
    const [query, setQuery] = React.useState('');
    const [showParentDirectories, setShowParentDirectories] = React.useState(false);
    React.useEffect(() => {
        setPath(getDirectoryBrowserPath(props.initialPath, props.homeDir));
        setQuery('');
        setShowParentDirectories(false);
    }, [props.machineId, props.initialPath, props.homeDir]);
    const navigate = (destination: string) => {
        setPath(destination);
        setQuery('');
        setShowParentDirectories(false);
    };
    const parent = path ? getParentDirectory(path) : null;
    const currentListing = useMachineDirectory(props.machineId, path);
    const parentListing = useMachineDirectory(props.machineId, parent);
    const recentPaths = React.useMemo(() => props.recentPaths.map(formatDirectorySearchOption), [props.recentPaths]);
    const results = React.useMemo(() => {
        const candidates: DirectorySearchCandidate[] = props.projectSearch
            ? props.projectSearch.options.map((project) => ({ ...project, recent: true, project }))
            : recentPaths.map((recent) => ({ ...recent, recent: true }));
        const seen = new Set(props.projectSearch
            ? props.projectSearch.options.filter((project) => project.machineId === props.projectSearch!.machineId && project.path)
                .map((project) => project.path!)
            : candidates.map((candidate) => candidate.key));
        for (const [directory, listing] of [[path, currentListing], [parent, parentListing]] as const) {
            if (!directory) continue;
            for (const entry of listing.directories) {
                const key = joinDirectoryPath(directory, entry.name);
                if (key === path || seen.has(key)) continue;
                seen.add(key);
                candidates.push({ key, name: entry.name, description: key, recent: false });
            }
        }
        return searchDirectoryOptions(candidates, query);
    }, [recentPaths, path, parent, currentListing.directories, parentListing.directories, query, props.projectSearch]);
    const searching = query.trim().length > 0;

    const renderProject = (project: ProjectSearchOption) => (
        <PickerSheetOption
            key={project.key}
            testID="directory-project-result"
            label={project.name}
            description={`${project.machineName} · ${t(project.online ? 'status.online' : 'status.offline')}${project.path ? `\n${project.path}` : ''}`}
            selected={project.machineId === props.projectSearch?.machineId
                && ((project.path !== null && project.path === props.selectedKey)
                    || (!!project.projectId && projectPlaceKey(project.projectId) === props.selectedKey))}
            onPress={() => props.projectSearch?.onSelect(project)}
        />
    );

    const renderNavigation = (label: string, destination: string, icon: 'folder-outline' | 'arrow-up-outline') => (
        <Pressable
            key={destination}
            onPress={() => navigate(destination)}
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
            <View style={styles.search}>
                <View style={styles.searchRow}>
                    <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                    <TextInput
                        autoFocus={props.projectSearch !== undefined}
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('machineLauncher.searchDirectories')}
                        accessibilityLabel={t('machineLauncher.searchDirectories')}
                        placeholderTextColor={theme.colors.textSecondary}
                        style={styles.searchInput}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                    />
                    {query.length > 0 && (
                        <Pressable
                            onPress={() => setQuery('')}
                            accessibilityRole="button"
                            accessibilityLabel={t('machineLauncher.clearDirectorySearch')}
                            style={styles.clear}
                        >
                            <Ionicons name="close-circle" size={20} color={theme.colors.textSecondary} />
                        </Pressable>
                    )}
                </View>
                <Text style={styles.statusText}>
                    {props.projectSearch ? `${t('machineLauncher.allMachines')} · ` : ''}{t('machineLauncher.directorySearchScope')}
                </Text>
            </View>
            {searching ? (
                <>
                    {results.map((result) => result.project ? renderProject(result.project) : (
                        <PickerSheetOption
                            key={result.key}
                            label={result.name}
                            description={result.description}
                            selected={result.key === props.selectedKey}
                            onPress={() => result.recent ? props.onSelectRecent(result.key) : props.onSelectDirectory(result.key)}
                        />
                    ))}
                    {(currentListing.loading || parentListing.loading) && <ActivityIndicator style={styles.status} color={theme.colors.textSecondary} />}
                    {results.length === 0 && !currentListing.loading && !parentListing.loading && (
                        <Text style={[styles.status, styles.statusText]}>{t('machineLauncher.noMatchingDirectories')}</Text>
                    )}
                    {[currentListing, parentListing].map((listing, index) => listing.error ? (
                        <View key={index} style={styles.status}>
                            <Text style={styles.statusText}>{listing.error}</Text>
                            <Pressable onPress={listing.retry} accessibilityRole="button" style={styles.retry}>
                                <Text style={styles.rowLabel}>{t('common.retry')}</Text>
                            </Pressable>
                        </View>
                    ) : null)}
                </>
            ) : (
                <>
                    {(props.projectSearch ? props.projectSearch.options.length > 0 : recentPaths.length > 0) && (
                        <>
                            <PickerSheetSection title={t('machineLauncher.recentDirectories')} />
                            {props.projectSearch ? props.projectSearch.options.map(renderProject) : recentPaths.map((recent) => (
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
                                    <Pressable
                                        onPress={() => setShowParentDirectories((value) => !value)}
                                        accessibilityRole="button"
                                        accessibilityLabel={t('machineLauncher.parentDirectories')}
                                        accessibilityState={{ expanded: showParentDirectories }}
                                        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                                    >
                                        <Text style={styles.rowLabel}>{t('machineLauncher.parentDirectories')}</Text>
                                        <Ionicons name={showParentDirectories ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
                                    </Pressable>
                                    {showParentDirectories && (
                                        <>
                                            <Text style={styles.parentPath} numberOfLines={1}>{parent}</Text>
                                            {renderListing(parentListing, parent, true)}
                                        </>
                                    )}
                                </>
                            )}
                        </>
                    ) : (
                        <Text style={[styles.status, styles.statusText]}>{t('machineLauncher.directoryUnavailable')}</Text>
                    )}
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
    search: { paddingHorizontal: 24, paddingVertical: 8, gap: 8 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, backgroundColor: theme.colors.surfacePressedOverlay, paddingLeft: 12 },
    searchInput: { flex: 1, minWidth: 0, minHeight: 48, color: theme.colors.text, fontSize: 15, ...Typography.default() },
    clear: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
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
