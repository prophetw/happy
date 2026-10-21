import React from 'react';
import { View, Pressable, FlatList, NativeScrollEvent, NativeSyntheticEvent, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { usePathname, useRouter } from 'expo-router';
import { SessionListViewItem, SessionRowData, useAllMachines, useSetting, useSettingMutable } from '@/sync/storage';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { type SessionState, formatLastSeen, vibingMessages } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { ActiveSessionsGroupCompact } from './ActiveSessionsGroupCompact';
import { ProjectGroup } from './ProjectGroup';
import { FlatSessionRow, flatListBackgroundColor } from './FlatSessionRow';
import { buildFlatSessionRows, toFlatSessionRow, type FlatSessionRowData } from '@/utils/flatSessionList';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHasArchivedSessions, useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { SessionStatusBadge } from './SessionStatusBadge';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useIsTablet } from '@/utils/responsive';
import { getHarnessName } from '@/utils/harnessCatalog';
import { requestReview } from '@/utils/requestReview';
import { HomeListHeader } from './HomeListHeader';
import { layout } from './layout';
import { useSessionPressHandlers } from '@/hooks/useNavigateToSession';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { t } from '@/text';
import { SessionShortcutHintBadge } from './ShortcutHints';
import { ProviderIcon } from './ProviderIcon';
import { buildSessionProjectDisplayGroups } from '@/utils/sessionDisplayOrder';
import { isMachineOnline } from '@/utils/machineUtils';

const MACHINE_ACCENT_COLORS = ['#3B82F6', '#8B5CF6', '#14B8A6', '#D97706'];

type SessionListDisplayItem = SessionListViewItem | {
    type: 'machine-header';
    machineId: string | null;
    machineName: string;
    accentColor: string;
    online: boolean | null;
    projectCount: number;
    sessionCount: number;
} | {
    type: 'machine-project';
    item: Extract<SessionListViewItem, { type: 'project' }>;
    accentColor: string;
    last: boolean;
} | {
    type: 'archive-toggle';
    hidden: boolean;
    /** Sits inside the grey heading band rather than floating on the page. */
    banded?: boolean;
} | {
    type: 'flat-session';
    row: FlatSessionRowData;
    last: boolean;
    archived?: boolean;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
        backgroundColor: theme.colors.groupped.background,
    },
    // The flat variant removes the card/backdrop split entirely, so the page
    // takes the same colour the rows do.
    containerFlat: {
        backgroundColor: flatListBackgroundColor(theme),
    },
    contentContainer: {
        flex: 1,
        maxWidth: layout.maxWidth,
    },
    headerSection: {
        backgroundColor: theme.colors.groupped.background,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 8,
    },
    // A date heading in the flat list is just a label sitting between rows, so
    // it drops the grey band and keeps the one background the variant uses.
    headerSectionFlat: {
        backgroundColor: flatListBackgroundColor(theme),
        paddingHorizontal: 16,
    },
    archiveToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 12,
    },
    // In the flat list the toggle heads the archive rather than dividing the
    // page. It sits between the rows on the same background they use — the
    // variant has no grey band anywhere.
    archiveToggleBanded: {
        backgroundColor: flatListBackgroundColor(theme),
        paddingTop: 24,
        paddingBottom: 8,
    },
    archiveTogglePressed: {
        opacity: 0.5,
    },
    archiveToggleLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    archiveToggleText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    headerText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.groupped.sectionTitle,
        letterSpacing: 0.1,
        ...Typography.default('semiBold'),
    },
    machineHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
        paddingBottom: 0,
    },
    machineHeaderLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    machineHeaderText: {
        maxWidth: '60%',
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginRight: 4,
        ...Typography.default('regular'),
    },
    // Continue the device outline across list cells so projects stay virtualized.
    webMachineFrame: {
        marginHorizontal: 10,
        backgroundColor: theme.colors.surfaceHigh,
        borderLeftWidth: 1,
        borderRightWidth: 1,
    },
    webMachineHeaderFrame: {
        marginTop: 8,
        borderTopWidth: 1,
        borderTopLeftRadius: 14,
        borderTopRightRadius: 14,
        overflow: 'hidden',
    },
    webMachineHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        padding: 10,
        minHeight: 64,
    },
    webMachineHeaderPressed: {
        backgroundColor: theme.colors.surfaceRipple,
    },
    webMachineIcon: {
        width: 36,
        height: 36,
        borderRadius: 10,
        borderWidth: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    webMachineHeading: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    webMachineName: {
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    webMachineMeta: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    webMachineStatusDot: {
        width: 5,
        height: 5,
        borderRadius: 3,
    },
    webMachineSummary: {
        flex: 1,
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    webMachineProject: {
        paddingHorizontal: 7,
    },
    webMachineProjectLast: {
        borderBottomWidth: 1,
        borderBottomLeftRadius: 14,
        borderBottomRightRadius: 14,
        paddingBottom: 2,
        marginBottom: 8,
        overflow: 'hidden',
    },
    projectGroup: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: Platform.select({ web: theme.colors.surface, default: theme.colors.surfaceHigh }),
    },
    projectGroupTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    projectGroupSubtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    sessionItem: {
        height: 88,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        backgroundColor: 'transparent',
    },
    sessionItemContainer: {
        marginHorizontal: 16,
        marginBottom: 1,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface,
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderColor: theme.colors.divider,
    },
    sessionItemFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
    },
    sessionItemSingle: {
        borderRadius: 12,
    },
    sessionItemContainerFirst: {
        borderTopLeftRadius: 12,
        borderTopRightRadius: 12,
    },
    sessionItemContainerLast: {
        borderBottomLeftRadius: 12,
        borderBottomRightRadius: 12,
        marginBottom: 12,
    },
    sessionItemContainerSingle: {
        borderRadius: 12,
        marginBottom: 12,
    },
    sessionItemSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        marginLeft: 16,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 2,
    },
    sessionTitle: {
        fontSize: 15,
        fontWeight: '500',
        flex: 1,
        ...Typography.default('semiBold'),
    },
    sessionShortcutBadge: {
        flexShrink: 0,
        marginLeft: 8,
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    sessionSubtitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
    },
    sessionSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDotContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        height: 16,
        marginTop: 2,
        marginRight: 4,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    avatarContainer: {
        position: 'relative',
        width: 48,
        height: 48,
    },
    draftIconContainer: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        width: 18,
        height: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    draftIconOverlay: {
        color: theme.colors.textSecondary,
    },
    artifactsSection: {
        paddingHorizontal: 16,
        paddingBottom: 12,
        backgroundColor: Platform.select({ web: theme.colors.groupped.background, default: 'transparent' }),
    },
    phoneUpdateBanner: {
        paddingBottom: 16,
    },
    phoneUpdateBannerHeader: {
        paddingTop: 4,
    },
}));

