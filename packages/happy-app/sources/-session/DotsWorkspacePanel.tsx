import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTestloopDotsNavigationGuard } from '@/sync/testloopDotsNavigation';
import { readTestloopDotsMetadata, type TestloopDotsMetadata } from '@/sync/testloopDots';
export { DotsWorkspacePanel } from '@/components/dots/DotsWorkspaceHome';

export function DotWorkspaceHeaderLink({ metadata, sessionId, active }: {
    metadata: Extract<TestloopDotsMetadata, { kind: 'dot' }>; sessionId: string; active: boolean;
}) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const [opening, setOpening] = React.useState(false);
    const [error, setError] = React.useState(false);
    useFocusEffect(React.useCallback(() => {
        navigation.update(`${sessionId}:${metadata.workspaceId}:${metadata.dotId}:${metadata.workspaceSessionId}`, active);
        setOpening(false);
        return () => navigation.invalidate();
    }, [navigation, sessionId, metadata.workspaceId, metadata.dotId, metadata.workspaceSessionId, active]));
    const back = async () => {
        const operation = navigation.begin();
        if (!operation) return;
        setOpening(true); setError(false);
        try {
            await operation.afterReady(() => sync.ensureSessionReady(metadata.workspaceSessionId), () => {
                const binding = readTestloopDotsMetadata(storage.getState().sessions[metadata.workspaceSessionId]?.metadata);
                if (binding?.kind !== 'workspace' || binding.workspaceId !== metadata.workspaceId) throw new Error('workspace_binding_changed');
                router.dismissTo({ pathname: '/dots', params: { workspace: metadata.workspaceSessionId } });
            });
        } catch { if (operation.isCurrent()) setError(true); }
        finally { if (operation.isCurrent()) setOpening(false); }
    };
    return <View style={{ alignItems: 'flex-end', maxWidth: 190, gap: 4 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回 Dots 工作台" disabled={opening} onPress={() => void back()}
            testID="testloop-dot-workspace-link"
            style={{ paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, borderRadius: 18,
                borderWidth: 1, borderColor: theme.colors.divider, justifyContent: 'center' }}>
            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: 13, fontWeight: '500' }}>{opening ? '正在打开…' : '← 工作台'}</Text>
        </Pressable>
        {error && <Text accessibilityRole="alert" style={{ color: theme.colors.text, fontSize: 12 }}>暂时无法打开工作台，请稍后重试。</Text>}
    </View>;
}
