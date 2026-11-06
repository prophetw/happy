import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Modal as GlobalModal } from '@/modal';
import { randomUUID } from 'expo-crypto';
import { useFocusEffect } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useSessionVisibility } from '@/hooks/useSessionVisibility';
import { storage, useRealtimeStatus } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { Session } from '@/sync/storageTypes';
import { createTestloopDotsNavigationGuard } from '@/sync/testloopDotsNavigation';
import { testloopWorkStatus, type TestloopDotsMetadata } from '@/sync/testloopDots';
import { useDotsWorkspace } from './useDotsWorkspace';
import { DotsConnectionsPanel } from './DotsConnectionsPanel';
import { DotObservationPanel } from './DotObservationPanel';

type DotMetadata = Extract<TestloopDotsMetadata, { kind: 'dot' }>;
type Tab = 'chat' | 'activity' | 'work' | 'memory' | 'basis';
const tabLabels = { chat: '对话', activity: '活动', work: '工作', memory: '记忆', basis: '本轮依据' };

/** Keep Happy's real conversation mounted while its host-backed work/memory panel changes. */
export function DotSessionContent({ session, metadata, active, children, topInset = 0 }: {
    session: Session; metadata: DotMetadata; active: boolean; children: (request: { id: string; text: string } | null) => React.ReactNode; topInset?: number;
}) {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    const realtime = useRealtimeStatus();
    useSessionVisibility(session.id, active, false, realtime);
    const data = useDotsWorkspace(metadata.workspaceSessionId, metadata.workspaceId, active, metadata.dotId);
    const currentDots = React.useRef(data);
    currentDots.current = data;
    const navigate = useNavigateToSession();
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const [width, setWidth] = React.useState(0), [tab, setTab] = React.useState<Tab>('chat');
    const [managingConnections, setManagingConnections] = React.useState(false);
    const [sideTab, setSideTab] = React.useState<Exclude<Tab, 'chat'>>('activity'), [expanded, setExpanded] = React.useState(true);
    const [taskId, setTaskId] = React.useState<string | null>(null), [error, setError] = React.useState<string | null>(null);
    const [memoryEdit, setMemoryEdit] = React.useState<{ key: string; text: string; kind: string; json: boolean; expiresAt: string | null; existing: boolean } | null>(null);
    const [notice, setNotice] = React.useState<string | null>(null);
    const [clearConfirming, setClearConfirming] = React.useState(false);
    const [composeRequest, setComposeRequest] = React.useState<{ id: string; text: string } | null>(null);
    const wide = width >= 920;
    const own = data.projection?.snapshot?.dots.some(dot => dot.id === metadata.dotId && dot.sessionId === session.id);
    const view = own ? data.projection?.details[metadata.dotId] : undefined;
    const detail = view?.data;
    const selectedTask = detail?.tasks.find(task => task.id === taskId);
    useFocusEffect(React.useCallback(() => {
        navigation.update(`${session.id}:${metadata.workspaceId}:${metadata.dotId}`, active);
        return () => navigation.invalidate();
    }, [navigation, session.id, metadata.workspaceId, metadata.dotId, active]));
    const body = { color: colors.text, fontSize: 14, lineHeight: 23 };
    const muted = { color: colors.textSecondary, fontSize: 12, lineHeight: 21 };
    const heading = { color: colors.text, fontSize: 17, fontWeight: '600' as const };
    const button = { minHeight: 44, padding: 12, borderRadius: 10, backgroundColor: colors.surfaceHigh, justifyContent: 'center' as const };
    const action = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
        onPress={onPress} style={[button, { opacity: disabled ? 0.5 : 1 }]}><Text style={body}>{label}</Text></Pressable>;
    const toConversation = (text: string) => {
        setComposeRequest({ id: `${session.id}:${Date.now()}`, text });
        setTab('chat'); setTaskId(null); setMemoryEdit(null);
        setNotice('已放入对话输入框。核对后发送，结果会回到这个 Dot。');
    };
    const clearConversation = async () => {
        if (clearConfirming || currentDots.current.pending) return;
        const current = currentDots.current.projection?.snapshot;
        const dot = current?.dots.find(item => item.id === metadata.dotId && item.sessionId === session.id);
        if (!dot) return;
        setClearConfirming(true);
        try {
            const confirmed = await GlobalModal.confirm('清空当前对话？',
                '仅为之后的模型上下文隔离此前的历史、运行记录和任务上下文。Dot 与会话保持不变；旧聊天、长期记忆、授权和任务记录仍保留，进行中的目标不会取消。',
                { confirmText: '清空对话' });
            if (!confirmed || currentDots.current.pending) return;
            const latestDot = currentDots.current.projection?.snapshot?.dots
                .find(item => item.id === metadata.dotId && item.sessionId === session.id);
            if (!latestDot) return;
            void currentDots.current.submit({ schemaVersion: 1, requestId: randomUUID(), action: 'clear', dotId: metadata.dotId });
        } finally {
            setClearConfirming(false);
        }
    };
    const openExecution = async (sessionId: string) => {
        const operation = navigation.begin(); if (!operation) return;
        setError(null);
        try { await operation.afterReady(() => sync.ensureSessionReady(sessionId), () => {
            if (!storage.getState().sessions[sessionId]) throw new Error('execution_session_unavailable');
            setTaskId(null);
            navigate(sessionId);
        }); } catch { if (operation.isCurrent()) setError('当前账号或服务器无法打开这条执行会话，请在 Dot 对话中核对执行端。'); }
    };
    const sheet = (title: string, onClose: () => void, content: React.ReactNode) => <Modal transparent animationType="fade" visible onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#00000066', padding: 18, justifyContent: 'center', alignItems: 'center' }}>
            <ScrollView keyboardShouldPersistTaps="handled" accessibilityViewIsModal style={{ maxHeight: '90%', width: '100%', maxWidth: 620, borderRadius: 18, backgroundColor: colors.surface }} contentContainerStyle={{ padding: 24, gap: 18 }}>
                <Text accessibilityRole="header" style={heading}>{title}</Text>{content}{action('关闭', onClose)}
            </ScrollView>
        </View>
    </Modal>;
    const observationPanel = <>
        <DotObservationPanel key={`${metadata.dotId}:${wide ? sideTab : tab}`} sessionId={metadata.workspaceSessionId}
            workspaceId={metadata.workspaceId} dotId={metadata.dotId} dotSessionId={session.id} active={Boolean(active && own && (wide ? expanded : tab !== 'chat'))}
            mode={(wide ? sideTab : tab) === 'memory' ? 'memory' : (wide ? sideTab : tab) === 'basis' ? 'basis' : 'activity'}
            presence={session.presence} onExecution={id => void openExecution(id)}
            onEditMemory={(key, version) => {
                if (!data.ready || !own) return;
                setMemoryEdit({ key, text: typeof version.value === 'string' ? version.value : JSON.stringify(version.value),
                    kind: version.kind, json: typeof version.value !== 'string', expiresAt: version.expiresAt, existing: true });
            }} onForgetMemory={key => {
                if (data.ready && own) toConversation(`请忘记当前 Dot 的个人记忆 ${JSON.stringify(key)}，先展示变更供我确认。`);
            }} onAddMemory={() => {
                if (data.ready && own) setMemoryEdit({ key: '', text: '', kind: 'preference', json: false, expiresAt: null, existing: false });
            }} />
    </>;
    const panel = <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ padding: 14, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {wide && (['activity', 'work', 'memory', 'basis'] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: sideTab === item }} onPress={() => setSideTab(item)} style={button}><Text style={body}>{tabLabels[item]}</Text></Pressable>)}
            {(wide ? sideTab : tab) === 'work' && action('刷新工作与记忆', () => { data.retry(); }, Boolean(data.pending))}
            {action('清空当前对话', () => void clearConversation(), !data.ready || !own || Boolean(data.pending) || clearConfirming)}
            {action('可用连接与项目', () => setManagingConnections(true))}
        </View>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 18 }}>
            {data.pending && !data.pending.timedOut && <ActivityIndicator />}
            {(data.error || error) && <Text accessibilityRole="alert" style={body}>{data.error || error}</Text>}
            {data.pending?.timedOut && action('重试上次请求', () => { data.retry(); })}
            {(wide ? sideTab : tab) !== 'work' ? observationPanel : !detail ? <Text style={muted}>尚未收到这个 Dot 的工作快照，请刷新核对。</Text> : <>
                    <Text style={heading}>工作项 · {detail.taskTotal}</Text>
                    {detail.tasks.map(task => <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={`查看工作项：${task.title}`} onPress={() => setTaskId(task.id)} style={{ gap: 6, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                        <Text style={body}>{task.title}</Text><Text style={muted}>{testloopWorkStatus(task)}{task.projectID ? ` · ${task.projectID}` : ''}</Text>
                    </Pressable>)}
                    {!detail.tasks.length && <Text style={muted}>这个 Dot 还没有可查看的工作项。在对话中交办即可。</Text>}
                    {detail.taskTotal > detail.tasks.length && <Text style={muted}>当前展示最近 {detail.tasks.length} 项，其余工作可在对话中按名称或编号查询。</Text>}
                </>}
            {view && <Text style={muted}>更新于 {new Date(view.asOf).toLocaleString()}</Text>}
        </ScrollView>
    </View>;
    return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, minHeight: 0, paddingTop: topInset }}>
        {managingConnections && active && <DotsConnectionsPanel key={`${session.id}:${metadata.dotId}`} sessionId={metadata.workspaceSessionId} workspaceId={metadata.workspaceId} dotId={metadata.dotId} onClose={() => setManagingConnections(false)} />}
        {wide ? <View style={{ alignItems: 'flex-end', paddingHorizontal: 16 }}>{action(expanded ? '收起工作栏' : '展开工作栏', () => setExpanded(value => !value))}</View>
            : <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 4 }}>{(['chat', 'activity', 'work', 'memory', 'basis'] as Tab[]).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} onPress={() => setTab(item)} style={[button, { paddingHorizontal: 8, flexGrow: 1, alignItems: 'center', backgroundColor: tab === item ? colors.surfaceHigh : colors.surface }]}>
                <Text style={body}>{tabLabels[item]}</Text>
            </Pressable>)}</View>}
        {(data.notice || notice) && <Text accessibilityLiveRegion="polite" style={[muted, { paddingHorizontal: 16 }]}>{data.notice || notice}</Text>}
        <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
            <View style={{ flex: 1, display: wide || tab === 'chat' ? 'flex' : 'none', minWidth: 0 }}>{children(composeRequest)}</View>
            <View style={{ width: wide ? 320 : '100%', display: wide ? expanded ? 'flex' : 'none' : tab === 'chat' ? 'none' : 'flex', borderLeftWidth: wide ? 1 : 0, borderLeftColor: colors.divider }}>{panel}</View>
        </View>
        {selectedTask && sheet(selectedTask.title, () => setTaskId(null), <>
            <Text style={body}>{testloopWorkStatus(selectedTask)}</Text>
            <Text style={body}>{selectedTask.instruction}</Text>
            {selectedTask.projectID && <Text style={muted}>项目：{selectedTask.projectID}</Text>}
            {selectedTask.reason && <Text style={muted}>状态原因：{selectedTask.reason}</Text>}
            {selectedTask.nextWakeAt && <Text style={muted}>最早执行时间：{new Date(selectedTask.nextWakeAt).toLocaleString()}</Text>}
            {selectedTask.steps.map(step => <Text key={step.id} style={body}>{step.title} · {step.status}</Text>)}
            {['delegate', 'goal'].includes(selectedTask.kind) && <Text style={muted}>{selectedTask.businessVerification === 'independent_agent_report' ? '已有独立执行会话提供的验收报告' : '业务验收尚未核验'}</Text>}
            {selectedTask.result && <><Text style={heading}>实际回报{selectedTask.resultTruncated ? '（已截断）' : ''}</Text><Text selectable style={body}>{selectedTask.result}</Text></>}
            {selectedTask.executionSessionId && action('查看执行会话', () => void openExecution(selectedTask.executionSessionId!))}
            {action('在对话中跟进此工作', () => toConversation(`请跟进当前 Dot 的工作项 ${selectedTask.id}（${selectedTask.title}），说明最新进展和仍需处理的事项。`))}
        </>)}
        {memoryEdit && data.ready && own && sheet(memoryEdit.key ? '修改记忆' : '添加记忆', () => setMemoryEdit(null), <>
            <Text style={muted}>名称</Text><TextInput accessibilityLabel="记忆名称" value={memoryEdit.key} editable={!memoryEdit.existing} onChangeText={key => setMemoryEdit(previous => previous && ({ ...previous, key }))} maxLength={200} style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, padding: 12, borderRadius: 10 }} />
            <Text style={muted}>{memoryEdit.json ? 'JSON 内容' : '内容'}</Text><TextInput accessibilityLabel="记忆内容" value={memoryEdit.text} maxLength={4096} onChangeText={text => setMemoryEdit(previous => previous && ({ ...previous, text }))} multiline style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, minHeight: 120, padding: 12, borderRadius: 10, textAlignVertical: 'top' }} />
            <Text style={muted}>有效期（ISO 时间，留空表示不设到期）</Text><TextInput accessibilityLabel="记忆有效期" value={memoryEdit.expiresAt ?? ''} onChangeText={expiresAt => setMemoryEdit(previous => previous && ({ ...previous, expiresAt: expiresAt || null }))} style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, padding: 12, borderRadius: 10 }} />
            {error && <Text accessibilityRole="alert" style={body}>{error}</Text>}
            {action('带入对话并确认', () => {
                if (!memoryEdit.key.trim() || !memoryEdit.text.trim()) { setError('请填写记忆名称和内容。'); return; }
                let value: unknown = memoryEdit.text;
                try { if (memoryEdit.json) value = JSON.parse(memoryEdit.text); } catch { setError('内容不是有效的 JSON，请修正后重试。'); return; }
                const expiry = memoryEdit.expiresAt?.trim() || null;
                if (expiry && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiry) || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
                    setError('请输入包含时区的未来 ISO 时间，或清空有效期。'); return;
                }
                setError(null); toConversation(`请将当前 Dot 的个人记忆 ${JSON.stringify(memoryEdit.key.trim())} 保存为 ${memoryEdit.kind}，内容为 ${JSON.stringify(value)}，有效期为 ${expiry ? new Date(expiry).toISOString() : '不设置到期'}。先展示变更供我确认。`);
            })}
        </>)}
    </View>;
}
