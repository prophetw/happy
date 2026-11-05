import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata, testloopWorkStatus } from '@/sync/testloopDots';
import { ObservationOverviewSchema, ObservationResponseSchema, observationError, observationMemoryStatus, observationReasons,
    requestDotObservation, type ObservationEvent, type ObservationMemoryVersion, type ObservationOverview,
    type ObservationRequest, type ObservationResponse } from '@/sync/dotObservation';

type Mode = 'activity' | 'memory' | 'basis';
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '未记录';
const label = (key: string | null, digest: string) => key ?? `记忆 ${digest.slice(7, 19)}…`;
const states: Record<string, string> = { queued: '等待处理', planning: '理解需求中', decided: '已形成决定', applied: '已处理',
    blocked: '遇到阻塞', rejected: '已拒绝', proposed: '已提出，待确认', accepted: '已接受', superseded: '已被新提案替代',
    preparing: '准备执行', running: '执行中', paused: '已暂停', awaiting_user: '等待你的答复', awaiting_approval: '等待审批',
    succeeded: '已完成', failed: '执行失败', canceled: '已取消', executing: '执行中', reviewing: '独立验收中', repairing: '返工中',
    canceling: '取消中', completed: '执行结束', observing: '等待执行回报', creating: '创建执行会话', sending: '发送交办', prepared: '准备派工' };
function eventTitle(event: ObservationEvent) {
    if (event.kind === 'delivery') return `回报 · ${{ pending: '等待发送', accepted: '服务端已接收，待核对入库', stored_verified: '已核对入库', error: '发送错误' }[event.status] ?? event.status}`;
    if (event.kind === 'dot') return event.previousStatus ? '名称或职责已修改' : 'Dot 已创建';
    if (event.kind === 'memory') return `${event.status === 'deleted' ? '已忘记' : event.status === 'confirm' ? '已确认' : '已保存或更新'}：${label(event.label, event.keyDigest!)}`;
    const status = event.status.split(':').map(item => states[item] ?? item).join(' · ');
    return `${event.kind === 'turn' ? '对话' : event.kind === 'memory-proposal' ? '记忆提案' : '工作'} · ${status}`;
}

