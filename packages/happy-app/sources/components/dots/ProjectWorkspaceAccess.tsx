import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { storage, useAllMachines } from '@/sync/storage';
import { workspaceManagerClient, workspaceManagerRpcClient } from '@/sync/workspaceManagement';
import { t } from '@/text';
import { WorkspaceManagerPanel } from './WorkspaceManagerPanel';

type Props = {
    token: string;
    current: () => boolean;
    contextKey: string;
    onClose: () => void;
    openSession: (id: string) => void;
    initialProjectID?: string;
    originalRequestID?: string;
    originalMachineID?: string;
};

export function ProjectWorkspaceAccess({ token, current, contextKey, onClose, openSession,
    initialProjectID, originalRequestID, originalMachineID }: Props) {
    const { theme } = useUnistyles();
    const native = Platform.OS !== 'web';
    const paired = useAllMachines({ includeOffline: true });
    const candidates = paired.filter(machine => originalMachineID ? machine.id === originalMachineID
        : machine.metadata?.workspaceOwnerVersion === 1);
    const [selectedID, select] = React.useState('');
    const machine = candidates.find(candidate => candidate.id === selectedID)
        ?? (candidates.length === 1 ? candidates[0] : undefined);
    const machineID = native ? machine?.id : undefined;
    const scope = React.useCallback(() => current() && (!native
        || (!!machineID && !!storage.getState().machines[machineID])), [current, native, machineID]);
    const client = React.useMemo(() => native
        ? machineID && workspaceManagerRpcClient(machineID, scope, (id, method, request) => apiSocket.machineRPC(id, method, request))
        : workspaceManagerClient(token, scope), [native, machineID, scope, token]);

    const button = (label: string, action: () => void, active = false) =>
        <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected: active }}
            onPress={action} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12,
                borderWidth: 1, borderRadius: 10, borderColor: active ? theme.colors.textLink : theme.colors.divider }}>
            <Text style={{ color: theme.colors.text }}>{label}</Text>
        </Pressable>;
    const picker = native && candidates.length > 1 && <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.textSecondary }}>{t('workspaces.chooseMachine')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {candidates.map(candidate => <React.Fragment key={candidate.id}>
                {button(candidate.metadata?.displayName || candidate.metadata?.host || candidate.id,
                    () => select(candidate.id), machineID === candidate.id)}
            </React.Fragment>)}
        </View>
    </View>;

    // Both entry points present a full-screen surface with its own header. This
    // is the only native inset consumer; scroll content stays inside that view.
    return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        {client
            ? <WorkspaceManagerPanel key={machineID ?? 'web'} client={client} current={scope} contextKey={contextKey}
                onClose={onClose} openSession={openSession} initialProjectID={initialProjectID}
                originalRequestID={originalRequestID} machinePicker={picker}/>
            : <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ padding: 18, gap: 16 }}>
                <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 26, fontWeight: '600' }}>
                    {t('workspaces.title')}
                </Text>
                {picker || <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>
                    {t(originalMachineID ? 'workspaces.reasons.WORKSPACE_MACHINE_UNAVAILABLE' : 'workspaces.noPairedOwner')}
                </Text>}
                {button(t('workspaces.close'), onClose)}
            </ScrollView>}
    </SafeAreaView></SafeAreaProvider>;
}