const MachineHeader = React.memo(({ machineId, machineName, accentColor, online, projectCount, sessionCount }: {
    machineId: string | null;
    machineName: string;
    accentColor: string;
    online: boolean | null;
    projectCount: number;
    sessionCount: number;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const handlePress = React.useCallback(() => {
        if (machineId) {
            router.navigate(`/machine/${machineId}` as any);
        }
    }, [machineId, router]);

    if (Platform.OS === 'web') {
        const statusColor = online ? theme.colors.status.connected : theme.colors.textSecondary;
        return (
            <View style={[styles.webMachineFrame, styles.webMachineHeaderFrame, { borderColor: `${accentColor}55` }]}>
                <LinearGradient
                    colors={[`${accentColor}${theme.dark ? '26' : '18'}`, `${accentColor}00`]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                >
                    <Pressable
                        onPress={handlePress}
                        disabled={!machineId}
                        accessibilityRole={machineId ? 'button' : undefined}
                        style={({ pressed }) => [styles.webMachineHeader, pressed && styles.webMachineHeaderPressed]}
                    >
                        <View style={[styles.webMachineIcon, { backgroundColor: `${accentColor}22`, borderColor: `${accentColor}66` }]}>
                            <Ionicons name="desktop-outline" size={20} color={accentColor} />
                        </View>
                        <View style={styles.webMachineHeading}>
                            <Text style={styles.webMachineName} numberOfLines={1}>{machineName}</Text>
                            <View style={styles.webMachineMeta}>
                                <View style={[styles.webMachineStatusDot, { backgroundColor: statusColor }]} />
                                <Text style={styles.webMachineSummary} numberOfLines={1}>
                                    <Text style={{ color: statusColor }}>
                                        {online === null ? t('status.unknown') : online ? t('status.online') : t('status.offline')}
                                    </Text>
                                    {` · ${projectCount} ${t('sidebar.projects')} · ${sessionCount} ${t('tabs.sessions')}`}
                                </Text>
                            </View>
                        </View>
                        {machineId && <Ionicons name="chevron-forward" size={14} color={theme.colors.textSecondary} />}
                    </Pressable>
                </LinearGradient>
            </View>
        );
    }

    return (
        <Pressable
            onPress={handlePress}
            disabled={!machineId}
            accessibilityRole={machineId ? 'button' : undefined}
            style={styles.machineHeader}
            hitSlop={{ top: 8, bottom: 8 }}
        >
            <View style={styles.machineHeaderLine} />
            <Ionicons
                name="desktop-outline"
                size={11}
                color={theme.colors.textSecondary}
                style={{ marginHorizontal: 6 }}
            />
            <Text style={styles.machineHeaderText} numberOfLines={1}>
                {machineName}
            </Text>
            <View style={styles.machineHeaderLine} />
        </Pressable>
    );
});

export function SessionsList({
    topContentInset = 0,
    scrollIndicatorTopInset = 0,
    bottomContentInset = 128,
    onScroll,
}: {
    topContentInset?: number;
    scrollIndicatorTopInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
} = {}) {
    const styles = stylesheet;
    const safeArea = useSafeAreaInsets();
    const sourceData = useVisibleSessionListViewData();
    const hasArchivedSessions = useHasArchivedSessions();
    // Stored under its original `hideInactiveSessions` key — synced settings
    // have no rename migration — but it hides archived sessions only.
    const [hideArchivedSessions, setHideArchivedSessions] = useSettingMutable('hideInactiveSessions');
    // The activity-sorted chat list is the default; the project-card hierarchy
    // is offered back through the home filter menu for people who organized
    // around it.
    const flatSessionList = useSetting('sessionListGrouping') !== 'project';
    const machines = useAllMachines({ includeOffline: Platform.OS === 'web' });
    const pathname = usePathname();
    const isTablet = useIsTablet();
    // Selection is derived once from pathname so the data array stays stable
    // across navigations. This keeps FlatList virtualization intact: only
    // the previously- and newly-selected rows re-render, instead of the
    // whole visible window.
    const selectedSessionId = React.useMemo<string | undefined>(() => {
        if (!isTablet) return undefined;
        if (!pathname.startsWith('/session/')) return undefined;
        return pathname.split('/')[2];
    }, [isTablet, pathname]);

    // Request review
    React.useEffect(() => {
        if (sourceData && sourceData.length > 0) {
            requestReview();
        }
    }, [sourceData && sourceData.length > 0]);

    const data = React.useMemo<SessionListDisplayItem[] | null>(() => {
        if (!sourceData) return sourceData;

        // The archive is a flat, date-grouped tail rather than extra rows
        // inside the project cards, so the toggle is the divider that opens
        // it and always sits directly above those rows.
        const archivedRows = sourceData.filter((item) => (
            item.type === 'header' || item.type === 'session'
        ));
        const groupedRows = sourceData.filter((item) => (
            item.type !== 'header' && item.type !== 'session'
        ));
        const archiveToggle: SessionListDisplayItem[] = hasArchivedSessions
            ? [{ type: 'archive-toggle', hidden: hideArchivedSessions }]
            : [];

        if (flatSessionList) {
            // A chat list should always float the thing the user just replied
            // to, so the canonical layout is ordered by recent activity.
            const flatRows = buildFlatSessionRows(groupedRows, { sortByActivity: true });
            const flatItems = flatRows.map<SessionListDisplayItem>((row, index) => ({
                type: 'flat-session',
                row,
                last: index === flatRows.length - 1,
            }));
            // The archive is the same column, only retired: its rows get the
            // flat row too rather than reverting to inset cards. The toggle
            // joins the date headings in their grey band, so opening the
            // archive extends that band instead of adding a second divider
            // style above it.
            const flatArchived = archivedRows.map<SessionListDisplayItem>((item, index) => (
                item.type === 'session'
                    ? {
                        type: 'flat-session',
                        row: toFlatSessionRow(item.session),
                        last: index === archivedRows.length - 1,
                        archived: true,
                    }
                    : item
            ));
            const flatToggle = archiveToggle.map<SessionListDisplayItem>((item) => (
                item.type === 'archive-toggle' ? { ...item, banded: true } : item
            ));
            return [...flatItems, ...flatToggle, ...flatArchived];
        }

        const machineGroups = buildSessionProjectDisplayGroups(
            groupedRows,
            machines,
            t('status.unknown'),
        );
        if (machineGroups.length === 0) {
            return [...groupedRows, ...archiveToggle, ...archivedRows];
        }

        const machinesById = new Map(machines.map((machine) => [machine.id, machine]));
        const hierarchy = machineGroups.flatMap<SessionListDisplayItem>((group, groupIndex) => {
            const accentColor = MACHINE_ACCENT_COLORS[groupIndex % MACHINE_ACCENT_COLORS.length];
            const machine = group.machineId ? machinesById.get(group.machineId) : null;
            return [{
                type: 'machine-header',
                machineId: group.machineId,
                machineName: group.machineName,
                accentColor,
                online: machine ? isMachineOnline(machine) : null,
                projectCount: group.projects.length,
                sessionCount: group.projects.reduce((count, item) => count + item.project.sessionCount, 0),
            }, ...group.projects.map<SessionListDisplayItem>((item, index) => (
                Platform.OS === 'web'
                    ? { type: 'machine-project', item, accentColor, last: index === group.projects.length - 1 }
                    : item
            ))];
        });
        const legacyItems = groupedRows.filter((item) => (
            item.type !== 'project' && item.type !== 'projects-header'
        ));
        return [...legacyItems, ...hierarchy, ...archiveToggle, ...archivedRows];
    }, [flatSessionList, hasArchivedSessions, hideArchivedSessions, machines, sourceData]);

    // Early return if no data yet
    if (!data) {
        return (
            <View style={[styles.container, flatSessionList && styles.containerFlat]} />
        );
    }

    const keyExtractor = React.useCallback((item: SessionListDisplayItem, index: number) => {
        switch (item.type) {
            case 'bots': return 'bots';
            case 'machine-header': return `machine-header-${JSON.stringify(item.machineId)}`;
            case 'machine-project': return `project-${item.item.source}-${item.item.project.machineId ?? 'unknown'}-${item.item.project.id}`;
            case 'archive-toggle': return 'archive-toggle';
            case 'flat-session': return `flat-session-${item.row.session.id}`;
            case 'header': return `header-${item.title}-${index}`;
            case 'active-sessions': return 'active-sessions';
            case 'project-group': return `project-group-${item.machine.id}-${item.displayPath}-${index}`;
            case 'projects-header': return `projects-header-${item.source}`;
            case 'project': return `project-${item.source}-${item.project.machineId ?? 'unknown'}-${item.project.id}`;
            case 'session': return `session-${item.session.id}`;
        }
    }, []);

    const renderItem = React.useCallback(({ item, index }: { item: SessionListDisplayItem, index: number }) => {
        switch (item.type) {
            case 'bots':
                return (
                    <View>
                        <View style={styles.headerSection}>
                            <Text style={styles.headerText}>Bots</Text>
                        </View>
                        {item.sessions.map((session, botIndex) => (
                            <FlatSessionRow
                                key={session.id}
                                row={toFlatSessionRow(session)}
                                selected={session.id === selectedSessionId}
                                showBorder={botIndex < item.sessions.length - 1}
                            />
                        ))}
                    </View>
                );
            case 'machine-header':
                return (
                    <MachineHeader
                        machineId={item.machineId}
                        machineName={item.machineName}
                        accentColor={item.accentColor}
                        online={item.online}
                        projectCount={item.projectCount}
                        sessionCount={item.sessionCount}
                    />
                );

            case 'machine-project':
                return (
                    <View style={[
                        styles.webMachineFrame,
                        styles.webMachineProject,
                        item.last && styles.webMachineProjectLast,
                        { borderColor: `${item.accentColor}55` },
                    ]}>
                        <ProjectGroup project={item.item.project} selectedSessionId={selectedSessionId} />
                    </View>
                );

            case 'flat-session':
                return (
                    <FlatSessionRow
                        row={item.row}
                        selected={item.row.session.id === selectedSessionId}
                        showBorder={!item.last}
                        archived={item.archived}
                    />
                );

            case 'archive-toggle':
                return (
                    <Pressable
                        onPress={() => setHideArchivedSessions(!item.hidden)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: !item.hidden }}
                        style={({ pressed }) => [
                            styles.archiveToggle,
                            item.banded && styles.archiveToggleBanded,
                            pressed && styles.archiveTogglePressed,
                        ]}
                    >
                        <View style={styles.archiveToggleLine} />
                        <Text style={styles.archiveToggleText}>
                            {item.hidden ? t('sidebar.showArchived') : t('sidebar.hideArchived')}
                        </Text>
                        <View style={styles.archiveToggleLine} />
                    </Pressable>
                );

            case 'header':
                return (
                    <View style={[styles.headerSection, flatSessionList && styles.headerSectionFlat]}>
                        <Text style={styles.headerText}>
                            {item.title}
                        </Text>
                    </View>
                );

            case 'active-sessions':
                return (
                    <ActiveSessionsGroupCompact
                        sessions={item.sessions}
                        selectedSessionId={selectedSessionId}
                    />
                );

            case 'projects-header':
                return (
                    <View style={styles.headerSection}>
                        <Text style={styles.headerText}>
                            {item.source === 'rig' ? getHarnessName('rig') : t('sidebar.sessionsTitle')}
                        </Text>
                    </View>
                );

            case 'project':
                return (
                    <ProjectGroup
                        project={item.project}
                        selectedSessionId={selectedSessionId}
                    />
                );

            case 'project-group':
                return (
                    <View style={styles.projectGroup}>
                        <Text style={styles.projectGroupTitle}>
                            {item.displayPath}
                        </Text>
                        <Text style={styles.projectGroupSubtitle}>
                            {item.machine.metadata?.displayName || item.machine.metadata?.host || item.machine.id}
                        </Text>
                    </View>
                );

            case 'session':
                // Determine card styling based on position within date group
                const prevItem = index > 0 ? data[index - 1] : null;
                const nextItem = index < data.length - 1 ? data[index + 1] : null;

                const isFirst = prevItem?.type === 'header';
                const isLast = nextItem?.type === 'header' || nextItem == null || nextItem?.type === 'active-sessions';
                const isSingle = isFirst && isLast;
                const selected = item.session.id === selectedSessionId;

                return (
                    <SessionItem
                        session={item.session}
                        selected={selected}
                        isFirst={isFirst}
                        isLast={isLast}
                        isSingle={isSingle}
                    />
                );
        }
    }, [selectedSessionId, data, flatSessionList]);


    // Remove this section as we'll use FlatList for all items now


    const HeaderComponent = React.useCallback(() => {
        const isPhoneLayout = topContentInset > 0;
        return (
            <HomeListHeader
                style={isPhoneLayout ? styles.phoneUpdateBanner : undefined}
                headerStyle={isPhoneLayout ? styles.phoneUpdateBannerHeader : undefined}
            />
        );
    }, [styles.phoneUpdateBanner, styles.phoneUpdateBannerHeader, topContentInset]);

    // Footer removed - all sessions now shown inline

    return (
        <View style={[styles.container, flatSessionList && styles.containerFlat]}>
            <View style={styles.contentContainer}>
                <FlatList
                    data={data}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    extraData={selectedSessionId}
                    contentContainerStyle={{
                        paddingTop: topContentInset,
                        paddingBottom: safeArea.bottom + bottomContentInset,
                        maxWidth: layout.maxWidth,
                    }}
                    ListHeaderComponent={HeaderComponent}
                    automaticallyAdjustsScrollIndicatorInsets={scrollIndicatorTopInset === 0}
                    scrollIndicatorInsets={scrollIndicatorTopInset > 0
                        ? { top: scrollIndicatorTopInset }
                        : undefined}
                    windowSize={5}
                    maxToRenderPerBatch={8}
                    initialNumToRender={12}
                    // FlatList defaults this on for Android only. Virtualization
                    // already unmounts offscreen rows; detaching the rest too
                    // only gives Android a second, divergent layout path.
                    removeClippedSubviews={false}
                    onScroll={onScroll}
                    scrollEventThrottle={16}
                />
            </View>
        </View>
    );
}

const STATUS_CONFIG: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    disconnected: { color: '#999', dotColor: '#999', isPulsing: false, isConnected: false },
    thinking: { color: '#007AFF', dotColor: '#007AFF', isPulsing: true, isConnected: true },
    waiting: { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
    permission_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
    input_required: { color: '#FF9500', dotColor: '#FF9500', isPulsing: true, isConnected: true },
};

const SessionItem = React.memo(({ session, selected, isFirst, isLast, isSingle }: {
    session: SessionRowData;
    selected?: boolean;
    isFirst?: boolean;
    isLast?: boolean;
    isSingle?: boolean;
}) => {
    const styles = stylesheet;
    const sessionPressHandlers = useSessionPressHandlers(session.id);
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const baseStatus = STATUS_CONFIG[session.state];
    const needsUserAction = session.state === 'permission_required' || session.state === 'input_required';
    // User action stays orange and pulsing even when the request also marked the session unread.
    const status = session.hasUnread && !needsUserAction
        ? { ...baseStatus, color: '#007AFF', dotColor: '#007AFF', isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [session.state]);

    const statusText = session.state === 'input_required'
        ? t('status.inputRequired')
        : session.state === 'permission_required'
            ? t('status.permissionRequired')
            : session.hasUnread
                ? t('status.unread')
                : session.state === 'thinking'
                    ? vibingMessage
                    : session.state === 'disconnected'
                        ? t('status.lastSeen', { time: formatLastSeen(session.activeAt!, false) })
                        : t('status.online');

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
    } as any : {
        onLongPress: showActionAlert,
    };

    return (
        <View style={[
            styles.sessionItemContainer,
            isSingle ? styles.sessionItemContainerSingle :
                isFirst ? styles.sessionItemContainerFirst :
                    isLast ? styles.sessionItemContainerLast : {}
        ]}>
        <Pressable
            style={[
                styles.sessionItem,
                selected && styles.sessionItemSelected,
                isSingle ? styles.sessionItemSingle :
                    isFirst ? styles.sessionItemFirst :
                        isLast ? styles.sessionItemLast : {}
            ]}
            {...sessionPressHandlers}
            {...menuProps}
        >
            <View style={styles.avatarContainer}>
                <Avatar bot={!!session.botId} id={session.avatarId} size={48} monochrome={!status.isConnected} flavor={session.flavor} clientId={session.clientId} imageUrl={session.avatarUri} thumbhash={session.avatarThumbhash} badgeLocation="sessionList" />
                {session.hasDraft && (
                    <View style={styles.draftIconContainer}>
                        <Ionicons
                            name="create-outline"
                            size={12}
                            style={styles.draftIconOverlay}
                        />
                    </View>
                )}
            </View>
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    <Text style={[
                        styles.sessionTitle,
                        status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                    ]} numberOfLines={1}>
                        {session.name}
                    </Text>
                    <SessionShortcutHintBadge
                        sessionId={session.id}
                        style={styles.sessionShortcutBadge}
                    />
                </View>

                {session.identityLine ? (
                    <View style={styles.sessionSubtitleRow}>
                        <ProviderIcon kind={session.providerKind} size={13} />
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.identityLine}
                        </Text>
                    </View>
                ) : session.path ? (
                    <View style={styles.sessionSubtitleRow}>
                        <Text style={styles.sessionSubtitle} numberOfLines={1}>
                            {session.path.split(/[/\\]/).filter(Boolean).pop()}
                        </Text>
                    </View>
                ) : (
                    <Text style={styles.sessionSubtitle} numberOfLines={1}>
                        {session.botId ? toFlatSessionRow(session).projectName : session.subtitle}
                    </Text>
                )}

                <View style={styles.statusRow}>
                    {(Platform.OS === 'web' || Platform.OS === 'ios') && !session.archived && !session.machineOffline && (needsUserAction || session.state === 'thinking' || session.hasUnread) ? (
                        <>
                            <SessionStatusBadge state={session.state} hasUnread={session.hasUnread} kind={session.attentionKind} />
                            {(session.modelName || session.activitySummary) && (
                                <Text style={[styles.statusText, { marginLeft: 6 }]}>
                                    {[session.modelName, session.activitySummary].filter(Boolean).join(' · ')}
                                </Text>
                            )}
                        </>
                    ) : (
                        <>
                            <View style={styles.statusDotContainer}>
                                <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />
                            </View>
                            <Text style={[
                                styles.statusText,
                                { color: status.color }
                            ]}>
                                {session.modelName ? `${session.modelName} · ` : ''}{statusText}{session.activitySummary ? ` · ${session.activitySummary}` : ''}
                            </Text>
                        </>
                    )}
                </View>
            </View>
        </Pressable>
        {Platform.OS === 'web' && (
            <SessionActionsPopover
                anchor={actionsAnchor}
                onClose={() => setActionsAnchor(null)}
                sessionId={session.id}
                visible={!!actionsAnchor}
            />
        )}
        </View>
    );
});
