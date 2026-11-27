import { DotTaskTiming } from './DotTaskTiming';
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
import { testloopWorkStatus, testloopWorkQueueReason, type TestloopDotsMetadata } from '@/sync/testloopDots';
import { kindLabel } from '@/sync/dotMemoryKinds';
import { t } from '@/text';
import { useAuth } from '@/auth/AuthContext';
import { getServerUrl } from '@/sync/serverConfig';
import { dotMemoryEditError, dotMemoryEditRejected, dotMemoryValueBytes, DOT_MEMORY_VALUE_MAX_BYTES, readDotMemoryTombstone, requestDotMemoryEdit, type DotMemoryEditRequest } from '@/sync/dotMemoryEdit';
import { observationError } from '@/sync/dotObservation';
import { useDotsWorkspace } from './useDotsWorkspace';
import { DotsConnectionsPanel } from './DotsConnectionsPanel';
import { DotObservationPanel } from './DotObservationPanel';
import { DotMemoryToolHint } from './DotMemoryToolHint';
import { DotRecoveryNotice } from './DotRecoveryNotice';
import { ToolCallRendererContext, type ToolCallRenderer } from '@/components/tools/ToolCallRendererContext';
import { dotMemoryHint, type DotMemoryTarget } from '@/utils/dotMemoryTool';

type DotMetadata = Extract<TestloopDotsMetadata, { kind: 'dot' }>;
type Tab = 'chat' | 'work' | 'memory';
const tabLabels = { chat: '对话', work: '工作', memory: '记忆' };
type MemoryDraft = { binding: object; action: 'remember' | 'forget'; scope: 'dot' | 'user'; key: string; text: string;
    kind: 'fact' | 'preference' | 'commitment'; json: boolean; expiresAt: string | null; existing: boolean; revision: number; savedText?: string };
type MemoryTarget = DotMemoryTarget & { nonce: number };
const memoryDraftKey = (draft: Pick<MemoryDraft, 'scope' | 'key'>) => JSON.stringify([draft.scope, draft.key.trim().normalize('NFC')]);

