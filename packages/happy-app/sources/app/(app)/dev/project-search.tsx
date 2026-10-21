import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import { ProjectDirectoryPicker } from '@/components/ProjectDirectoryPicker';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useRecentProjects } from '@/hooks/useRecentProjects';
import { useAllMachines, useSessions } from '@/sync/storage';
import { collectMachineChoices, findMachineChoice } from '@/sync/machineChoices';
import { collectProjectSearchOptions } from '@/sync/recentProjects';
import { projectPlaceKey } from '@/sync/agentSessionPlaces';
import type { Session } from '@/sync/storageTypes';
import { isMachineOnline } from '@/utils/machineUtils';
import { t } from '@/text';

/** Exercises iOS's shared sheet content with a real account; no fixtures ship in the app. */
export default function ProjectSearchPreview() {
    if (!__DEV__) return <Redirect href="/" />;
    return <ProjectSearchContent />;
}

function ProjectSearchContent() {
    const { theme } = useUnistyles();
    const [visible, setVisible] = React.useState(true);
    const machines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();
    const choices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const sessionList = React.useMemo(() => (sessions ?? []).filter((session): session is Session => typeof session !== 'string'), [sessions]);
    const history = useRecentProjects(sessionList, choices);
    const options = React.useMemo(() => collectProjectSearchOptions(history, choices), [history, choices]);
    const draft = useNewSessionDraft(useShallow((state) => ({
        machineId: state.selectedMachineId, path: state.selectedPath, projectId: state.selectedProjectId,
    })));
    const choice = findMachineChoice(choices, draft.machineId);
    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface, paddingTop: 24 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={t('machineLauncher.allMachines')}
                onPress={() => setVisible(true)} style={{ minHeight: 48, padding: 16 }}>
                <Text style={{ color: theme.colors.text }}>{t('machineLauncher.searchDirectories')} · {t('machineLauncher.allMachines')}</Text>
            </Pressable>
            <Text testID="selected-project-preview" style={{ color: theme.colors.text, padding: 16 }}>
                {choice?.name}{'\n'}{draft.path ?? draft.projectId}
            </Text>
            {visible && (
                <ProjectDirectoryPicker visible onClose={() => setVisible(false)}
                    machineId={choice?.happyMachine && isMachineOnline(choice.happyMachine) ? choice.happyMachine.id : null}
                    homeDir={choice?.happyMachine?.metadata?.homeDir}
                    initialPath={draft.path}
                    recentPaths={[]}
                    selectedKey={draft.projectId ? projectPlaceKey(draft.projectId) : draft.path}
                    projectSearch={{ options, machineId: choice?.id ?? null, onSelect: (project) => {
                        useNewSessionDraft.getState().selectPlace(project);
                    } }}
                    onSelectDirectory={(path) => useNewSessionDraft.getState().setPath(path)}
                    onSelectRecent={() => {}}
                />
            )}
        </View>
    );
}
