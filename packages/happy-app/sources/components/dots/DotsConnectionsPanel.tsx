import * as React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata } from '@/sync/testloopDots';
import { DotsMcpPanel } from './DotsMcpPanel';
import { DotsLegacyConnectionsPanel } from './DotsLegacyConnectionsPanel';

/** MCP is the default connection interface. REST records are exposed only for migration. */
export function DotsConnectionsPanel({ sessionId, workspaceId, dotId, onClose }: {
    sessionId: string; workspaceId: string; dotId?: string; onClose: () => void;
}) {
    const { theme } = useUnistyles(), { credentials, isAuthenticated } = useAuth();
    const server = getServerUrl();
    const [tab, setTab] = React.useState<'mcp' | 'legacy'>('mcp');
    const current = React.useCallback(() => {
        const binding = readTestloopDotsMetadata(storage.getState().sessions[sessionId]?.metadata);
        return isAuthenticated && credentials?.token === sync.getCredentials()?.token
            && credentials?.secret === sync.getCredentials()?.secret && server === getServerUrl()
            && binding?.kind === 'workspace' && binding.workspaceId === workspaceId;
    }, [sessionId, workspaceId, credentials?.token, credentials?.secret, isAuthenticated, server]);
    const scope = React.useMemo(() => ({}), [sessionId, workspaceId, dotId, credentials?.token, credentials?.secret, isAuthenticated, server]);
    const [renderScope, setRenderScope] = React.useState(scope);
    React.useEffect(() => { setRenderScope(scope); setTab('mcp'); }, [scope]);
    const text = { color: theme.colors.text, lineHeight: 22 };
    const button = (label: string, action: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label}
        onPress={action} style={{ padding: 12, minHeight: 44, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8 }}><Text style={text}>{label}</Text></Pressable>;
    if (renderScope !== scope || !current()) return null;
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#00000066', padding: 12, alignItems: 'center', justifyContent: 'center' }}>
            <View accessibilityViewIsModal style={{ maxHeight: '92%', width: '100%', maxWidth: 800, backgroundColor: theme.colors.surface, borderRadius: 18, overflow: 'hidden' }}>
                <View style={{ padding: 16, gap: 12, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 }}>
                        <Text accessibilityRole="header" style={{ ...text, fontSize: 19, fontWeight: '600' }}>连接与授权</Text>
                        {button('关闭连接管理', onClose)}
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        {button('MCP 连接', () => setTab('mcp'))}{button('旧连接迁移', () => setTab('legacy'))}
                    </View>
                </View>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16 }}>
                        {tab === 'mcp' ? <DotsMcpPanel sessionId={sessionId} dotId={dotId} current={current} />
                            : <DotsLegacyConnectionsPanel sessionId={sessionId} current={current} onMigrated={() => setTab('mcp')} />}
                </ScrollView>
            </View>
        </View>
    </Modal>;
}
