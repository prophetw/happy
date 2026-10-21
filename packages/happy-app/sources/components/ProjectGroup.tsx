import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ProjectGroupData, ProjectWorkspaceGroup, useSessionGitStatus } from '@/sync/storage';
import { CompactSessionRow } from './ActiveSessionsGroupCompact';
import { Avatar } from './Avatar';
import { requestHomeDockFocus } from './homeDockFocus';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { visibleRigGitLineChanges } from '@/utils/rigGitLineChanges';
import { GitLineChanges } from './GitLineChanges';
import { getRepoPath, isWorktreePath } from '@/utils/worktreePaths';

// Tall enough to span the name and branch lines together.
const HEADER_AVATAR_SIZE = Platform.OS === 'web' ? 28 : 30;
// Roughly 70% of the composer attachment "+": same feel, less presence in a
// list header. hitSlop keeps the touch target comfortable.
const ADD_BUTTON_SIZE = Platform.OS === 'web' ? 26 : 30;
const ADD_ICON_SIZE = 18;

interface ProjectGroupProps {
    project: ProjectGroupData;
    selectedSessionId?: string;
}

/**
 * One project and its sessions, split into the primary checkout and any named
 * worktrees reported by Rig or created through Happy. Each worktree gets its
 * own header and card: the worktree name reads as a second line under the
 * project, so the card itself stays a plain list of sessions.
 */
export const ProjectGroup = React.memo(({ project, selectedSessionId }: ProjectGroupProps) => {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            {project.workspaces.map((workspace) => (
                <WorkspaceSection
                    key={workspace.id || 'primary'}
                    project={project}
                    workspace={workspace}
                    selectedSessionId={selectedSessionId}
                />
            ))}
        </View>
    );
});

