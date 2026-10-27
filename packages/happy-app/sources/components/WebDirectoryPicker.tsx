import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useMachineDirectory } from '@/hooks/useMachineDirectory';
import { getDirectoryBreadcrumbs, getDirectoryBrowserPath, getParentDirectory, joinDirectoryPath, parseDirectoryInput } from '@/utils/directoryBrowser';
import { formatDirectorySearchOption, searchDirectoryOptions } from '@/utils/directorySearch';
import type { DirectoryPickerProps } from './DirectoryPicker';

type Props = DirectoryPickerProps & { onClose: () => void };
type Candidate = { key: string; name: string; description?: string | null; recent: boolean };
type Selection = { kind: 'recent'; key: string; name: string; path: string | null }
    | { kind: 'directory'; path: string; manual?: boolean };

function initialSelection(props: Props): Selection | null {
    if (props.selectedKey?.startsWith('project:')) {
        const project = props.recentPaths.find((entry) => entry.key === props.selectedKey);
        return { kind: 'recent', key: props.selectedKey, name: project?.name ?? props.selectedKey, path: null };
    }
    const path = getDirectoryBrowserPath(props.initialPath, props.homeDir);
    return path ? { kind: 'directory', path } : null;
}

/** Web keeps navigation local; only the footer commits a directory or project identity. */
export function WebDirectoryPicker(props: Props) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const narrow = width < 720;
    const [selection, setSelection] = React.useState(() => initialSelection(props));
    const [query, setQuery] = React.useState('');
    const [tab, setTab] = React.useState<'recent' | 'browse'>('browse');
    const [editing, setEditing] = React.useState(false);
    const [inputPath, setInputPath] = React.useState('');
    const [inputError, setInputError] = React.useState(false);
    const [highlighted, setHighlighted] = React.useState(-1);
    const search = React.useRef<TextInput>(null);
    const rows = React.useRef(new Map<string, View>());
    const path = selection?.path ? getDirectoryBrowserPath(selection.path, props.homeDir) : null;
    const parent = path ? getParentDirectory(path) : null;
    const listing = useMachineDirectory(props.machineId, path);
    const siblings = useMachineDirectory(props.machineId, parent);
    const searching = query.trim().length > 0;

    React.useEffect(() => {
        setSelection(initialSelection(props));
        setQuery('');
        setEditing(false);
        setInputError(false);
        setHighlighted(-1);
        setTab('browse');
    }, [props.machineId, props.machineKey, props.initialPath, props.homeDir, props.selectedKey]);

    const recent = React.useMemo(() => props.recentPaths.map((entry) => ({
        ...formatDirectorySearchOption(entry),
        ...(entry.name === '~' ? { name: t('common.home'), description: props.homeDir ?? entry.key } : {}),
        recent: true,
    })), [props.recentPaths, props.homeDir]);
    const directories = React.useMemo<Candidate[]>(() => !path ? [] : listing.directories.map((entry) => ({
        key: joinDirectoryPath(path, entry.name), name: entry.name, recent: false,
    })), [path, listing.directories]);
    const results = React.useMemo(() => {
        const candidates: Candidate[] = [...recent];
        const seen = new Set(recent.map((entry) => entry.key));
        for (const [base, entries] of [[path, listing.directories], [parent, siblings.directories]] as const) {
            if (!base) continue;
            for (const entry of entries) {
                const key = joinDirectoryPath(base, entry.name);
                if (key === path || seen.has(key)) continue;
                seen.add(key);
                candidates.push({ key, name: entry.name, description: key, recent: false });
            }
        }
        return searchDirectoryOptions(candidates, query);
    }, [recent, path, parent, listing.directories, siblings.directories, query]);
    const visibleRows = searching ? results : narrow && tab === 'recent' ? recent : directories;
    const identity = selection?.kind === 'recent' && selection.key.startsWith('project:');
    const canConfirm = !!selection && !editing && (selection.kind === 'recent' || selection.manual
        || (!!props.machineId && !listing.loading && !listing.error));
    const confirm = () => {
        if (!canConfirm || !selection) return;
        if (selection.kind === 'recent') props.onSelectRecent(selection.key);
        else props.onSelectDirectory(selection.path);
    };
    const navigate = (destination: string, manual = false) => {
        setSelection({ kind: 'directory', path: destination, manual });
        setQuery('');
        setTab('browse');
        setHighlighted(-1);
        setEditing(false);
        search.current?.focus();
    };
    const visit = (candidate: Candidate) => {
        if (candidate.recent) {
            setSelection({ kind: 'recent', key: candidate.key, name: candidate.name,
                path: candidate.key.startsWith('project:') ? null : parseDirectoryInput(candidate.key, props.homeDir) });
            setQuery('');
            setTab('browse');
            setHighlighted(-1);
            setEditing(false);
            search.current?.focus();
        } else navigate(candidate.key);
    };
    const editPath = () => {
        setInputPath(selection?.path ?? props.initialPath ?? '~');
        setInputError(false);
        setEditing(true);
        setTab('browse');
    };
    const applyPath = () => {
        const next = parseDirectoryInput(inputPath, props.homeDir);
        if (!next) { setInputError(true); return; }
        navigate(next, true);
    };
    const onKeyDownCapture = (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (!editing) confirm();
            return;
        }
        const target = event.target as HTMLElement;
        const inList = target.getAttribute?.('data-testid') === 'directory-search'
            || !!target.closest?.('[data-testid="directory-results"]');
        if (editing || !inList) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            const next = Math.max(0, Math.min(visibleRows.length - 1,
                highlighted < 0 ? (event.key === 'ArrowDown' ? 0 : visibleRows.length - 1)
                    : highlighted + (event.key === 'ArrowDown' ? 1 : -1)));
            setHighlighted(next);
            const node = rows.current.get(visibleRows[next]?.key) as unknown as HTMLElement | undefined;
            node?.scrollIntoView?.({ block: 'nearest' });
        } else if (event.key === 'Enter' && visibleRows[highlighted < 0 ? 0 : highlighted]) {
            event.preventDefault();
            event.stopPropagation();
            visit(visibleRows[highlighted < 0 ? 0 : highlighted]);
        }
    };
    const renderRow = (entry: Candidate, index: number, keyboard = true) => (
        <DirectoryRow key={entry.key} entry={entry}
            active={(selection?.kind === 'recent' && selection.key === entry.key)
                || (!!path && entry.recent && path === parseDirectoryInput(entry.key, props.homeDir))
                || (keyboard && highlighted === index)}
            rowRef={keyboard ? (node) => { if (node) rows.current.set(entry.key, node); else rows.current.delete(entry.key); } : undefined}
            onFocus={() => { if (keyboard) setHighlighted(index); }}
            onPress={() => visit(entry)} />
    );
    const empty = (icon: keyof typeof Ionicons.glyphMap, title: string, detail?: string) => (
        <View style={styles.empty} accessibilityLiveRegion="polite">
            <Ionicons name={icon} size={32} color={theme.colors.textSecondary} />
            <Text style={styles.emptyTitle}>{title}</Text>
            {detail && <Text style={styles.emptyDetail}>{detail}</Text>}
        </View>
    );
    const readError = (value: typeof listing) => (
        <View style={styles.error} accessibilityRole="alert">
            <Text style={styles.secondary}>{t('machineLauncher.directoryUnavailable')}</Text>
            <Text selectable style={styles.secondary}>{value.error}</Text>
            <Pressable onPress={value.retry} accessibilityRole="button" accessibilityLabel={t('common.retry')} style={styles.textButton}>
                <Text style={styles.link}>{t('common.retry')}</Text>
            </Pressable>
        </View>
    );

    return <Modal visible transparent animationType="fade" onRequestClose={props.onClose}
        onShow={() => search.current?.focus()}>
        <View style={[styles.overlay, narrow && styles.overlayNarrow]}>
            <Pressable style={styles.scrim} onPress={props.onClose} accessibilityRole="button"
                accessibilityLabel={t('common.cancel')} />
            <View testID="web-directory-dialog" accessibilityViewIsModal accessibilityLabel={t('directoryPicker.title')}
                {...{ onKeyDownCapture }} style={[styles.dialog, { height: Math.max(0, Math.min(640, height - (narrow ? 16 : 48))) }]}>
                <View style={styles.header}>
                    <View style={styles.headerCopy}>
                        <Text accessibilityRole="header" style={styles.title}>{t('directoryPicker.title')}</Text>
                        {props.machineName && <View style={styles.machine}>
                            <Ionicons name="desktop-outline" size={13} color={theme.colors.textSecondary} />
                            <Text numberOfLines={1} style={[styles.secondary, { flexShrink: 1 }]}>{props.machineName}</Text>
                        </View>}
                    </View>
                    <Pressable onPress={props.onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')}
                        testID="close-directory-picker" style={({ pressed }) => [styles.iconButton, pressed && styles.hover]}>
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
                <View style={styles.searchArea}>
                    <View style={styles.searchRow}>
                        <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
                        <TextInput ref={search} autoFocus testID="directory-search" value={query} style={styles.searchInput}
                            placeholder={t('machineLauncher.searchDirectories')} placeholderTextColor={theme.colors.textSecondary}
                            accessibilityLabel={t('machineLauncher.searchDirectories')} autoCapitalize="none" autoCorrect={false}
                            blurOnSubmit={false} onChangeText={(value) => { setQuery(value); setHighlighted(-1); }} />
                        {!!query && <Pressable onPress={() => { setQuery(''); setHighlighted(-1); search.current?.focus(); }}
                            accessibilityRole="button" accessibilityLabel={t('machineLauncher.clearDirectorySearch')} style={styles.iconButton}>
                            <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                        </Pressable>}
                    </View>
                    <Text style={styles.hint}>{t('machineLauncher.directorySearchScope')}</Text>
                </View>
                {narrow && !searching && <View style={styles.tabs} accessibilityRole="tablist">
                    {(['recent', 'browse'] as const).map((value) => <Pressable key={value} onPress={() => { setTab(value); setHighlighted(-1); }}
                        accessibilityRole="tab" accessibilityLabel={t(value === 'recent' ? 'machineLauncher.recentDirectories' : 'directoryPicker.browse')}
                        accessibilityState={{ selected: tab === value }} style={[styles.tab, tab === value && styles.tabActive]}>
                        <Text style={tab === value ? styles.link : styles.secondary}>{t(value === 'recent' ? 'machineLauncher.recentDirectories' : 'directoryPicker.browse')}</Text>
                    </Pressable>)}
                </View>}
                <View style={styles.body}>
                    {!narrow && <View style={styles.sidebar}>
                        <Text style={styles.sectionTitle}>{t('machineLauncher.recentDirectories')}</Text>
                        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                            {recent.map((entry, index) => renderRow(entry, index, false))}
                            {!recent.length && <Text style={styles.sidebarEmpty}>{t('directoryPicker.noRecent')}</Text>}
                        </ScrollView>
                    </View>}
                    <View style={styles.main}>
                        {(!narrow || tab === 'browse' || searching) && <View style={styles.navigation}>
                            {editing ? <View style={styles.pathEditor}>
                                <TextInput autoFocus selectTextOnFocus value={inputPath} testID="directory-path-input" style={styles.pathInput}
                                    accessibilityLabel={t('machineLauncher.enterCustomPath')} autoCapitalize="none" autoCorrect={false}
                                    placeholder="~/path/to/project" placeholderTextColor={theme.colors.textSecondary}
                                    onChangeText={(value) => { setInputPath(value); setInputError(false); }} onSubmitEditing={applyPath} />
                                <Pressable onPress={applyPath} accessibilityRole="button" accessibilityLabel={t('directoryPicker.go')} style={styles.iconButton}>
                                    <Ionicons name="arrow-forward" size={18} color={theme.colors.textLink} />
                                </Pressable>
                                <Pressable onPress={() => setEditing(false)} accessibilityRole="button" accessibilityLabel={t('common.cancel')} style={styles.iconButton}>
                                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                                </Pressable>
                            </View> : <View style={styles.pathRow}>
                                <Pressable onPress={() => { if (parent) navigate(parent); }} disabled={!parent}
                                    accessibilityRole="button" accessibilityLabel={t('machineLauncher.parentDirectory')}
                                    style={[styles.iconButton, !parent && styles.disabled]}>
                                    <Ionicons name="arrow-up" size={17} color={theme.colors.textSecondary} />
                                </Pressable>
                                <ScrollView horizontal style={styles.breadcrumbs} contentContainerStyle={styles.crumbContent}>
                                    {path ? getDirectoryBreadcrumbs(path).map((crumb, index, all) => <React.Fragment key={crumb.path}>
                                        {index > 0 && <Ionicons name="chevron-forward" size={12} color={theme.colors.textSecondary} />}
                                        <Pressable onPress={() => navigate(crumb.path)} accessibilityRole="button" accessibilityLabel={crumb.path} style={styles.crumb}>
                                            <Text style={[styles.secondary, index === all.length - 1 && styles.currentCrumb]}>{crumb.label}</Text>
                                        </Pressable>
                                    </React.Fragment>) : <Text style={styles.secondary}>{t('directoryPicker.browse')}</Text>}
                                </ScrollView>
                                <Pressable onPress={editPath} accessibilityRole="button" accessibilityLabel={t('directoryPicker.editPath')} style={styles.iconButton}>
                                    <Ionicons name="pencil-outline" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            </View>}
                            {inputError && editing && <Text accessibilityRole="alert" style={styles.validation}>{t('directoryPicker.invalidPath')}</Text>}
                        </View>}
                        <ScrollView style={styles.scroll} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" testID="directory-results">
                            {searching ? <>
                                {results.map((entry, index) => renderRow(entry, index))}
                                {!results.length && !listing.loading && !siblings.loading && empty('search-outline', t('machineLauncher.noMatchingDirectories'), t('directoryPicker.searchEmptyHint'))}
                                {(listing.loading || siblings.loading) && <ActivityIndicator style={styles.loading} color={theme.colors.textSecondary} />}
                                {listing.error && readError(listing)}
                                {siblings.error && readError(siblings)}
                            </> : narrow && tab === 'recent' ? <>
                                {recent.map((entry, index) => renderRow(entry, index))}
                                {!recent.length && empty('time-outline', t('directoryPicker.noRecent'))}
                            </> : identity ? empty('folder-outline', selection.name, t('directoryPicker.catalogHint'))
                                : !props.machineId || !path ? empty('cloud-offline-outline', t('machineLauncher.directoryUnavailable'), t('directoryPicker.unavailableHint'))
                                    : listing.loading ? <ActivityIndicator style={styles.loading} color={theme.colors.textSecondary} />
                                        : listing.error ? readError(listing) : <>
                                            {directories.map((entry, index) => renderRow(entry, index))}
                                            {!directories.length && empty('folder-open-outline', t('machineLauncher.noSubdirectories'), t('directoryPicker.emptyHint'))}
                                        </>}
                        </ScrollView>
                        <Pressable onPress={editPath} accessibilityRole="button" accessibilityLabel={t('machineLauncher.enterCustomPath')} style={styles.manualEntry}>
                            <Ionicons name="terminal-outline" size={15} color={theme.colors.textLink} />
                            <Text style={styles.link}>{t('machineLauncher.enterCustomPath')}</Text>
                        </Pressable>
                    </View>
                </View>
                <View style={[styles.footer, narrow && styles.footerNarrow]}>
                    <View style={styles.selection} accessibilityLiveRegion="polite">
                        <Text style={styles.hint}>{t('directoryPicker.willUse')}</Text>
                        <Text testID="directory-pending-path" selectable numberOfLines={1} style={styles.selectedPath}>
                            {selection?.path ?? (selection?.kind === 'recent' ? selection.name : t('directoryPicker.nothingSelected'))}
                        </Text>
                        {selection?.kind === 'directory' && selection.manual && <Text style={styles.hint}>{t('directoryPicker.manualHint')}</Text>}
                    </View>
                    <View style={styles.actions}>
                        <Pressable onPress={props.onClose} accessibilityRole="button" accessibilityLabel={t('common.cancel')} style={styles.cancel}>
                            <Text style={styles.secondary}>{t('common.cancel')}</Text>
                        </Pressable>
                        <Pressable onPress={confirm} disabled={!canConfirm} accessibilityRole="button"
                            accessibilityLabel={t(identity ? 'directoryPicker.selectProject' : 'machineLauncher.selectDirectory')}
                            testID="confirm-directory" style={({ pressed }) => [styles.confirm, !canConfirm && styles.disabled, pressed && styles.confirmPressed]}>
                            <Ionicons name="checkmark" size={16} color="#fff" />
                            <Text style={styles.confirmLabel}>{t(identity ? 'directoryPicker.selectProject' : 'machineLauncher.selectDirectory')}</Text>
                        </Pressable>
                    </View>
                </View>
            </View>
        </View>
    </Modal>;
}

