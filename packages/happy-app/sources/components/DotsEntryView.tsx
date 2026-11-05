import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { storage, useSession } from '@/sync/storage';
import { DotsWorkspacePanel } from '@/components/dots/DotsWorkspaceHome';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { createTestloopDotsNavigationGuard } from '@/sync/testloopDotsNavigation';
import { discoverDotsWorkspaces, matchesDotsWorkspace, type DotsWorkspaceChoice } from '@/sync/testloopDotsEntry';

type NavigationOperation = NonNullable<ReturnType<ReturnType<typeof createTestloopDotsNavigationGuard>['begin']>>;
type EntryState = { scope: object; phase: 'loading' | 'opening' | 'choices' | 'workspace' | 'empty' | 'error';
    workspaces: DotsWorkspaceChoice[]; unresolved: number };

export function DotsEntryView({ topContentInset = 0 }: { topContentInset?: number }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { workspace: requestedWorkspace } = useLocalSearchParams<{ workspace?: string }>();
    const auth = useAuth();
    const token = auth.credentials?.token;
    const secret = auth.credentials?.secret;
    const server = getServerUrl();
    // An opaque, view-local epoch prevents the previous account's choices from rendering after a switch.
    const scope = React.useMemo(() => ({}), [token, secret, server, auth.isAuthenticated]);
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const inFlight = React.useRef<AbortController | null>(null);
    const [state, setState] = React.useState<EntryState | null>(null);
    const sameAccount = React.useCallback(() => !!token && auth.isAuthenticated
        && sync.getCredentials()?.token === token && sync.getCredentials()?.secret === secret
        && getServerUrl() === server, [token, secret, server, auth.isAuthenticated]);

    const openWorkspace = React.useCallback(async (choice: DotsWorkspaceChoice, operation: NavigationOperation,
        controller: AbortController) => {
        const current = () => operation.isCurrent() && !controller.signal.aborted && sameAccount();
        await operation.afterReady(async () => {
            if (current()) await sync.ensureSessionReady(choice.sessionId);
        }, () => {
            if (!current()) return;
            if (!matchesDotsWorkspace(choice, storage.getState().sessions[choice.sessionId]))
                throw new Error('dots_entry_binding_changed');
            setState({ scope, phase: 'workspace', workspaces: [choice], unresolved: 0 });
        });
    }, [scope, sameAccount]);

    const refresh = React.useCallback(async () => {
        const operation = navigation.begin();
        if (!operation) return;
        inFlight.current?.abort();
        const controller = new AbortController(); inFlight.current = controller;
        const current = () => operation.isCurrent() && !controller.signal.aborted && sameAccount();
        setState({ scope, phase: 'loading', workspaces: [], unresolved: 0 });
        if (!sameAccount()) {
            setState({ scope, phase: 'error', workspaces: [], unresolved: 0 }); return;
        }
        try {
            const result = await discoverDotsWorkspaces({
                refreshSessions: signal => sync.refreshDotsSessions(signal),
                readSessions: () => Object.values(storage.getState().sessions),
                ensureSessionReady: id => sync.ensureSessionReady(id),
                readSession: id => storage.getState().sessions[id],
                isCurrent: current, signal: controller.signal,
            });
            if (result.canceled || !current()) return;
            const requested = result.workspaces.find(choice => choice.sessionId === requestedWorkspace);
            if (requested || result.workspaces.length === 1 && result.unresolved === 0 && !result.workspaces[0].archived) {
                setState({ scope, phase: 'opening', workspaces: result.workspaces, unresolved: 0 });
                await openWorkspace(requested ?? result.workspaces[0], operation, controller);
            } else {
                setState({ scope, phase: result.workspaces.length ? 'choices' : result.unresolved ? 'error' : 'empty',
                    workspaces: result.workspaces, unresolved: result.unresolved });
            }
        } catch {
            if (current()) setState({ scope, phase: 'error', workspaces: [], unresolved: 0 });
        }
    }, [navigation, sameAccount, scope, openWorkspace, requestedWorkspace]);

    useFocusEffect(React.useCallback(() => {
        navigation.update('dots-entry', true);
        void refresh();
        return () => { navigation.invalidate(); inFlight.current?.abort(); };
    }, [navigation, refresh]));

    const choose = async (choice: DotsWorkspaceChoice) => {
        const operation = navigation.begin();
        if (!operation || !sameAccount()) return;
        inFlight.current?.abort();
        const controller = new AbortController(); inFlight.current = controller;
        setState({ scope, phase: 'opening', workspaces: [choice], unresolved: 0 });
        try { await openWorkspace(choice, operation, controller); }
        catch {
            if (operation.isCurrent() && sameAccount() && !controller.signal.aborted)
                setState({ scope, phase: 'error', workspaces: [], unresolved: 0 });
        }
    };

    const view = state?.scope === scope ? state : null;
    if (view?.phase === 'workspace') return <WorkspaceEntry key={`${view.workspaces[0].workspaceId}:${view.workspaces[0].sessionId}`}
        choice={view.workspaces[0]} topContentInset={topContentInset} onRetry={() => void refresh()} />;
    const busy = !view || view.phase === 'loading' || view.phase === 'opening';
    const error = view?.phase === 'error';
    return <ScrollView testID="dots-entry-view" style={{ flex: 1, backgroundColor: theme.colors.surface }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 32 + topContentInset, paddingBottom: 48,
            width: '100%', maxWidth: 760, alignSelf: 'center', gap: 18 }}>
        {busy ? <View style={{ alignItems: 'center', paddingVertical: 36, gap: 16 }}>
            <ActivityIndicator color="#4f46e5" />
            <Text style={{ color: theme.colors.text, fontSize: 16 }}>{view?.phase === 'opening'
                ? '正在打开 Dots 工作台…' : '正在查找 Dots 工作台…'}</Text>
        </View> : view.phase === 'choices' ? <>
            <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 22, fontWeight: '600' }}>选择 Dots 工作台</Text>
            {!!view.unresolved && <Text accessibilityRole="alert" style={{ color: theme.colors.textSecondary }}>部分工作台暂时无法读取，可以重试查找。</Text>}
            {view.workspaces.map(choice => <Pressable key={choice.sessionId} accessibilityRole="button"
                accessibilityLabel={`打开 ${choice.title}`} testID={`dots-workspace-choice-${choice.sessionId}`}
                onPress={() => void choose(choice)} style={{ padding: 20, borderWidth: 1, borderColor: theme.colors.divider,
                    borderRadius: 14, gap: 8 }}>
                <Text style={{ color: theme.colors.text, fontSize: 17, fontWeight: '600' }}>{choice.title}</Text>
                {!!choice.dotNames.length && <Text style={{ color: theme.colors.textSecondary }}>{choice.dotNames.join('、')}</Text>}
                <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>{choice.archived ? '已归档 · 查看现有工作台' : '打开工作台 →'}</Text>
            </Pressable>)}
        </> : <View style={{ paddingVertical: 20, gap: 12 }}>
            <Text accessibilityRole={error ? 'alert' : 'header'} style={{ color: theme.colors.text, fontSize: 21, fontWeight: '600' }}>
                {error ? '暂时无法读取工作台，请检查网络后重试' : '当前账号尚未找到 Dots 工作台'}
            </Text>
            <Text style={{ color: theme.colors.textSecondary, lineHeight: 22 }}>请确认当前账号和服务器，也可以重试查找。</Text>
        </View>}
        <Pressable accessibilityRole="button" accessibilityLabel="重试查找工作台" testID="dots-entry-retry"
            onPress={() => void refresh()} style={{ alignItems: 'center', padding: 14, borderRadius: 10,
                backgroundColor: '#4f46e5', minHeight: 44 }}><Text style={{ color: '#fff', fontWeight: '600' }}>重试查找</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="检查账号和服务器" onPress={() => router.push('/server')}
            style={{ alignItems: 'center', padding: 12, minHeight: 44 }}><Text style={{ color: theme.colors.textSecondary }}>检查账号和服务器</Text></Pressable>
    </ScrollView>;
}

function WorkspaceEntry({ choice, topContentInset, onRetry }: { choice: DotsWorkspaceChoice; topContentInset: number; onRetry: () => void }) {
    const session = useSession(choice.sessionId);
    const active = useIsFocused();
    const { theme } = useUnistyles();
    if (!session || !matchesDotsWorkspace(choice, session)) return <View style={{ padding: 24, gap: 16 }}>
        <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>工作台绑定已变化，请重新读取。</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="重新读取工作台" onPress={onRetry}><Text style={{ color: theme.colors.text }}>重新读取</Text></Pressable>
    </View>;
    return <DotsWorkspacePanel session={session} workspaceId={choice.workspaceId} active={active} topInset={topContentInset} />;
}
