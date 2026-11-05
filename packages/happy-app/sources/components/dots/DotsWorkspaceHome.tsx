import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { DotsConnectionsPanel } from './DotsConnectionsPanel';
import { useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { storage, useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createTestloopDotsNavigationGuard } from '@/sync/testloopDotsNavigation';
import { useDotsWorkspace } from './useDotsWorkspace';
import type { Session } from '@/sync/storageTypes';
import { readTestloopDotsMetadata, testloopDotsLimitsText, testloopWorkStatus, type TestloopDot } from '@/sync/testloopDots';

function DotRow({ dot, onOpen, disabled }: { dot: TestloopDot; onOpen: () => void; disabled: boolean }) {
    const { theme } = useUnistyles();
    const session = useSession(dot.sessionId);
    const status = !session ? '尚未读取会话状态' : session.presence !== 'online' ? '连接状态待确认' : session.thinking ? '正在处理' : '在线';
    return <Pressable accessibilityRole="button" accessibilityLabel={`打开 ${dot.name} 的专属对话`} disabled={disabled} onPress={onOpen}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 22,
            borderBottomWidth: 1, borderBottomColor: theme.colors.divider, opacity: disabled || pressed ? 0.5 : 1 })}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#6650b7', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 18 }}>{Array.from(dot.name)[0]}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}><Text style={{ color: theme.colors.text, fontSize: 17, fontWeight: '600' }}>{dot.name}</Text>
            <Text numberOfLines={2} style={{ color: theme.colors.textSecondary, lineHeight: 21 }}>{dot.instruction}</Text>
            <Text style={{ color: session?.thinking ? theme.colors.textLink : theme.colors.textSecondary, fontSize: 12 }}>{status}</Text>
        </View><Ionicons name="chevron-forward" size={17} color={theme.colors.textSecondary} />
    </Pressable>;
}