/** Keep Happy's real conversation mounted while its host-backed work/memory panel changes. */
export function DotSessionContent({ session, metadata, active, children, topInset = 0, retired = false }: {
    session: Pick<Session, 'id' | 'presence'>; metadata: DotMetadata; active: boolean; retired?: boolean;
    children: (request: { id: string; text: string } | null) => React.ReactNode; topInset?: number;
}) {
    const { theme } = useUnistyles();
    const { credentials, isAuthenticated } = useAuth(), server = getServerUrl();
    const colors = theme.colors;
    const realtime = useRealtimeStatus();
    useSessionVisibility(session.id, active && !retired, false, realtime);
    const data = useDotsWorkspace(metadata.workspaceSessionId, metadata.workspaceId, active, metadata.dotId);
    const pending = data.pendingFor(metadata.dotId);
    const currentDots = React.useRef(data);
    currentDots.current = data;
    const navigate = useNavigateToSession();
    const navigation = React.useMemo(createTestloopDotsNavigationGuard, []);
    const [width, setWidth] = React.useState(0), [tab, setTab] = React.useState<Tab>('chat');
    const [managingConnections, setManagingConnections] = React.useState(false);
    const [sideTab, setSideTab] = React.useState<Exclude<Tab, 'chat'>>('work'), [expanded, setExpanded] = React.useState(true);
    const [diagnosticMode, setDiagnosticMode] = React.useState<'activity' | 'basis' | null>(null);
    const [taskId, setTaskId] = React.useState<string | null>(null), [error, setError] = React.useState<string | null>(null);
    const [memoryEdit, setMemoryEdit] = React.useState<MemoryDraft | null>(null);
    const [memoryBusy, setMemoryBusy] = React.useState(false), [memoryUnknown, setMemoryUnknown] = React.useState(false);
    const [memoryError, setMemoryError] = React.useState<string | null>(null), [memoryRefresh, setMemoryRefresh] = React.useState(0);
    const [memoryOpen, setMemoryOpen] = React.useState(false);
    const [memoryTarget, setMemoryTarget] = React.useState<MemoryTarget | null>(null);
    const memoryBinding = React.useMemo(() => ({}), [session.id, metadata.workspaceId, metadata.workspaceSessionId, metadata.dotId,
        credentials?.token, credentials?.secret, server, isAuthenticated, retired]);
    const memoryCurrent = React.useRef({ binding: memoryBinding, active });
    memoryCurrent.current = { binding: memoryBinding, active };
    const memoryAttempt = React.useRef<{ binding: object; request: DotMemoryEditRequest; running: boolean; uncertain: boolean } | null>(null);
    const memoryConflictDrafts = React.useRef(new Map<string, MemoryDraft>());
    const [notice, setNotice] = React.useState<string | null>(null);
    const [clearConfirming, setClearConfirming] = React.useState(false);
    const [composeRequest, setComposeRequest] = React.useState<{ id: string; text: string } | null>(null);
    const wide = width >= 920;
    const wideRef = React.useRef(wide);
    wideRef.current = wide;
    const memoryNonce = React.useRef(0);
    // Hint targets open the observation panel without touching the chat draft.
    const openMemory = React.useCallback((target: DotMemoryTarget) => {
        setMemoryTarget({ keyDigest: target.keyDigest, scope: target.scope, nonce: ++memoryNonce.current });
        setMemoryOpen(false); setDiagnosticMode(null); setTaskId(null);
        if (wideRef.current) { setSideTab('memory'); setExpanded(true); } else setTab('memory');
    }, []);
    const renderDotMemoryTool = React.useCallback<ToolCallRenderer>(({ tool }) => {
        const hint = dotMemoryHint(tool);
        return hint ? <DotMemoryToolHint hint={hint} onOpen={openMemory} /> : undefined;
    }, [openMemory]);
    const own = data.projection?.snapshot?.dots.some(dot => dot.id === metadata.dotId && dot.sessionId === session.id);
    const view = own ? data.projection?.details[metadata.dotId] : undefined;
    const detail = view?.data;
    const selectedTask = detail?.tasks.find(task => task.id === taskId);
    type Delivery = NonNullable<NonNullable<typeof detail>['pendingIntegration']>['items'][number];
    const pendingByProject = new Map<string, Delivery[]>();
    for (const delivery of detail?.pendingIntegration?.items ?? []) {
        const project = pendingByProject.get(delivery.projectID) ?? [];
        project.push(delivery);
        pendingByProject.set(delivery.projectID, project);
    }
    useFocusEffect(React.useCallback(() => {
        navigation.update(`${session.id}:${metadata.workspaceId}:${metadata.dotId}`, active);
        return () => navigation.invalidate();
    }, [navigation, session.id, metadata.workspaceId, metadata.dotId, active, memoryBinding]));
    React.useEffect(() => {
        memoryAttempt.current = null; setMemoryEdit(null); setMemoryOpen(false); setMemoryBusy(false); setMemoryUnknown(false); setMemoryError(null);
        memoryConflictDrafts.current.clear();
        setNotice(null); setDiagnosticMode(null); setMemoryTarget(null);
    }, [memoryBinding]);
    React.useEffect(() => {
        memoryCurrent.current = { binding: memoryBinding, active };
        return () => { memoryCurrent.current = { binding: {}, active: false }; };
    }, [memoryBinding, active]);
    const memoryBindingIsCurrent = () => memoryCurrent.current.binding === memoryBinding
        && isAuthenticated && Boolean(credentials?.token) && sync.getCredentials()?.token === credentials?.token
        && sync.getCredentials()?.secret === credentials?.secret && getServerUrl() === server;
    const memoryIsCurrent = () => !retired && memoryBindingIsCurrent() && memoryCurrent.current.active
        && currentDots.current.ready && currentDots.current.projection?.snapshot?.dots.some(dot => dot.id === metadata.dotId && dot.sessionId === session.id);
    const beginMemoryEdit = (draft: Omit<MemoryDraft, 'binding'>) => {
        if (!memoryIsCurrent()) { setNotice('工作台数据还没就绪，稍后再处理这条记忆。'); return; }
        if (memoryAttempt.current?.binding === memoryBinding) { setMemoryOpen(true); return; }
        const conflict = draft.action === 'remember' ? memoryConflictDrafts.current.get(memoryDraftKey(draft)) : undefined;
        setMemoryEdit({ ...draft, binding: memoryBinding, ...(conflict ? { text: conflict.text, json: conflict.json,
            expiresAt: conflict.expiresAt, savedText: draft.text } : {}) });
        setMemoryOpen(true); setMemoryError(null); setMemoryUnknown(false); setNotice(null);
    };
    const saveMemory = async () => {
        if (!memoryIsCurrent() || !memoryEdit || memoryEdit.binding !== memoryBinding || memoryAttempt.current?.running) return;
        let attempt = memoryAttempt.current;
        if (!attempt) {
            let operation: DotMemoryEditRequest['operation'];
            if (memoryEdit.action === 'forget') operation = { action: 'forget', key: memoryEdit.key, revision: memoryEdit.revision };
            else {
                if (!memoryEdit.key.trim() || !memoryEdit.text.trim()) { setMemoryError('请填写记忆名称和内容。'); return; }
                let value;
                try { value = memoryEdit.json ? JSON.parse(memoryEdit.text) : memoryEdit.text; }
                catch { setMemoryError('内容不是有效的 JSON，请修正后重试。'); return; }
                const valueBytes = dotMemoryValueBytes(value);
                if (valueBytes > DOT_MEMORY_VALUE_MAX_BYTES) {
                    setMemoryError(dotMemoryEditError(new Error('memory_edit_invalid_request'))); return;
                }
                const expiry = memoryEdit.expiresAt?.trim() || null;
                if (expiry && (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiry) || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now())) {
                    setMemoryError('请输入包含时区的未来 ISO 时间，或清空有效期。'); return;
                }
                operation = { action: 'remember', key: memoryEdit.key.trim().normalize('NFC'), revision: memoryEdit.revision,
                    kind: memoryEdit.kind, value, expiresAt: expiry ? new Date(expiry).toISOString() : null };
            }
            attempt = { binding: memoryBinding, running: false, uncertain: false, request: { schemaVersion: 1, workspaceId: metadata.workspaceId,
                dotId: metadata.dotId, dotSessionId: session.id, scope: memoryEdit.scope, requestID: randomUUID(), operation } };
            memoryAttempt.current = attempt;
        }
        if (attempt.binding !== memoryBinding) return;
        attempt.running = true; setMemoryBusy(true); setMemoryError(null);
        let recreationChecked = false;
        try {
            for (;;) {
                try {
                    const receipt = await requestDotMemoryEdit(metadata.workspaceSessionId, attempt.request);
                    // An already submitted write still resolves while its screen is hidden or refreshing.
                    if (!memoryBindingIsCurrent() || memoryAttempt.current !== attempt) return;
                    memoryConflictDrafts.current.delete(memoryDraftKey(memoryEdit));
                    memoryAttempt.current = null; setMemoryEdit(null); setMemoryOpen(false); setMemoryUnknown(false); setMemoryRefresh(value => value + 1);
                    setNotice(receipt.currentRevision > receipt.revision ? '此次记忆操作已完成，记忆已有后续修改，正在刷新最新内容。'
                        : receipt.action === 'forget' ? '记忆已忘记。' : '记忆已保存。');
                    return;
                } catch (failure) {
                    if (!memoryBindingIsCurrent() || memoryAttempt.current !== attempt) return;
                    const attemptOperation: DotMemoryEditRequest['operation'] = attempt.request.operation;
                    if (!recreationChecked && !attempt.uncertain && failure instanceof Error && failure.message === 'memory_edit_revision_conflict'
                        && memoryEdit.action === 'remember' && !memoryEdit.existing && attemptOperation.action === 'remember' && attemptOperation.revision === 0) {
                        recreationChecked = true;
                        let tombstoneRevision: number | null;
                        try { tombstoneRevision = await readDotMemoryTombstone(metadata.workspaceSessionId, metadata.dotId, memoryEdit.scope, attemptOperation.key); }
                        catch (readFailure) {
                            memoryAttempt.current = null; memoryConflictDrafts.current.set(memoryDraftKey(memoryEdit), memoryEdit);
                            setMemoryError(observationError(readFailure)); return;
                        }
                        if (!memoryBindingIsCurrent() || memoryAttempt.current !== attempt) return;
                        if (tombstoneRevision !== null) {
                            const confirmed = await GlobalModal.confirm(t('common.recreateMemoryTitle'),
                                t('common.recreateMemoryMessage', { key: attemptOperation.key, revision: tombstoneRevision }), { confirmText: t('common.create') });
                            if (!memoryBindingIsCurrent() || memoryAttempt.current !== attempt) return;
                            if (confirmed) {
                                attempt = { binding: memoryBinding, running: true, uncertain: false, request: { ...attempt.request,
                                    requestID: randomUUID(), operation: { ...attemptOperation, revision: tombstoneRevision } } };
                                memoryAttempt.current = attempt;
                                continue;
                            }
                        }
                    }
                    if (!attempt.uncertain && dotMemoryEditRejected(failure)) {
                        memoryAttempt.current = null;
                        if (failure instanceof Error && failure.message === 'memory_edit_revision_conflict' && memoryEdit.action === 'remember')
                            memoryConflictDrafts.current.set(memoryDraftKey(memoryEdit), memoryEdit);
                    }
                    else { attempt.uncertain = true; setMemoryUnknown(true); }
                    setMemoryError(dotMemoryEditError(failure) + (attempt.uncertain && dotMemoryEditRejected(failure) ? ' 上次请求结果仍待核对，重试会沿用原请求。' : ''));
                    return;
                }
            }
        } finally {
            attempt.running = false;
            if (memoryCurrent.current.binding === memoryBinding) setMemoryBusy(false);
        }
    };
    const body = { color: colors.text, fontSize: 14, lineHeight: 23 };
    const muted = { color: colors.textSecondary, fontSize: 12, lineHeight: 21 };
    const heading = { color: colors.text, fontSize: 17, fontWeight: '600' as const };
    const button = { minHeight: 44, padding: 12, borderRadius: 10, backgroundColor: colors.surfaceHigh, justifyContent: 'center' as const };
    const action = (label: string, onPress: () => void, disabled = false, compact = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
        onPress={onPress} style={[button, compact && { minHeight: 34, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8 }, { opacity: disabled ? 0.5 : 1 }]}><Text style={body}>{label}</Text></Pressable>;
    // The selected tab owns the only filled chip, so the highlight can never be
    // mistaken for the page or another tab: weight and color move with it too.
    const tabButton = (item: Tab, selected: boolean, onPress: () => void, grow = false) => <Pressable key={item}
        accessibilityRole="tab" aria-selected={selected} accessibilityState={{ selected }} onPress={onPress}
        style={[button, { alignItems: 'center', backgroundColor: selected ? colors.surfaceSelected : 'transparent' }, grow && { flexGrow: 1 }]}>
        <Text style={selected ? [body, { fontWeight: '600' as const }] : [body, { color: colors.textSecondary }]}>{tabLabels[item]}</Text></Pressable>;
    const toConversation = (text: string) => {
        setComposeRequest({ id: `${session.id}:${Date.now()}`, text });
        setTab('chat'); setTaskId(null); setMemoryOpen(false); if (!memoryAttempt.current) setMemoryEdit(null);
        setNotice('已放入对话输入框。核对后发送，结果会回到这个 Dot。');
    };
    const replacement = data.projection?.snapshot?.ok ? data.projection.snapshot.dots.find(d => d.id === metadata.dotId)?.sessionId : undefined;
    React.useEffect(() => {
        if (!active || !replacement || replacement === session.id || pending?.request.action === 'clear') return;
        const operation = navigation.begin();
        if (!operation) return;
        void operation.afterReady(() => sync.ensureSessionReady(replacement), () => {
            if (currentDots.current.projection?.snapshot?.dots.find(d => d.id === metadata.dotId)?.sessionId === replacement) navigate(replacement);
        }).catch(() => { if (operation.isCurrent()) setError('新对话暂时无法打开，请返回工作台刷新重试。'); });
    }, [active, replacement, session.id, navigation, metadata.dotId, navigate, pending?.request.action, memoryBinding]);
    const clearConversation = async () => {
        if (clearConfirming || currentDots.current.pendingFor(metadata.dotId)) return;
        const current = currentDots.current.projection?.snapshot;
        const dot = current?.dots.find(item => item.id === metadata.dotId && item.sessionId === session.id);
        if (!dot) return;
        const operation = navigation.begin();
        if (!operation) return;
        setClearConfirming(true);
        try {
            const confirmed = await GlobalModal.confirm('清空当前对话？',
                '将删除当前聊天记录并重置模型上下文，正在进行的聊天轮次会停止。用户与 Dot 长期记忆、身份、模型设置和授权保留；独立后台任务继续运行，旧任务回报不注入新对话。此操作不可撤销。',
                { confirmText: '清空对话' });
            if (!confirmed || !operation.isCurrent() || currentDots.current.pendingFor(metadata.dotId)) return;
            const latestDot = currentDots.current.projection?.snapshot?.dots
                .find(item => item.id === metadata.dotId && item.sessionId === session.id);
            if (!latestDot) return;
            await currentDots.current.submit({ schemaVersion: 1, requestId: randomUUID(), action: 'clear', dotId: metadata.dotId });
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
    const observationPanel = (mode: 'memory' | 'activity' | 'basis') => <>
        <DotObservationPanel key={`${metadata.dotId}:${mode}:${mode === 'memory' ? memoryTarget?.nonce ?? 0 : 0}`} sessionId={metadata.workspaceSessionId}
            workspaceId={metadata.workspaceId} dotId={metadata.dotId} dotSessionId={session.id} active={Boolean(active && own && (mode !== 'memory' || (wide ? expanded : tab === 'memory')))}
            mode={mode}
            presence={session.presence} refreshKey={memoryRefresh}
            initialMemory={mode === 'memory' && memoryTarget ? { keyDigest: memoryTarget.keyDigest, scope: memoryTarget.scope } : null}
            onExecution={id => void openExecution(id)}
            onEditMemory={(key, version, scope = 'dot') => {
                beginMemoryEdit({ action: 'remember', scope, key, revision: version.revision, text: typeof version.value === 'string' ? version.value : JSON.stringify(version.value),
                    kind: version.kind as MemoryDraft['kind'], json: typeof version.value !== 'string', expiresAt: version.expiresAt, existing: true });
            }} onForgetMemory={(key, revision, scope = 'dot') => {
                beginMemoryEdit({ action: 'forget', scope, key, revision, text: '', kind: 'fact', json: false, expiresAt: null, existing: true });
            }} onAddMemory={(scope = 'dot') => {
                beginMemoryEdit({ action: 'remember', scope, key: '', revision: 0, text: '', kind: 'preference', json: false, expiresAt: null, existing: false });
            }} />
    </>;
    const panel = <View style={{ flex: 1, minHeight: 0 }}>
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {wide && (['work', 'memory'] as const).map(item => tabButton(item, sideTab === item, () => setSideTab(item)))}
            {(wide ? sideTab : tab) === 'work' && action('刷新工作项', () => void data.refresh(), data.refreshing, !wide)}
            {action('诊断详情', () => setDiagnosticMode('activity'), false, !wide)}
            {action('清空当前对话', () => void clearConversation(), !data.ready || !own || Boolean(pending) || clearConfirming, !wide)}
            {action('可用连接与项目', () => setManagingConnections(true), false, !wide)}
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
            {data.refreshing && <Text style={body}>正在刷新工作与记忆…</Text>}
            {pending && <Text accessibilityLiveRegion="polite" style={body}>{pending.message}</Text>}
            {(data.error || error) && <Text accessibilityRole="alert" style={body}>{data.error || error}</Text>}
            {pending && action('核对回执', () => void data.checkReceipt(pending.request.requestId), pending.checking)}
            {(wide ? sideTab : tab) !== 'work' ? observationPanel('memory') : !detail ? <Text style={muted}>尚未收到这个 Dot 的工作快照，请刷新核对。</Text> : <>
                    <Text style={heading}>工作项 · {detail.taskTotal}</Text>
                    <Text style={muted}>不同项目可以同时执行，同一项目默认最多 2 项，其余按排队顺序开始。</Text>
                    {detail.tasks.map(task => <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={`查看工作项：${task.title}`} onPress={() => setTaskId(task.id)} style={{ gap: 6, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                        <Text style={body}>{task.title}</Text><Text style={muted}>{testloopWorkStatus(task)}{task.projectID ? ` · ${task.projectID}` : ''}</Text>
                        {task.queueID && (task.status === 'queued' || task.status === 'waiting-resource') && task.recovery
                            ? <Text numberOfLines={2} style={muted}>{task.recovery}</Text> : null}
                    </Pressable>)}
                    {!detail.tasks.length && <Text style={muted}>这个 Dot 还没有可查看的工作项。在对话中交办即可。</Text>}
                    {detail.taskTotal > detail.tasks.length && <Text style={muted}>当前展示 {detail.tasks.length} 项，其余工作可在对话中按名称或编号查询。</Text>}
                    {detail.pendingIntegration && <>
                        <Text accessibilityRole="header" style={heading}>待集成 · {detail.pendingIntegration.total}</Text>
                        {[...pendingByProject].map(([project, deliveries]) => <View key={project} style={{ gap: 8 }}>
                            <Text style={heading}>{project}</Text>
                            {deliveries.map(delivery => <View key={delivery.id} style={{ gap: 4, paddingVertical: 8 }}>
                                <Text style={body}>{delivery.title}</Text>
                                <Text selectable style={muted}>{delivery.commit}</Text>
                                <Text selectable style={muted}>{delivery.test ? `${delivery.test.command} · ${delivery.test.exitCode === 0 ? '通过' : '失败'}（退出码 ${delivery.test.exitCode}）` : '未测'}</Text>
                                {delivery.sessionId && action('查看执行会话', () => void openExecution(delivery.sessionId!))}
                            </View>)}
                        </View>)}
                        {detail.pendingIntegration.total > detail.pendingIntegration.items.length && <Text style={muted}>当前展示 {detail.pendingIntegration.items.length} 项。</Text>}
                    </>}
                </>}
            {view && <Text style={muted}>更新于 {new Date(view.asOf).toLocaleString()}</Text>}
        </ScrollView>
    </View>;
    if (retired) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, paddingTop: topInset, gap: 12 }}>
        <Text accessibilityRole="header" style={body}>旧对话已删除</Text>
        {pending && <>
            <Text accessibilityLiveRegion="polite" style={body}>{pending.message}</Text>
            {action('核对回执', () => void data.checkReceipt(pending.request.requestId), pending.checking)}
        </>}
        {(data.error || error) && <Text accessibilityRole="alert" style={body}>{data.error || error}</Text>}
    </View>;
    return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flex: 1, minHeight: 0, paddingTop: topInset }}>
        {managingConnections && active && <DotsConnectionsPanel key={`${session.id}:${metadata.dotId}`} sessionId={metadata.workspaceSessionId} workspaceId={metadata.workspaceId} dotId={metadata.dotId} onClose={() => setManagingConnections(false)} />}
        {wide ? <View style={{ alignItems: 'flex-end', paddingHorizontal: 16 }}>{action(expanded ? '收起工作栏' : '展开工作栏', () => setExpanded(value => !value))}</View>
            : <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', padding: 8, gap: 4 }}>{(['chat', 'work', 'memory'] as Tab[]).map(item => tabButton(item, tab === item, () => setTab(item), true))}</View>}
        {(data.notice || notice) && <View style={{ marginHorizontal: 14, marginVertical: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.surfaceHigh }}>
            <Text accessibilityLiveRegion="polite" style={[muted, { color: colors.textSecondary }]}>{notice || data.notice}</Text>
        </View>}
        <View style={{ flex: 1, minHeight: 0, flexDirection: 'row' }}>
            <View style={{ flex: 1, display: wide || tab === 'chat' ? 'flex' : 'none', minWidth: 0 }}>
                <DotRecoveryNotice key={session.id} workspaceId={metadata.workspaceId} dotId={metadata.dotId} sessionId={session.id} online={session.presence === 'online'} />
                <ToolCallRendererContext.Provider value={renderDotMemoryTool}>{children(composeRequest)}</ToolCallRendererContext.Provider>
            </View>
            <View style={{ width: wide ? 320 : '100%', display: wide ? expanded ? 'flex' : 'none' : tab === 'chat' ? 'none' : 'flex', borderLeftWidth: wide ? 1 : 0, borderLeftColor: colors.divider }}>{panel}</View>
        </View>
        {diagnosticMode && active && own && sheet('诊断详情', () => setDiagnosticMode(null), <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {action('活动记录', () => setDiagnosticMode('activity'))}{action('本轮依据', () => setDiagnosticMode('basis'))}
            </View>
            {observationPanel(diagnosticMode)}
        </>)}
        {selectedTask && sheet(selectedTask.title, () => setTaskId(null), <>
            <Text style={body}>{testloopWorkStatus(selectedTask)}</Text>
            <Text style={body}>{selectedTask.instruction}</Text>
            {selectedTask.dispatchOptions && <Text style={muted}>{selectedTask.dispatchOptions.confirmed ? '执行回执' : '派活参数'}：{[
                selectedTask.dispatchOptions.agent, selectedTask.dispatchOptions.model, selectedTask.dispatchOptions.effort,
            ].filter(Boolean).join(' / ')}{(!selectedTask.dispatchOptions.confirmed && (!selectedTask.dispatchOptions.model || !selectedTask.dispatchOptions.effort)) ? '（未指定项由执行机决定）' : ''}</Text>}
            {selectedTask.projectID && <Text style={muted}>项目：{selectedTask.projectID}</Text>}
            {selectedTask.queueReason && <Text style={muted}>排队原因：{testloopWorkQueueReason(selectedTask.queueReason)}</Text>}
            {selectedTask.execution && <><Text selectable style={muted}>执行位置：{selectedTask.execution.directory}</Text>{selectedTask.execution.branch && <Text selectable style={muted}>分支：{selectedTask.execution.branch}</Text>}{selectedTask.execution.resultCommit && <Text selectable style={muted}>提交：{selectedTask.execution.resultCommit}</Text>}{selectedTask.execution.dirty && <Text style={muted}>存在未提交改动，现场已保留</Text>}</>}
            {selectedTask.execution?.testCleanup && <Text style={muted}>{selectedTask.execution.testCleanup === 'removed' ? '临时测试目录已清理' : '临时测试目录已保留'}</Text>}
            {selectedTask.execution?.source && <Text style={muted}>{selectedTask.execution.source === 'baseline' ? '固定的已提交基线' : '执行时取得的 checkout 快照'}</Text>}
            {selectedTask.execution?.workspaceState === 'retired' && <Text style={muted}>Workspace Owner 已归档并释放工作树</Text>}
            <DotTaskTiming timing={selectedTask.timing} waitingSince={selectedTask.waitingSince} style={muted} />
            {selectedTask.recovery && <Text style={muted}>{selectedTask.recovery}</Text>}
            {selectedTask.canCancel && action('在对话中取消此工作', () => toConversation(`请取消当前 Dot 的工作项 ${selectedTask.id}，只取消这一交办，保留已有改动，并核对停止结果。`))}
            {selectedTask.reason && <Text style={muted}>状态原因：{testloopWorkQueueReason(selectedTask.reason)}</Text>}
            {selectedTask.nextWakeAt && <Text style={muted}>{selectedTask.queueID ? '下次状态检查' : '最早执行时间'}：{new Date(selectedTask.nextWakeAt).toLocaleString()}</Text>}
            {selectedTask.steps.map(step => <Text key={step.id} style={body}>{step.title} · {step.status}</Text>)}
            {['delegate', 'goal'].includes(selectedTask.kind) && <Text style={muted}>{selectedTask.businessVerification === 'independent_agent_report' ? '已有独立执行会话提供的验收报告' : '业务验收尚未核验'}</Text>}
            {selectedTask.result && <><Text style={heading}>实际回报{selectedTask.resultTruncated ? '（已截断）' : ''}</Text><Text selectable style={body}>{selectedTask.result}</Text></>}
            {selectedTask.executionSessionId && action('查看执行会话', () => void openExecution(selectedTask.executionSessionId!))}
            {action('在对话中跟进此工作', () => toConversation(`请跟进当前 Dot 的工作项 ${selectedTask.id}（${selectedTask.title}），说明最新进展和仍需处理的事项。`))}
        </>)}
        {!memoryOpen && memoryEdit?.binding === memoryBinding && memoryAttempt.current && <View style={{ padding: 12 }}>
            {action('恢复上次记忆操作', () => setMemoryOpen(true))}
        </View>}
        {memoryOpen && memoryEdit?.binding === memoryBinding && data.ready && own && sheet(memoryEdit.action === 'forget' ? '忘记记忆' : memoryEdit.existing ? '修改记忆' : '添加记忆', () => {
            setMemoryOpen(false);
            if (memoryConflictDrafts.current.has(memoryDraftKey(memoryEdit))) {
                memoryConflictDrafts.current.set(memoryDraftKey(memoryEdit), memoryEdit);
                setNotice('草稿已保留。刷新记忆并重新编辑同一条即可继续。');
            }
            if (!memoryAttempt.current) setMemoryEdit(null);
        }, <>
            <Text style={muted}>范围：{memoryEdit.scope === 'user' ? '用户级 · 所有Dot共享' : 'Dot级 · 当前Dot私有'}</Text>
            {memoryEdit.action === 'forget' ? <Text style={body}>确认忘记「{memoryEdit.key}」？此操作只影响以上范围的这条记忆。</Text> : <>
            {memoryEdit.savedText !== undefined && <>
                <Text style={muted}>已恢复未保存的草稿，请核对当前内容后保存。</Text>
                <Text style={muted}>当前已保存内容（第 {memoryEdit.revision} 版）</Text><Text selectable style={body}>{memoryEdit.savedText}</Text>
            </>}
            <Text style={muted}>名称</Text><TextInput accessibilityLabel="记忆名称" value={memoryEdit.key} editable={!memoryEdit.existing && !memoryBusy && !memoryUnknown} onChangeText={key => setMemoryEdit(previous => previous && ({ ...previous, key }))} maxLength={200} style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, padding: 12, borderRadius: 10 }} />
            <Text style={muted}>类型{memoryEdit.existing ? '（创建后固定）' : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {(['fact', 'preference', 'commitment'] as const).map(item => <Pressable key={item} accessibilityRole="button"
                    accessibilityLabel={`记忆类型：${kindLabel(item)}`} accessibilityState={{ selected: memoryEdit.kind === item }}
                    disabled={memoryEdit.existing || memoryBusy || memoryUnknown} onPress={() => setMemoryEdit(previous => previous && ({ ...previous, kind: item }))}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
                        borderColor: memoryEdit.kind === item ? colors.surfaceHigh : colors.divider,
                        backgroundColor: memoryEdit.kind === item ? colors.surfaceHigh : 'transparent', opacity: memoryEdit.existing ? 0.6 : 1 }}>
                    <Text style={{ color: colors.text, fontSize: 13 }}>{kindLabel(item)}</Text></Pressable>)}
            </View>
            <Text style={muted}>{memoryEdit.savedText !== undefined ? '待保存草稿' : memoryEdit.json ? 'JSON 内容' : '内容'}</Text><TextInput accessibilityLabel="记忆内容" value={memoryEdit.text} editable={!memoryBusy && !memoryUnknown} maxLength={4096} onChangeText={text => setMemoryEdit(previous => previous && ({ ...previous, text }))} multiline style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, minHeight: 120, padding: 12, borderRadius: 10, textAlignVertical: 'top' }} />
            <Text style={muted}>有效期（ISO 时间，留空表示不设到期）</Text><TextInput accessibilityLabel="记忆有效期" value={memoryEdit.expiresAt ?? ''} editable={!memoryBusy && !memoryUnknown} onChangeText={expiresAt => setMemoryEdit(previous => previous && ({ ...previous, expiresAt: expiresAt || null }))} style={{ color: colors.text, borderWidth: 1, borderColor: colors.divider, padding: 12, borderRadius: 10 }} />
            </>}
            {memoryError && <Text accessibilityRole="alert" style={body}>{memoryError}</Text>}
            {memoryBusy && <ActivityIndicator />}
            {action(memoryUnknown ? '重试上次记忆操作' : memoryEdit.action === 'forget' ? '确认忘记' : '保存记忆', () => void saveMemory(), memoryBusy)}
        </>)}
    </View>;
}
