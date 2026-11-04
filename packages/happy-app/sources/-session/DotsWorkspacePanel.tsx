import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { useFocusEffect } from '@react-navigation/native';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus, useSessionMessages } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTestloopDotsNavigationGuard } from '@/sync/testloopDotsNavigation';
import type { Session } from '@/sync/storageTypes';
import { projectTestloopDotsMessages, readTestloopDotsMetadata, testloopDotsCommand, testloopDotsLimitsText,
    type TestloopDot, type TestloopDotsMetadata, type TestloopDotsRequest } from '@/sync/testloopDots';

type PendingRequest = { request: TestloopDotsRequest; attempt: number; timedOut: boolean };

export function DotsWorkspacePanel({ session, workspaceId, active, topInset = 0 }: {
    session: Session; workspaceId: string; active: boolean; topInset?: number;
}) {
    const { theme } = useUnistyles();
    const wide = useWindowDimensions().width >= 1000;
    const navigate = useNavigateToSession();
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const realtimeStatus = useRealtimeStatus();
    useSessionVisibility(session.id, active, false, realtimeStatus);
    const { messages, isLoaded } = useSessionMessages(session.id);
    const projection = React.useMemo(() => projectTestloopDotsMessages(messages, workspaceId), [messages, workspaceId]);
    const [name, setName] = React.useState('');
    const [instruction, setInstruction] = React.useState('');
    const [pending, setPending] = React.useState<PendingRequest | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [opening, setOpening] = React.useState<string | null>(null);
    const initialized = React.useRef(false);
    const mounted = React.useRef(true);
    const pendingId = React.useRef<string | null>(null);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useFocusEffect(React.useCallback(() => {
        navigation.update(`${session.id}:${workspaceId}`, active);
        setOpening(null);
        return () => navigation.invalidate();
    }, [navigation, session.id, workspaceId, active]));

    const submit = React.useCallback(async (request: TestloopDotsRequest) => {
        pendingId.current = request.requestId;
        setPending(previous => ({ request, attempt: (previous?.attempt ?? 0) + 1, timedOut: false }));
        setError(null); setNotice(null);
        try {
            const accepted = await sync.sendMessage(session.id, testloopDotsCommand(request), {
                displayText: request.action === 'create' ? `创建 Dot：${request.name}` : '刷新 Dots 列表',
                awaitDelivery: true, isCurrent: () => mounted.current,
            });
            if (!accepted && mounted.current && pendingId.current === request.requestId) {
                setError('请求尚未送达。请检查网络，再重试上次请求。');
                setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
            }
        } catch {
            if (mounted.current && pendingId.current === request.requestId) {
                setError('尚未确认请求是否送达。重试会沿用同一请求，避免重复创建。');
                setPending(previous => previous?.request.requestId === request.requestId ? { ...previous, timedOut: true } : previous);
            }
        }
    }, [session.id]);

    React.useEffect(() => {
        if (!active || !isLoaded || initialized.current) return;
        initialized.current = true;
        if (projection.pendingRequest) {
            pendingId.current = projection.pendingRequest.requestId;
            setPending({ request: projection.pendingRequest, attempt: 0, timedOut: true });
            setError('上次请求还没有处理回执。可以重试同一请求，确认处理结果。');
        } else {
            void submit({ schemaVersion: 1, requestId: randomUUID(), action: 'list' });
        }
    }, [active, isLoaded, projection.pendingRequest, submit]);

    React.useEffect(() => {
        if (!pending) return;
        const receipt = projection.receipts[pending.request.requestId];
        if (!receipt) return;
        pendingId.current = null; setPending(null);
        if (receipt.ok) {
            setError(null);
            if (pending.request.action === 'create') {
                setNotice(`已创建「${pending.request.name}」。点击它的卡片进入专属对话。`);
                setName(''); setInstruction('');
            }
        } else {
            setError('后台未接受这次操作。请核对资料或刷新列表后重试。');
        }
    }, [pending, projection.receipts]);

    React.useEffect(() => {
        if (!pending || pending.timedOut) return;
        const requestId = pending.request.requestId;
        const timer = setTimeout(() => {
            if (pendingId.current !== requestId) return;
            setPending(previous => previous?.request.requestId === requestId ? { ...previous, timedOut: true } : previous);
            setError('仍未收到后台回执。可以重试上次请求，已提交的资料和请求编号会保持。');
        }, 15000);
        return () => clearTimeout(timer);
    }, [pending?.request.requestId, pending?.attempt, pending?.timedOut]);

    const create = () => {
        if (!name.trim() || !instruction.trim()) { setError('请填写 Dot 名称和长期职责。'); return; }
        void submit({ schemaVersion: 1, requestId: randomUUID(), action: 'create', name: name.trim(), instruction: instruction.trim() });
    };
    const openDot = async (dot: TestloopDot) => {
        const operation = navigation.begin();
        if (!operation) return;
        setOpening(dot.id); setError(null);
        try {
            await operation.afterReady(() => sync.ensureSessionReady(dot.sessionId), () => {
                const binding = readTestloopDotsMetadata(storage.getState().sessions[dot.sessionId]?.metadata);
                if (binding?.kind !== 'dot' || binding.dotId !== dot.id || binding.workspaceId !== workspaceId
                    || binding.workspaceSessionId !== session.id) throw new Error('dot_binding_changed');
                navigate(dot.sessionId);
            });
        } catch {
            if (operation.isCurrent()) setError('暂时无法打开这个 Dot 的专属对话。请刷新列表后重试。');
        } finally { if (operation.isCurrent()) setOpening(null); }
    };
    const snapshot = projection.snapshot;
    const limitsText = testloopDotsLimitsText(snapshot?.limits);
    const styles = React.useMemo(() => StyleSheet.create({
        canvas: { flex: 1, backgroundColor: theme.colors.surface },
        page: { padding: wide ? 32 : 18, paddingTop: (wide ? 32 : 18) + topInset, paddingBottom: 48,
            width: '100%', maxWidth: 1120, alignSelf: 'center' },
        header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 24 },
        title: { fontSize: 30, fontWeight: '700', color: theme.colors.text, marginBottom: 8 },
        subtitle: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 22, maxWidth: 600 },
        body: { flexDirection: wide ? 'row' : 'column', alignItems: 'stretch', gap: 24 },
        form: { width: wide ? 310 : '100%', borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 18, padding: 20, alignSelf: 'flex-start' },
        sectionTitle: { fontSize: 18, fontWeight: '600', color: theme.colors.text, marginBottom: 8 },
        label: { color: theme.colors.text, fontSize: 13, fontWeight: '500', marginTop: 20, marginBottom: 8 },
        input: { color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15 },
        button: { backgroundColor: '#4f46e5', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 10, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
        buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
        secondary: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
        secondaryText: { color: theme.colors.text, fontSize: 14, fontWeight: '500' },
        directory: { flex: 1, minWidth: 0 },
        card: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 18, padding: 20, marginBottom: 14 },
        cardTitle: { color: theme.colors.text, fontSize: 19, fontWeight: '600', marginBottom: 8 },
        small: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19 },
        message: { padding: 14, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, marginBottom: 18 },
    }), [theme, wide, topInset]);

    return <ScrollView style={styles.canvas} contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
            <View style={{ flexShrink: 1 }}>
                <Text style={styles.small}>TESTLOOP · 个人助理</Text>
                <Text accessibilityRole="header" style={styles.title}>Dots 工作台</Text>
                <Text style={styles.subtitle}>为不同职责创建长期助理。每个 Dot 有自己的专属对话、任务和记忆。</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="刷新 Dot 列表" disabled={!!pending}
                onPress={() => void submit({ schemaVersion: 1, requestId: randomUUID(), action: 'list' })}
                style={[styles.secondary, pending && { opacity: 0.5 }]}><Text style={styles.secondaryText}>刷新列表</Text></Pressable>
        </View>
        <View style={{ marginBottom: 24 }}>
            <Text style={styles.small}>创建、列表和切换不消耗模型额度。实际交办共用账户额度。</Text>
            {limitsText && <Text style={[styles.small, { marginTop: 4 }]}>{limitsText}</Text>}
        </View>
        {error && <View accessibilityRole="alert" style={styles.message}><Text style={{ color: theme.colors.text, lineHeight: 22 }}>{error}</Text></View>}
        {notice && <View style={styles.message}><Text style={{ color: theme.colors.text, lineHeight: 22 }}>{notice}</Text></View>}
        {pending && <View style={[styles.message, { gap: 12 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                {!pending.timedOut && <ActivityIndicator size="small" color="#4f46e5" />}
                <Text style={{ color: theme.colors.text }}>等待后台回执{pending.request.action === 'create' ? `：创建「${pending.request.name}」` : ''}</Text>
            </View>
            {pending.timedOut && <Pressable accessibilityRole="button" accessibilityLabel="重试上次请求" onPress={() => void submit(pending.request)} style={styles.secondary}>
                <Text style={styles.secondaryText}>重试上次请求</Text>
            </Pressable>}
        </View>}
        <View style={styles.body}>
            <View style={styles.form}>
                <Text style={styles.sectionTitle}>创建一个 Dot</Text>
                <Text style={styles.small}>给它一个清晰的职责，之后在专属对话里持续交办。</Text>
                <Text style={styles.label}>名称</Text>
                <TextInput accessibilityLabel="Dot 名称" placeholder="例如：写作助理" placeholderTextColor={theme.colors.textSecondary}
                    value={name} onChangeText={setName} maxLength={80} editable={!pending} style={styles.input} />
                <Text style={styles.label}>长期职责</Text>
                <TextInput accessibilityLabel="Dot 长期职责" placeholder="例如：帮我整理中文通知和工作草稿，保持简洁清晰。"
                    placeholderTextColor={theme.colors.textSecondary} value={instruction} onChangeText={setInstruction} maxLength={2000}
                    multiline editable={!pending} style={[styles.input, { minHeight: 132, textAlignVertical: 'top' }]} />
                <Pressable accessibilityRole="button" accessibilityLabel="创建 Dot" disabled={!!pending} onPress={create}
                    style={[styles.button, { marginTop: 20 }, pending && { opacity: 0.5 }]}><Text style={styles.buttonText}>创建 Dot</Text></Pressable>
            </View>
            <View style={styles.directory}>
                <Text style={[styles.sectionTitle, { marginBottom: 16 }]}>我的 Dots{snapshot ? ` · ${snapshot.dots.length}` : ''}</Text>
                {!snapshot ? <View style={styles.card}><Text style={styles.subtitle}>正在读取 Dots 列表…</Text></View>
                    : snapshot.dots.length === 0 ? <View style={[styles.card, { paddingVertical: 36 }]}>
                        <Text style={styles.cardTitle}>还没有 Dot</Text><Text style={styles.subtitle}>创建第一个助理，开始它的专属对话。</Text>
                    </View> : snapshot.dots.map(dot => <View key={dot.id} style={styles.card}>
                        <Text style={styles.cardTitle}>{dot.name}</Text>
                        <Text style={[styles.subtitle, { marginBottom: 14 }]}>{dot.instruction}</Text>
                        <Text style={[styles.small, { marginBottom: 18 }]}>专属对话 · 独立任务与记忆</Text>
                        <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${dot.name} 的专属对话`} disabled={opening !== null}
                            onPress={() => void openDot(dot)} style={[styles.secondary, { alignSelf: 'flex-start' }, opening !== null && { opacity: 0.5 }]}>
                            <Text style={styles.secondaryText}>{opening === dot.id ? '正在打开…' : '打开专属对话 →'}</Text>
                        </Pressable>
                    </View>)}
            </View>
        </View>
    </ScrollView>;
}

export function DotWorkspaceHeaderLink({ metadata, sessionId, active }: {
    metadata: Extract<TestloopDotsMetadata, { kind: 'dot' }>; sessionId: string; active: boolean;
}) {
    const { theme } = useUnistyles();
    const navigate = useNavigateToSession();
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
                navigate(metadata.workspaceSessionId);
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
