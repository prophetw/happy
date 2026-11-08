import * as React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { recoverDot } from '@/sync/dotRecovery';

export function DotRecoveryNotice({ workspaceId, dotId, sessionId, online }: {
    workspaceId: string; dotId: string; sessionId: string; online: boolean;
}) {
    const { theme } = useUnistyles();
    const [pending, setPending] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const attempt = React.useRef(0), busy = React.useRef(false);
    React.useEffect(() => { attempt.current++; busy.current = false; setPending(false); setError(null);
        return () => { attempt.current++; busy.current = false; };
    }, [workspaceId, dotId, sessionId, online]);
    React.useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => { attempt.current++; busy.current = false; setPending(false);
            setError('已请求恢复，但 Dot 尚未上线。请确认宿主网络正常后重试。'); }, 45000);
        return () => clearTimeout(timer);
    }, [pending]);
    if (online) return null;
    const restore = async () => {
        if (busy.current) return;
        busy.current = true; const current = ++attempt.current; setPending(true); setError(null);
        try { await recoverDot({ workspaceId, dotId, sessionId }); }
        catch (e) { if (attempt.current === current) { busy.current = false; setPending(false); setError(e instanceof Error ? e.message : '恢复失败，请重试。'); } }
    };
    return <View style={{ padding: 12, margin: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh }}>
        <Text style={{ color: theme.colors.text, marginBottom: 8 }}>Dot 暂时离线</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary, marginBottom: 10 }}>
            {error ?? (pending ? '正在恢复，等待 Dot 上线…' : '点击恢复原会话，继续保留聊天和记忆。宿主电脑需要开机并联网。')}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="一键恢复 Dot" accessibilityState={{ disabled: pending }} disabled={pending}
            onPress={restore} style={{ padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface, opacity: pending ? 0.6 : 1 }}>
            {pending ? <ActivityIndicator /> : <Text style={{ color: theme.colors.text }}>{error ? '重试恢复' : '一键恢复'}</Text>}
        </Pressable>
    </View>;
}