function DirectoryRow({ entry, active, onPress, onFocus, rowRef }: {
    entry: Candidate; active: boolean; onPress: () => void; onFocus: () => void; rowRef?: (node: View | null) => void;
}) {
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    return <Pressable ref={rowRef} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        onFocus={() => { setFocused(true); onFocus(); }} onBlur={() => setFocused(false)} accessibilityRole="button"
        accessibilityLabel={[entry.name, entry.description].filter(Boolean).join(', ')} accessibilityState={{ selected: active }}
        testID="directory-row" style={({ pressed }) => [styles.row, (hovered || pressed) && styles.hover, active && styles.activeRow, focused && styles.focusedRow]}>
        <Ionicons name="folder-outline" size={18} color={active ? theme.colors.textLink : theme.colors.textSecondary} />
        <View style={styles.rowCopy}>
            <Text numberOfLines={1} style={styles.rowName}>{entry.name}</Text>
            {!!entry.description && <Text numberOfLines={1} style={styles.hint}>{entry.description}</Text>}
        </View>
        <Ionicons name="chevron-forward" size={13} color={theme.colors.textSecondary} />
    </Pressable>;
}

const styles = StyleSheet.create((theme) => ({
    overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    overlayNarrow: { padding: 8 },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.48)' },
    dialog: { width: '100%', maxWidth: 900, minHeight: 0, borderRadius: 18, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, overflow: 'hidden', boxShadow: '0px 24px 80px rgba(0,0,0,0.25)' },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8, gap: 12 },
    headerCopy: { flex: 1, minWidth: 0, gap: 5 },
    title: { fontSize: 18, color: theme.colors.text, ...Typography.default('semiBold') },
    machine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    secondary: { fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    hint: { fontSize: 12, lineHeight: 18, color: theme.colors.textSecondary, ...Typography.default() },
    searchArea: { paddingHorizontal: 20, paddingBottom: 12, gap: 6 },
    searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 12, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, backgroundColor: theme.colors.input.background },
    searchInput: { flex: 1, minWidth: 0, height: 40, fontSize: 14, color: theme.colors.text, ...Typography.default() },
    iconButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8, cursor: 'pointer' },
    body: { flex: 1, minHeight: 0, flexDirection: 'row', borderTopWidth: 1, borderColor: theme.colors.divider },
    sidebar: { width: 220, minHeight: 0, borderRightWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh },
    sectionTitle: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, fontSize: 12, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    sidebarEmpty: { padding: 16, fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() },
    main: { flex: 1, minWidth: 0, minHeight: 0 },
    scroll: { flex: 1, minHeight: 0 },
    listContent: { padding: 8, flexGrow: 1 },
    navigation: { paddingHorizontal: 8, paddingVertical: 6, borderBottomWidth: 1, borderColor: theme.colors.divider },
    pathRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    breadcrumbs: { flex: 1, minWidth: 0 },
    crumbContent: { alignItems: 'center', gap: 2 },
    crumb: { paddingHorizontal: 5, paddingVertical: 8, borderRadius: 6, cursor: 'pointer' },
    currentCrumb: { color: theme.colors.text, ...Typography.default('semiBold') },
    pathEditor: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.colors.input.background, borderWidth: 1, borderColor: theme.colors.textLink, borderRadius: 8 },
    pathInput: { flex: 1, minWidth: 0, height: 36, paddingHorizontal: 10, color: theme.colors.text, fontSize: 13, ...Typography.mono() },
    validation: { padding: 8, fontSize: 12, color: theme.colors.text, ...Typography.default() },
    row: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: 'transparent', borderRadius: 8, cursor: 'pointer' },
    rowCopy: { flex: 1, minWidth: 0, gap: 2 },
    rowName: { fontSize: 14, color: theme.colors.text, ...Typography.default() },
    hover: { backgroundColor: theme.colors.surfacePressed },
    activeRow: { backgroundColor: theme.colors.surfaceSelected },
    focusedRow: { borderColor: theme.colors.textLink },
    empty: { flex: 1, minHeight: 150, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
    emptyTitle: { color: theme.colors.text, fontSize: 14, textAlign: 'center', ...Typography.default('semiBold') },
    emptyDetail: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'center', maxWidth: 320, ...Typography.default() },
    error: { padding: 16, gap: 8 },
    loading: { padding: 32 },
    textButton: { alignSelf: 'flex-start', paddingVertical: 8, cursor: 'pointer' },
    link: { color: theme.colors.textLink, fontSize: 13, ...Typography.default() },
    manualEntry: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderColor: theme.colors.divider, cursor: 'pointer' },
    footer: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderColor: theme.colors.divider },
    footerNarrow: { flexDirection: 'column', alignItems: 'stretch', gap: 12, paddingHorizontal: 16 },
    selection: { flex: 1, minWidth: 0, gap: 2 },
    selectedPath: { color: theme.colors.text, fontSize: 12, lineHeight: 18, ...Typography.mono() },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
    cancel: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, cursor: 'pointer' },
    confirm: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, minHeight: 40, borderRadius: 8, backgroundColor: theme.colors.radio.active, cursor: 'pointer' },
    confirmLabel: { fontSize: 13, color: '#fff', ...Typography.default('semiBold') },
    confirmPressed: { opacity: 0.8 },
    disabled: { opacity: 0.4, cursor: 'auto' },
    tabs: { flexDirection: 'row', gap: 4, paddingHorizontal: 16, paddingBottom: 8 },
    tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, cursor: 'pointer' },
    tabActive: { backgroundColor: theme.colors.surfaceSelected },
}));