/** Reads only. Every asynchronous result remains bound to the account, workspace, Dot and visible screen. */
export function DotObservationPanel({ sessionId, workspaceId, dotId, dotSessionId, active, mode, presence,
    onExecution, onEditMemory, onForgetMemory, onAddMemory }: {
    sessionId: string; workspaceId: string; dotId: string; dotSessionId: string; active: boolean; mode: Mode; presence: string | number;
    onExecution: (sessionId: string) => void;
    onEditMemory: (key: string, version: ObservationMemoryVersion) => void; onForgetMemory: (key: string) => void;
    onAddMemory: () => void;
}) {
    const { theme } = useUnistyles(), { credentials, isAuthenticated } = useAuth(), server = getServerUrl();
    const scope = React.useMemo(() => ({}), [credentials?.token, credentials?.secret, isAuthenticated, server, sessionId, workspaceId, dotId, dotSessionId, mode]);
    const initial = React.useMemo<ObservationRequest>(() => ({ dotId, action: mode === 'memory' ? 'memories' : mode === 'basis' ? 'turns' : 'activity' }), [dotId, mode]);
    const [loaded, setLoaded] = React.useState<{ scope: object; overview: ObservationOverview; result: ObservationResponse; query: ObservationRequest } | null>(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const [showDecision, setShowDecision] = React.useState(false);
    const epoch = React.useRef(0), focused = React.useRef(false), foreground = React.useRef(true);
    const valid = React.useCallback(() => {
        const sessions = storage.getState().sessions, workspace = readTestloopDotsMetadata(sessions[sessionId]?.metadata);
        const dot = readTestloopDotsMetadata(sessions[dotSessionId]?.metadata);
        return active && foreground.current && focused.current && isAuthenticated && Boolean(credentials?.token)
            && sync.getCredentials()?.token === credentials?.token && sync.getCredentials()?.secret === credentials?.secret
            && getServerUrl() === server && workspace?.kind === 'workspace' && workspace.workspaceId === workspaceId
            && dot?.kind === 'dot' && dot.dotId === dotId && dot.workspaceId === workspaceId && dot.workspaceSessionId === sessionId;
    }, [active, isAuthenticated, credentials?.token, credentials?.secret, server, sessionId, dotSessionId, workspaceId, dotId]);
    const load = React.useCallback(async (query: ObservationRequest) => {
        const version = ++epoch.current;
        if (!valid()) return;
        setBusy(true); setError(null); setLoaded(null); setShowDecision(false);
        try {
            await sync.ensureSessionReady(sessionId);
            if (version !== epoch.current || !valid()) return;
            const [overview, result] = await Promise.all([
                requestDotObservation(sessionId, { dotId, action: 'overview' }, ObservationOverviewSchema),
                requestDotObservation(sessionId, query, ObservationResponseSchema),
            ]);
            if (version === epoch.current && valid()) setLoaded({ scope, overview, result, query });
        } catch (failure) { if (version === epoch.current && valid()) setError(observationError(failure)); }
        finally { if (version === epoch.current) setBusy(false); }
    }, [valid, sessionId, dotId, scope]);
    useFocusEffect(React.useCallback(() => {
        focused.current = true; void load(initial);
        return () => { focused.current = false; epoch.current++; };
    }, [load, initial]));
    React.useEffect(() => {
        const listener = AppState.addEventListener('change', state => {
            foreground.current = state === 'active';
            if (!foreground.current) { epoch.current++; setLoaded(null); setBusy(false); }
            else if (focused.current) void load(initial);
        });
        return () => listener.remove();
    }, [load, initial]);
    const shown = loaded?.scope === scope && valid() ? loaded : null;
    const result = shown?.result, overview = shown?.overview;
    const colors = theme.colors;
    const body = { color: colors.text, fontSize: 14, lineHeight: 23 }, muted = { color: colors.textSecondary, fontSize: 12, lineHeight: 21 };
    const card = { gap: 8, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.divider };
    const button = (title: string, run: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={busy}
        onPress={run} style={{ padding: 10, minHeight: 44, backgroundColor: colors.surfaceHigh, borderRadius: 10, justifyContent: 'center', opacity: busy ? 0.5 : 1 }}>
        <Text style={body}>{title}</Text></Pressable>;
    const go = (query: Omit<ObservationRequest, 'dotId'>) => { void load({ ...query, dotId } as ObservationRequest); };
    const turn = (turnId: string) => go({ action: 'turn', turnId, section: 'overview' } as Omit<ObservationRequest, 'dotId'>);
    const work = (workId: string) => go({ action: 'work', workId } as Omit<ObservationRequest, 'dotId'>);
    const memory = (keyDigest: string, section: 'versions' | 'usage' = 'versions') => go({ action: 'memory', keyDigest, section } as Omit<ObservationRequest, 'dotId'>);
    const clipped = (value: { text: string; truncated: boolean }) => <Text selectable style={body}>{value.text || '无'}{value.truncated ? '\n（展示内容已截断）' : ''}</Text>;
    const events = (items: ObservationEvent[]) => items.map(event => <View key={event.id} style={card}>
        <Text style={body}>{eventTitle(event)}</Text><Text style={muted}>{date(event.at)}</Text>
        {event.reason && <Text style={muted}>记录原因：{event.reason}</Text>}
        {event.previousIdentity && <><Text style={muted}>修改前：{event.previousIdentity.name}</Text><Text selectable style={body}>{event.previousIdentity.instruction}</Text></>}
        {event.identity && <><Text style={muted}>修改后：{event.identity.name}</Text><Text selectable style={body}>{event.identity.instruction}</Text></>}
        {event.turnId && button('查看本轮依据', () => turn(event.turnId!))}
        {event.workId && button('查看工作经过', () => work(event.workId!))}
        {event.keyDigest && overview?.memory && button('查看记忆记录', () => memory(event.keyDigest!))}
    </View>);
    const listTurns = (items: { id: string; seq: number; createdAt: string; source: string; status: string; trigger: { text: string; truncated: boolean }; memoryRevision?: number }[]) => items.map(item => <View key={`${item.id}:${item.memoryRevision ?? ''}`} style={card}>
        <Text style={body}>第 {item.seq} 轮 · {item.source === 'user' ? '用户消息' : '执行结果事件'}</Text>
        {clipped(item.trigger)}<Text style={muted}>{date(item.createdAt)} · {states[item.status] ?? item.status}{item.memoryRevision ? ` · 带入第 ${item.memoryRevision} 版` : ''}</Text>
        {button(`检查第 ${item.seq} 轮`, () => turn(item.id))}
    </View>);
    const detail = result && (result.action === 'turn' || result.action === 'memory' || result.action === 'work');
    return <View style={{ gap: 14 }}>
        <Text accessibilityRole="header" style={{ ...body, fontSize: 17, fontWeight: '600' }}>Dot 观察台 · {{ activity: '活动', memory: '记忆', basis: '本轮依据' }[mode]}</Text>
        {button('刷新观察台', () => { void load(initial); })}
        {busy && <ActivityIndicator />}
        {error && <Text accessibilityRole="alert" style={body}>{error}</Text>}
        {overview && <View style={{ gap: 5 }}>
            <Text style={muted}>创建于 {date(overview.dot.createdAt)}</Text>
            <Text style={body}>宿主：{{ healthy: '在线且心跳有效', unhealthy: '需要检查', stopped: '扫描器未运行' }[overview.host.status]} · Dot 连接：{presence === 'online' ? '在线' : '待确认'}</Text>
            <Text style={muted}>宿主心跳：{date(overview.host.heartbeatAt)} · 渠道最近读取成功：{date(overview.channel.lastSuccessAt)}</Text>
            {(overview.host.error || overview.channel.error) && <Text accessibilityRole="alert" style={body}>{overview.host.error || overview.channel.error}</Text>}
            <Text style={body}>{overview.processing ? '正在处理对话' : '当前没有待处理对话'} · 共 {overview.taskTotal} 项工作</Text>
            {overview.tasks.map(task => <Text key={task.id} style={muted}>{task.title} · {testloopWorkStatus(task)}</Text>)}
            {overview.memory && <Text style={muted}>记忆 {overview.memory.total} 项 · 有效 {overview.memory.counts.effective} · 待确认 {overview.memory.counts.unconfirmed} · 过期 {overview.memory.counts.expired} · 已忘记 {overview.memory.counts.deleted}</Text>}
            <Text style={muted}>快照读取于 {date(overview.asOf)}；连接中断时不代表远端执行已经停止。</Text>
        </View>}
        {detail && button('返回观察列表', () => { void load(initial); })}
        {result?.action === 'activity' && <>
            <Text style={muted}>开始记录于 {date(overview?.retention.startedAt)}；当前保留自 {date(overview?.retention.retainedFrom)}，最多 {overview?.retention.eventLimit} 条。已清理 {overview?.retention.droppedEvents} 条；更早的经过请查已有对话与记忆历史。</Text>
            {events(result.page.items)}
        </>}
        {result?.action === 'memories' && <>
            {overview?.memory?.access.includes('write') && button('添加记忆', onAddMemory)}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(['all', 'effective', 'unconfirmed', 'expired', 'deleted'] as const).map(status =>
                <React.Fragment key={status}>{button(status === 'all' ? '全部记忆' : observationMemoryStatus[status], () => go({ action: 'memories', status } as Omit<ObservationRequest, 'dotId'>))}</React.Fragment>)}</View>
            {result.page.items.map(item => <View key={item.keyDigest} style={card}>
                <Text style={body}>{label(item.key, item.keyDigest)} · 第 {item.revision} 版</Text><Text style={muted}>{observationMemoryStatus[item.status]}{item.kind ? ` · ${item.kind}` : ''}</Text>
                {item.preview && clipped(item.preview)}{item.deletedAt && <Text style={muted}>忘记于 {date(item.deletedAt)}</Text>}
                {button(`查看记忆：${label(item.key, item.keyDigest)}`, () => memory(item.keyDigest))}
            </View>)}
        </>}
        {result?.action === 'memory' && <>
            <Text style={body}>{label(result.memory.key, result.memory.keyDigest)} · {observationMemoryStatus[result.memory.status]}</Text>
            {button('查看版本变化', () => memory(result.memory.keyDigest))}
            {button('查看历史带入记录', () => memory(result.memory.keyDigest, 'usage'))}
            {result.memory.deletedAt && <Text style={muted}>记忆库正文已清除。忘记于 {date(result.memory.deletedAt)}。历史聊天、提案及封存上下文仍可能保留原内容。</Text>}
            {result.section === 'versions' ? result.page.items.map(version => <View key={version.revision} style={card}>
                <Text style={body}>第 {version.revision} 版 · {version.action === 'confirm' ? '确认' : '保存或更新'} · {version.historical ? '历史版本' : '当前版本'}</Text>
                <Text selectable style={body}>{JSON.stringify(version.value)}</Text>
                <Text style={muted}>来源：{version.source}{version.sourceRef ? ` · ${version.sourceRef}` : ''} · {version.verified ? '已确认' : '未确认'}</Text>
                <Text style={muted}>记录于 {date(version.recordedAt)} · 有效期：{version.expiresAt ? date(version.expiresAt) : '未设到期'}</Text>
                {!version.historical && result.memory.key && <>
                    {overview?.memory?.access.includes('write') && button('编辑这条记忆', () => onEditMemory(result.memory.key!, version))}
                    {overview?.memory?.access.includes('forget') && button('请求忘记这条记忆', () => onForgetMemory(result.memory.key!))}
                </>}
            </View>) : <><Text style={muted}>仅列出账本中保存的有效背景带入记录；带入不代表模型采纳。</Text>{listTurns(result.page.items)}</>}
        </>}
        {result?.action === 'turns' && listTurns(result.page.items)}
        {result?.action === 'turn' && <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{(['overview', 'history', 'memory', 'selection'] as const).map(section =>
                <React.Fragment key={section}>{button({ overview: '轮次概览', history: '带入的历史消息', memory: '带入的记忆', selection: '记忆选择原因' }[section], () => {
                    if (shown?.query.action === 'turn') void load({ dotId, action: 'turn', turnId: shown.query.turnId, section });
                })}</React.Fragment>)}</View>
            {result.section === 'overview' && <>
                <Text style={body}>第 {result.turn.seq} 轮 · {result.turn.source === 'user' ? '用户消息' : '执行结果事件'} · {states[result.turn.status] ?? result.turn.status}</Text>
                <Text style={muted}>上下文冻结于 {date(result.turn.frozenAt)}</Text>
                {!result.turn.contextAvailable && <Text style={muted}>本轮尚无已保存的冻结上下文。</Text>}
                {result.turn.identity && <><Text style={body}>当时的 Dot：{result.turn.identity.name}</Text><Text selectable style={body}>{result.turn.identity.instruction}</Text></>}
                <Text style={muted}>触发内容</Text>{clipped(result.turn.trigger)}<Text style={muted}>实际回复</Text>{clipped(result.turn.reply)}
                <Text style={body}>结构化决定：{result.turn.decisionKind ?? '尚无记录'}</Text>
                {result.turn.decision.text && button(showDecision ? '收起结构化决定' : '查看结构化决定', () => setShowDecision(value => !value))}
                {showDecision && clipped(result.turn.decision)}
                {result.turn.error && <Text accessibilityRole="alert" style={body}>记录错误：{result.turn.error}</Text>}
                {result.turn.deliveries.map((delivery, index) => <Text key={index} style={muted}>回报：{{ pending: '等待发送', accepted: '服务端已接收，待核对入库', stored_verified: '已核对入库', error: '发送错误' }[delivery.status]} · 尝试 {delivery.attempts} 次{delivery.error ? ` · ${delivery.error}` : ''}</Text>)}
                {!result.turn.deliveries.length && <Text style={muted}>本轮尚无可确认的回报关联记录。</Text>}
                {result.turn.relatedWork.map(workId => <React.Fragment key={workId}>{button('查看关联工作', () => work(workId))}</React.Fragment>)}
                {result.turn.calls.map((call, index) => <Text key={call.id} style={muted}>调用 {index + 1}：{date(call.reservedAt)} → {date(call.finishedAt)}{call.elapsedMs !== null ? ` · ${call.elapsedMs}ms` : ''} · 模型及用量未记录</Text>)}
                <Text style={muted}>本轮输入摘要：{result.turn.inputDigest ?? '未记录'}</Text>
            </>}
            {result.section === 'history' && result.page.items.map(item => <View key={item.seq} style={card}>
                <Text style={muted}>第 {item.seq} 轮 · {item.source === 'user' ? '用户消息' : '执行结果事件'}</Text>
                {clipped(item.user)}{clipped(item.reply)}{item.inputTruncated && <Text style={muted}>这段历史在进入本轮上下文时已被截断。</Text>}
            </View>)}
            {result.section === 'memory' && <>
                <Text style={muted}>这里显示当时实际带入的版本。有效背景表示可用的长期偏好；管理目录用于记忆管理。历史消息中也可能含旧内容，请在历史消息页核对。带入不代表采纳。</Text>
                <Text style={muted}>有效背景另有 {result.backgroundOmitted} 条未选入；管理目录另有 {result.catalogOmitted} 条未展示。</Text>
                {result.page.items.map(item => <View key={`${item.keyDigest}:${item.revision}`} style={card}>
                    <Text style={body}>{item.key} · 第 {item.revision} 版</Text>
                    <Text style={muted}>{item.locations.map(location => location === 'background' ? '有效背景' : '管理目录').join('、')} · {item.verified ? '已确认' : '未确认'}{item.expired ? ' · 当时已过期' : ''}</Text>
                    <Text selectable style={body}>{JSON.stringify(item.value)}</Text>
                </View>)}
            </>}
            {result.section === 'selection' && <>
                {!result.available ? <Text style={muted}>本轮未保留逐条选择原因。仅最近 {overview?.retention.selectionTurnLimit} 轮保留此记录；不能用当前记忆反推当时原因。</Text>
                    : <Text style={muted}>选择策略 v{result.policy?.version} · 最多 {result.policy?.maxEntries} 条 / {result.policy?.maxBytes} 字节 · {date(result.policy?.asOf)}</Text>}
                {result.page.items.map(item => <View key={item.keyDigest} style={card}><Text style={body}>{label(item.key, item.keyDigest)} · 当时第 {item.revision} 版</Text>
                    <Text style={muted}>{observationReasons[item.reason]}；这是有效背景的选择结果。</Text></View>)}
            </>}
        </>}
        {result?.action === 'work' && <>
            <Text style={body}>{result.work.title} · {testloopWorkStatus(result.work)}</Text><Text selectable style={body}>{result.work.instruction}</Text>
            <Text style={muted}>{result.work.businessVerification === 'independent_agent_report' ? '已有独立执行会话提供验收报告' : '业务验收未核验'}</Text>
            {result.work.reason && <Text style={muted}>状态原因：{result.work.reason}</Text>}
            <Text style={muted}>开始：{date(result.work.startedAt)} · 结束：{date(result.work.finishedAt)}</Text>
            {result.work.steps.map(step => <Text key={step.id} style={body}>{step.title} · {states[step.status] ?? step.status}</Text>)}
            {clipped(result.work.result)}
            {result.work.executionSessionId && button('打开执行会话', () => onExecution(result.work.executionSessionId!))}
            {events(result.page.items)}
        </>}
        {result && 'page' in result && <>
            <Text style={muted}>显示 {result.page.items.length ? result.page.offset + 1 : 0}–{result.page.offset + result.page.items.length} / {result.page.total} 条 · 读取于 {date(result.asOf)}</Text>
            {!result.page.total && <Text style={muted}>当前没有此类记录。</Text>}
            {result.page.offset > 0 && button('回到第一页', () => { if (shown) void load({ ...shown.query, offset: 0, snapshotId: undefined }); })}
            {result.page.nextOffset !== null && button('下一页', () => { if (shown) void load({ ...shown.query, offset: result.page.nextOffset!, snapshotId: result.snapshotId }); })}
        </>}
    </View>;
}
