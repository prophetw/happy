import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Modal } from '@/modal';
import { restartDot } from '@/sync/dotRecovery';
import { useUnistyles } from 'react-native-unistyles';

const statusText = {
    confirming: '等待确认…',
    waiting: '等待当前轮次完成…',
    restarting: '正在重启此 Dot…',
    ready: '此 Dot 已重新就绪。',
};

export function DotRestartControl({ workspaceId, dot, disabled }: {
    workspaceId: string; dot: { id: string; name: string; sessionId: string }; disabled: boolean;
}) {
    const { theme } = useUnistyles();
    const [status, setStatus] = React.useState<keyof typeof statusText | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const operation = React.useRef<AbortController | null>(null);
    const request = React.useRef<string | null>(null);
    React.useEffect(() => () => operation.current?.abort(), []);
    const restart = async () => {
        if (disabled || operation.current) return;
        const controller = new AbortController();
        operation.current = controller;
        try {
            if (!request.current) {
                setStatus('confirming');
                const confirmed = await Modal.confirm(`重启「${dot.name}」？`,
                    `会话尾号 ${dot.sessionId.slice(-8)}。当前轮次完成后重启，保留原会话和聊天记录。`,
                    { confirmText: '确认重启', cancelText: '取消' });
                if (!confirmed || controller.signal.aborted) { if (!controller.signal.aborted) setStatus(null); return; }
                request.current = randomUUID();
            }
            setStatus('restarting');
            setError(null);
            const input = { workspaceId, dotId: dot.id, sessionId: dot.sessionId, requestId: request.current };
            while (!controller.signal.aborted) {
                const phase = await restartDot(input, controller.signal);
                if (controller.signal.aborted) return;
                setStatus(phase);
                if (phase === 'ready') { request.current = null; return; }
                await new Promise(resolve => setTimeout(resolve, phase === 'waiting' ? 2500 : 1000));
            }
        } catch (cause) {
            if (!controller.signal.aborted) {
                setStatus(null);
                setError(cause instanceof Error ? cause.message : '重启状态待核对。');
            }
        } finally { operation.current = null; }
    };
    const pending = status !== null && status !== 'ready';
    return <View style={{ gap: 8 }}>
        <Pressable accessibilityRole="button" disabled={disabled || pending} accessibilityState={{ disabled: disabled || pending }}
            onPress={() => void restart()} style={{ minHeight: 44, padding: 12, borderRadius: 10,
                backgroundColor: theme.colors.surfaceHigh, alignItems: 'center', opacity: disabled || pending ? 0.5 : 1 }}>
            <Text style={{ color: theme.colors.text }}>{error ? '核对重启状态' : '重启此 Dot'}</Text>
        </Pressable>
        {status && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.textSecondary }}>{statusText[status]}</Text>}
        {error && <Text accessibilityRole="alert" style={{ color: theme.colors.text }}>重启未确认。{error}</Text>}
    </View>;
}