export function DotsWorkspacePanel({ session, workspaceId, active, topInset = 0 }: {
    session: Session; workspaceId: string; active: boolean; topInset?: number;
}) {
    const { theme } = useUnistyles();
    const data = useDotsWorkspace(session.id, workspaceId, active);
    const { connections } = useLocalSearchParams<{ connections?: string }>();
    const [managingConnections, setManagingConnections] = React.useState(connections === '1');
    React.useEffect(() => { if (connections === '1') setManagingConnections(true); }, [connections]);
    const navigate = useNavigateToSession();
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const [width, setWidth] = React.useState(0), [creating, setCreating] = React.useState(false);
    const [name, setName] = React.useState(''), [instruction, setInstruction] = React.useState('');
    const [opening, setOpening] = React.useState<string | null>(null), [openError, setOpenError] = React.useState<string | null>(null);
    const createId = React.useRef<string | null>(null);
    const compact = width < 760;
    useFocusEffect(React.useCallback(() => {
        navigation.update(`${session.id}:${workspaceId}`, active); setOpening(null); setOpenError(null);
        return () => navigation.invalidate();
    }, [navigation, session.id, workspaceId, active]));
    React.useEffect(() => {
        if (createId.current && data.projection?.receipts[createId.current]?.ok) {
            createId.current = null; setName(''); setInstruction(''); setCreating(false);
        }
    }, [data.projection]);
    const openDot = async (dot: TestloopDot) => {
        const operation = navigation.begin(); if (!operation) return;
        setOpening(dot.id); setOpenError(null);
        try { await operation.afterReady(() => sync.ensureSessionReady(dot.sessionId), () => {
            const binding = readTestloopDotsMetadata(storage.getState().sessions[dot.sessionId]?.metadata);
            if (binding?.kind !== 'dot' || binding.dotId !== dot.id || binding.workspaceId !== workspaceId
                || binding.workspaceSessionId !== session.id) throw new Error('dot_binding_changed');
            navigate(dot.sessionId);
        }); } catch { if (operation.isCurrent()) setOpenError('暂时无法打开这个 Dot，请刷新后重试。'); }
        finally { if (operation.isCurrent()) setOpening(null); }
    };
    const snapshot = data.projection?.snapshot;
    const attention = snapshot?.workbench?.dots.flatMap(dot => dot.tasks
        .filter(task => task.needsReview || ['awaiting_user', 'awaiting_approval', 'blocked', 'failed'].includes(task.status))
        .map(task => ({ ...task, dot: snapshot.dots.find(item => item.id === dot.id)! }))) ?? [];
    const limits = testloopDotsLimitsText(snapshot?.limits);
    const unavailable = snapshot?.workbench?.dots.some(dot => !dot.available);
    const s = React.useMemo(() => StyleSheet.create({
        page: { padding: compact ? 18 : 28, paddingTop: topInset + (compact ? 18 : 28), gap: 24, width: '100%', maxWidth: 1140, alignSelf: 'center', paddingBottom: 40 },
        row: { flexDirection: 'row', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
        title: { color: theme.colors.text, fontSize: 30, fontWeight: '600' },
        heading: { color: theme.colors.text, fontSize: 18, fontWeight: '600' },
        muted: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 22 },
        button: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, backgroundColor: theme.colors.surfaceHigh, justifyContent: 'center', alignItems: 'center' },
        input: { borderWidth: 1, borderColor: theme.colors.divider, color: theme.colors.text, padding: 14, borderRadius: 10, fontSize: 15 },
        attention: { padding: 18, gap: 14, backgroundColor: theme.colors.surfaceHigh, borderRadius: 14 },
    }), [theme, compact, topInset]);
    return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, backgroundColor: theme.colors.surface }}>
        <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
            <View style={[s.row, { justifyContent: 'space-between' }]}><View style={{ gap: 7, flex: 1, minWidth: 160 }}>
                <Text accessibilityRole="header" style={s.title}>Dots</Text><Text style={s.muted}>你的长期助理与正在推进的工作。</Text>
            </View><Pressable accessibilityRole="button" accessibilityLabel="新建 Dot" disabled={!data.ready || Boolean(data.pending)} onPress={() => setCreating(true)}
                style={[s.button, { backgroundColor: '#6650b7', opacity: data.ready && !data.pending ? 1 : 0.5 }]}><Text style={{ color: '#fff', fontWeight: '600' }}>＋ 新建 Dot</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="刷新 Dot 列表" disabled={Boolean(data.pending)} onPress={() => data.retry()} style={s.button}><Text style={s.muted}>刷新</Text></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="连接与授权" onPress={() => setManagingConnections(true)} style={s.button}><Text style={s.muted}>连接与授权</Text></Pressable>
            </View>
            {limits && <Text style={s.muted}>{limits}</Text>}
            {(data.error || openError) && <Text accessibilityRole="alert" style={s.muted}>{data.error || openError}</Text>}
            {data.notice && <Text accessibilityLiveRegion="polite" style={s.muted}>{data.notice}</Text>}
            {data.pending && <View style={s.row}>{!data.pending.timedOut && <ActivityIndicator />}
                <Text style={s.muted}>等待后台回执{data.pending.request.action === 'create' ? `：创建「${data.pending.request.name}」` : ''}</Text>
                {data.pending.timedOut && <Pressable accessibilityRole="button" accessibilityLabel="重试上次请求" onPress={() => data.retry()} style={s.button}><Text style={s.muted}>重试上次请求</Text></Pressable>}
            </View>}
            <View style={{ flexDirection: compact ? 'column' : 'row', gap: 30, alignItems: 'flex-start' }}>
                <View style={{ flex: 1, width: '100%', minWidth: 0, gap: 8 }}><Text style={s.heading}>助理目录{snapshot ? ` · ${snapshot.dots.length}` : ''}</Text>
                    {!snapshot ? <Text style={s.muted}>正在读取 Dots 列表…</Text> : !snapshot.dots.length ? <Text style={[s.muted, { paddingVertical: 24 }]}>还没有 Dot，创建第一个助理开始交办。</Text>
                        : snapshot.dots.map(dot => <DotRow key={dot.id} dot={dot} disabled={opening !== null} onOpen={() => void openDot(dot)} />)}
                </View>
                <View style={[s.attention, { width: compact ? '100%' : 280 }]}><Text style={s.heading}>需要你处理</Text>
                    {unavailable && <Text accessibilityRole="alert" style={s.muted}>部分助理的工作项暂时无法读取，请进入对应对话核对或刷新重试。</Text>}
                    {!snapshot?.workbench ? <Text style={s.muted}>{snapshot ? '当前宿主尚未提供任务概览，请升级宿主后刷新。' : '正在读取工作进展…'}</Text>
                        : !attention.length ? !unavailable && <Text style={s.muted}>最近工作项中没有待处理事项。</Text> : attention.map(task => <Pressable key={`${task.dot.id}:${task.id}`} accessibilityRole="button"
                            accessibilityLabel={`查看 ${task.dot.name} 的工作：${task.title}`} disabled={opening !== null} onPress={() => void openDot(task.dot)}
                            style={{ gap: 5, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                            <Text style={{ color: theme.colors.text, lineHeight: 22 }}>{task.title}</Text><Text style={s.muted}>{task.dot.name} · {testloopWorkStatus(task)}</Text>
                        </Pressable>)}
                    {snapshot?.workbench && <Text style={[s.muted, { fontSize: 11 }]}>各 Dot 最近 5 项工作 · 更新于 {new Date(snapshot.workbench.asOf).toLocaleString()}</Text>}
                </View>
            </View>
        </ScrollView>
        {managingConnections && active && <DotsConnectionsPanel key={`${session.id}:${workspaceId}`} sessionId={session.id} workspaceId={workspaceId} onClose={() => setManagingConnections(false)} />}
        <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
            <View style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'center', alignItems: 'center', padding: 18 }}>
                <ScrollView keyboardShouldPersistTaps="handled" style={{ width: '100%', maxWidth: 520, maxHeight: '90%', backgroundColor: theme.colors.surface, borderRadius: 18 }} contentContainerStyle={{ padding: 24, gap: 18 }}>
                    <Text accessibilityRole="header" style={s.heading}>创建一个 Dot</Text>
                    <Text style={s.muted}>名称</Text><TextInput accessibilityLabel="Dot 名称" value={name} onChangeText={setName} maxLength={80} editable={!data.pending} style={s.input} />
                    <Text style={s.muted}>长期职责</Text><TextInput accessibilityLabel="Dot 长期职责" value={instruction} onChangeText={setInstruction} maxLength={2000} multiline editable={!data.pending} style={[s.input, { minHeight: 110, textAlignVertical: 'top' }]} />
                    <Text style={s.muted}>创建不消耗模型额度。新 Dot 默认没有 REST 权限，创建后请在「连接与授权」中选择项目。</Text>
                    <Pressable accessibilityRole="button" accessibilityLabel="创建 Dot" disabled={!name.trim() || !instruction.trim() || Boolean(data.pending)} onPress={() => {
                        const requestId = randomUUID(); createId.current = requestId;
                        void data.submit({ schemaVersion: 1, requestId, action: 'create', name: name.trim(), instruction: instruction.trim() });
                    }} style={[s.button, { backgroundColor: '#6650b7', opacity: !name.trim() || !instruction.trim() || data.pending ? 0.5 : 1 }]}><Text style={{ color: '#fff' }}>创建 Dot</Text></Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel="关闭创建表单" onPress={() => setCreating(false)} style={s.button}><Text style={s.muted}>关闭</Text></Pressable>
                </ScrollView>
            </View>
        </Modal>
    </View>;
}