const WorkspaceSection = React.memo(({ project, workspace, selectedSessionId }: {
    project: ProjectGroupData;
    workspace: ProjectWorkspaceGroup;
    selectedSessionId?: string;
}) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const firstSession = workspace.sessions[0];
    const worktreeName = workspace.name ?? (workspace.id || null);

    // The branch line belongs to the checkout, so it reads from the live git
    // status the daemon reports, through the workspace's own name, down to the
    // "main" every repo has when nothing better is known.
    const gitStatus = useSessionGitStatus(firstSession?.id ?? '');
    const branchName = worktreeName
        ?? gitStatus?.branch
        ?? 'main';
    const liveInsertions = gitStatus?.unstagedLinesAdded ?? 0;
    const liveDeletions = gitStatus?.unstagedLinesRemoved ?? 0;
    const changes = liveInsertions > 0 || liveDeletions > 0
        ? { approximate: false, insertions: liveInsertions, deletions: liveDeletions }
        : firstSession && firstSession.gitChangedFiles !== null
            ? visibleRigGitLineChanges({
                changedFiles: firstSession.gitChangedFiles,
                countsExact: firstSession.gitCountsExact,
                deletions: firstSession.gitDeletions ?? 0,
                insertions: firstSession.gitInsertions ?? 0,
            })
            : null;

    // Point the draft at this exact checkout before opening the composer, so
    // the dock's machine, project and worktree rows already read correctly.
    // `setMachineId` clears the path and worktree, so the order matters.
    const handleNewSession = React.useCallback(() => {
        const draft = useNewSessionDraft.getState();
        const sessionPath = firstSession?.path ?? '';
        const worktree = isWorktreePath(sessionPath);
        const repoPath = worktree ? getRepoPath(sessionPath) : sessionPath;

        if (firstSession?.machineId) {
            draft.setMachineId(firstSession.machineId);
        }
        if (repoPath) {
            draft.setPath(formatPathRelativeToHome(repoPath, firstSession?.homeDir ?? undefined));
        }
        draft.setSessionType(worktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(worktree ? sessionPath : null);

        // Nothing is listening in the sidebar layout or on web, where the dock
        // is never mounted; those fall back to the standalone screen.
        if (!requestHomeDockFocus()) {
            router.navigate('/new');
        }
    }, [firstSession, router]);

    return (
        <View style={styles.section}>
            <View style={styles.header}>
                {firstSession && (
                    <Avatar id={firstSession.avatarId} size={HEADER_AVATAR_SIZE} flavor={null} imageUrl={firstSession.projectAvatarUri} thumbhash={firstSession.projectAvatarThumbhash} />
                )}
                <View style={styles.headerText}>
                    <Text style={styles.title} numberOfLines={1}>
                        {project.name}
                    </Text>
                    <View style={styles.branchLine}>
                        <Text style={styles.branchText} numberOfLines={1}>
                            {branchName}
                        </Text>
                        <GitLineChanges changes={changes} />
                    </View>
                </View>
                {Platform.OS === 'web' && (
                    <View style={styles.sessionCount}>
                        <Ionicons name="chatbubble-outline" size={10} color={theme.colors.textSecondary} />
                        <Text style={styles.sessionCountText}>{workspace.sessions.length}</Text>
                    </View>
                )}
                <Pressable
                    onPress={handleNewSession}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.newSession')}
                    style={({ pressed }) => [styles.addButton, pressed && styles.addButtonPressed]}
                >
                    <Ionicons name="add" size={ADD_ICON_SIZE} color={theme.colors.text} />
                </Pressable>
            </View>

            <View style={styles.workspaceCard}>
                {workspace.sessions.map((session, index) => (
                    <CompactSessionRow
                        key={session.id}
                        session={session}
                        selected={session.id === selectedSessionId}
                        showBorder={index < workspace.sessions.length - 1}
                    />
                ))}
            </View>
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: 'transparent',
        marginBottom: Platform.select({ web: 8, default: 4 }),
        gap: Platform.select({ web: 8, default: 0 }),
    },
    section: {
        backgroundColor: Platform.select({ web: theme.colors.surface, default: 'transparent' }),
        borderRadius: Platform.select({ web: 10, default: 0 }),
        borderWidth: Platform.select({ web: 1, default: 0 }),
        borderColor: theme.colors.divider,
        overflow: Platform.select({ web: 'hidden', default: 'visible' }),
    },
    // Pulled toward the screen edges: the "+" sits so its center shares an x
    // with the status dot inside the card rows below (see
    // trailingIndicatorSlot in ActiveSessionsGroupCompact). The right inset
    // compensates for the button being narrower than it once was.
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: Platform.select({ web: 8, default: 12 }),
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        paddingLeft: Platform.select({ web: 8, ios: 20, default: 16 }),
        paddingRight: Platform.select({ web: 8, ios: 26, default: 22 }),
        gap: 8,
    },
    headerText: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        color: Platform.select({ web: theme.colors.text, default: theme.colors.groupped.sectionTitle }),
        fontSize: Platform.select({ web: 13, ios: 13, default: 14 }),
        lineHeight: Platform.select({ web: 18, ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: Platform.select({ ios: 'normal', default: '500' }),
        ...Typography.default(Platform.OS === 'web' ? 'semiBold' : 'regular'),
    },
    branchLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    branchText: {
        flexShrink: 1,
        minWidth: 0,
        fontSize: Platform.select({ web: 11, default: 12 }),
        lineHeight: 16,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    // Filled like the composer's resting send button so it reads as a control,
    // not an ornament.
    addButton: {
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
        borderRadius: ADD_BUTTON_SIZE / 2,
        backgroundColor: theme.colors.surfaceHighest,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addButtonPressed: {
        opacity: 0.5,
    },
    sessionCount: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHighest,
    },
    sessionCountText: {
        fontSize: 10,
        lineHeight: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    workspaceCard: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: Platform.select({ web: 0, ios: 16, default: 12 }),
        marginBottom: Platform.select({ web: 0, default: 8 }),
        borderRadius: Platform.select({ web: 0, default: 18 }),
        borderWidth: Platform.select({ web: 0, default: StyleSheet.hairlineWidth }),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        overflow: 'hidden',
    },
}));
