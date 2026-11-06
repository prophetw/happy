import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/sync/sync';
import { requestDotsConnections, dotsConnectionError, dotsConnectionStatus, type DotsConnectionsView } from '@/sync/dotsConnections';
import { requestDotsMcp, dotsMcpError, type DotsMcpView } from '@/sync/dotsMcpConnections';

/** Read-only legacy inventory plus one explicit, atomic migration. No REST credential editor. */
export function DotsLegacyConnectionsPanel({ sessionId, current, onMigrated }: {
    sessionId: string; current: () => boolean; onMigrated: () => void;
}) {
    const { theme } = useUnistyles();
    const [legacy, setLegacy] = React.useState<DotsConnectionsView | null>(null);
    const [mcp, setMcp] = React.useState<DotsMcpView | null>(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const epoch = React.useRef(0), inFlight = React.useRef(false);
    const run = React.useCallback(async (connectionID?: string) => {
        if (inFlight.current || !current()) return;
        inFlight.current = true; setBusy(true); setError(null); const version = epoch.current;
        try {
            await sync.ensureSessionReady(sessionId);
            if (version !== epoch.current || !current()) return;
            if (connectionID) {
                if (!legacy || !mcp || mcp.capabilities?.migrateRest !== 1) throw new Error('mcp_upgrade_required');
                await requestDotsMcp(sessionId, { action: 'migrate-rest', connectionID, revision: mcp.revision,
                    restRevision: legacy.revision, requestId: randomUUID() });
                if (version === epoch.current && current()) onMigrated();
            } else {
                const [old, next] = await Promise.all([requestDotsConnections(sessionId, { action: 'list' }), requestDotsMcp(sessionId, { action: 'list' })]);
                if (version === epoch.current && current()) { setLegacy(old); setMcp(next); }
            }
        } catch (failure) {
            if (version === epoch.current && current()) {
                const code = failure instanceof Error ? failure.message : '';
                setError(code === 'mcp_upgrade_required' ? '请升级宿主后再迁移。'
                    : code.startsWith('rest_') ? dotsConnectionError(failure) : dotsMcpError(failure));
                // A lost mutation response is resolved only by an explicit read refresh.
                if (connectionID) { setLegacy(null); setMcp(null); }
            }
        } finally { if (version === epoch.current) { inFlight.current = false; setBusy(false); } }
    }, [sessionId, current, legacy, mcp, onMigrated]);
    const initial = React.useRef(run);
    React.useEffect(() => { initial.current = run; });
    React.useEffect(() => {
        epoch.current++; setLegacy(null); setMcp(null); inFlight.current = false;
        void initial.current(); return () => { epoch.current++; };
    }, [sessionId, current]);
    const text = { color: theme.colors.text, lineHeight: 22 };
    return <View style={{ gap: 12 }}>
        <Text style={text}>新连接统一使用 MCP。迁移会保留此连接下所有 Dot 已选项目，历史任务继续使用原记录；不会创建授权或派发任务。</Text>
        {busy && <ActivityIndicator />}{error && <Text accessibilityRole="alert" style={{ ...text, color: '#b04b36' }}>{error}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="刷新旧连接" disabled={busy} onPress={() => void run()} style={{ padding: 12, minHeight: 44 }}><Text style={text}>刷新旧连接</Text></Pressable>
        {legacy?.connections.map(connection => <View key={connection.id} style={{ padding: 16, gap: 8, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12 }}>
            <Text style={text}>{connection.name} · {connection.migratedToMcp ? '已迁移到 MCP' : dotsConnectionStatus(connection)}</Text>
            {legacy.dots.filter(dot => dot.bindings.some(b => b.connectionID === connection.id)).map(dot => <Text key={dot.id} style={text}>
                {dot.name}：{dot.bindings.find(b => b.connectionID === connection.id)!.projectIDs.map(id => connection.projects.find(p => p.id === id)?.directory || id).join('、')}
            </Text>)}
            {!connection.migratedToMcp && <Pressable accessibilityRole="button" accessibilityLabel={`迁移到 MCP：${connection.name}`}
                disabled={busy || !connection.enabled || connection.status === 'expired' || mcp?.capabilities?.migrateRest !== 1}
                onPress={() => void run(connection.id)} style={{ padding: 12, minHeight: 44 }}><Text style={text}>迁移到 MCP</Text></Pressable>}
        </View>)}
        {legacy?.connections.length === 0 && <Text style={text}>没有需要迁移的旧连接。</Text>}
    </View>;
}
