import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata, testloopWorkStatus } from '@/sync/testloopDots';
import { parseToken } from '@/utils/parseToken';
import { useDotMemoryMove } from './useDotMemoryMove';
import { ObservationOverviewSchema, ObservationResponseSchema, observationError, observationMemoryStatus, observationReasons,
    requestDotObservation, type ObservationEvent, type ObservationMemoryVersion, type ObservationOverview,
    type MemoryScope, type ObservationRequest, type ObservationResponse } from '@/sync/dotObservation';

type Mode = 'activity' | 'memory' | 'basis';
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '未记录';
const label = (key: string | null, digest: string) => key ?? `记忆 ${digest.slice(7, 19)}…`;
const states: Record<string, string> = { queued: '等待处理', planning: '理解需求中', decided: '已形成决定', applied: '已处理',
    blocked: '遇到阻塞', rejected: '已拒绝', proposed: '已提出，待确认', accepted: '已接受', superseded: '已被新提案替代',
    preparing: '准备执行', running: '执行中', paused: '已暂停', awaiting_user: '等待你的答复', awaiting_approval: '等待审批',
    succeeded: '已完成', failed: '执行失败', canceled: '已取消', executing: '执行中', reviewing: '独立验收中', repairing: '返工中',
    canceling: '取消中', completed: '执行结束', observing: '等待执行回报', creating: '创建执行会话', created: '会话已创建，尚未交办', sending: '发送交办', prepared: '准备派工' };
function eventTitle(event: ObservationEvent) {
    if (event.kind === 'delivery') return `回报 · ${{ pending: '等待发送', accepted: '服务端已接收，待核对入库', stored_verified: '已核对入库', error: '发送错误' }[event.status] ?? event.status}`;
    if (event.kind === 'dot') return event.previousStatus ? '名称或职责已修改' : 'Dot 已创建';
    if (event.kind === 'memory') return `${event.status === 'deleted' ? '已忘记' : event.status === 'confirm' ? '已确认' : '已保存或更新'}：${label(event.label, event.keyDigest!)}`;
    const status = event.status.split(':').map(item => states[item] ?? item).join(' · ');
    return `${event.kind === 'turn' ? '对话' : event.kind === 'memory-proposal' ? '记忆提案' : '工作'} · ${status}`;
}

/** Observation reads and explicit user memory moves stay bound to the account, workspace, Dot and visible screen. */
export function DotObservationPanel({ sessionId, workspaceId, dotId, dotSessionId, active, mode, presence,
    onExecution, onEditMemory, onForgetMemory, onAddMemory }: {
    sessionId: string; workspaceId: string; dotId: string; dotSessionId: string; active: boolean; mode: Mode; presence: string | number;
    onExecution: (sessionId: string) => void;
    onEditMemory: (key: string, version: ObservationMemoryVersion, scope?: MemoryScope) => void; onForgetMemory: (key: string, scope?: MemoryScope) => void;
    onAddMemory: (scope?: MemoryScope) => void;
}) {
    const { theme } = useUnistyles(), { credentials, isAuthenticated } = useAuth(), server = getServerUrl();
    const [memoryScope, setMemoryScope] = React.useState<MemoryScope>('dot');
    const scope = React.useMemo(() => ({}), [credentials?.token, credentials?.secret, isAuthenticated, server, sessionId, workspaceId, dotId, dotSessionId, mode, memoryScope]);
    const initial = React.useMemo<ObservationRequest>(() => (mode === 'memory' ? { dotId, action: 'memories', scope: memoryScope } : { dotId, action: mode === 'basis' ? 'turns' : 'activity' }), [dotId, mode, memoryScope]);
    const [loaded, setLoaded] = React.useState<{ scope: object; overview: ObservationOverview; result: ObservationResponse; query: ObservationRequest } | null>(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
    const [showDecision, setShowDecision] = React.useState(false);
    const epoch = React.useRef(0), moveCancellation = React.useRef(0), focused = React.useRef(false), foreground = React.useRef(true);
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
                requestDotObservation(sessionId, { dotId, action: 'overview', scope: mode === 'memory' ? memoryScope : 'dot' }, ObservationOverviewSchema),
                requestDotObservation(sessionId, query, ObservationResponseSchema),
            ]);
            if (version === epoch.current && valid()) setLoaded({ scope, overview, result, query });
        } catch (failure) { if (version === epoch.current && valid()) setError(observationError(failure)); }
        finally { if (version === epoch.current) setBusy(false); }
    }, [valid, sessionId, dotId, scope, mode, memoryScope]);
    useFocusEffect(React.useCallback(() => {
        focused.current = true; void load(initial);
        return () => { focused.current = false; epoch.current++; moveCancellation.current++; };
    }, [load, initial]));
    React.useEffect(() => {
        const listener = AppState.addEventListener('change', state => {
            foreground.current = state === 'active';
            if (!foreground.current) { epoch.current++; moveCancellation.current++; setLoaded(null); setBusy(false); }
            else if (focused.current) void load(initial);
        });
        return () => listener.remove();
    }, [load, initial]);
    const shown = loaded?.scope === scope && valid() ? loaded : null;
    const result = shown?.result, overview = shown?.overview;
    // JWT sub partitions opaque recovery metadata locally; the host independently authenticates the user.
    const localMoveScope = React.useMemo(() => {
        if (!isAuthenticated || !credentials?.token) return null;
        try { return JSON.stringify([server, parseToken(credentials.token), workspaceId, sessionId, dotId, dotSessionId]); }
        catch { return null; }
    }, [isAuthenticated, credentials?.token, server, workspaceId, sessionId, dotId, dotSessionId]);
    const refreshMovedMemories = React.useCallback(async () => {
        if (!valid()) return;
        const version = ++epoch.current;
        const pairs = await Promise.all((['dot', 'user'] as const).map(async memoryScope => ({
            memoryScope, overview: await requestDotObservation(sessionId, { dotId, action: 'overview', scope: memoryScope }, ObservationOverviewSchema),
            result: await requestDotObservation(sessionId, { dotId, action: 'memories', scope: memoryScope }, ObservationResponseSchema),
        })));
        if (version !== epoch.current || !valid()) return;
        const selected = pairs.find(item => item.memoryScope === memoryScope)!;
        setLoaded({ scope, overview: selected.overview, result: selected.result, query: { dotId, action: 'memories', scope: memoryScope } });
    }, [valid, sessionId, dotId, memoryScope, scope]);
    const move = useDotMemoryMove({ sessionId, dotId, localScope: localMoveScope, binding: scope,
        cancellation: () => moveCancellation.current, current: () => mode === 'memory' && valid(), refresh: refreshMovedMemories });
    const canMove = Boolean(localMoveScope && overview?.memory?.access.includes('read') && overview.memory.access.includes('write') && overview.memory.access.includes('forget'));
    const canInspectMove = Boolean(localMoveScope && overview?.memory?.access.includes('read'));
    const moving = busy || move.busy;
    const colors = theme.colors;
    const body = { color: colors.text, fontSize: 14, lineHeight: 22 }, muted = { color: colors.textSecondary, fontSize: 12, lineHeight: 18 };
    const card = { gap: 6, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.divider };
    const button = (title: string, run: () => void, customStyle?: object, textStyle?: object) => <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={moving}
        onPress={run} style={[{ paddingVertical: 8, paddingHorizontal: 12, minHeight: 36, backgroundColor: colors.surfaceHigh, borderRadius: 8, justifyContent: 'center', opacity: moving ? 0.5 : 1 }, customStyle]}>
        <Text style={[{ color: colors.text, fontSize: 13, textAlign: 'center' }, textStyle]}>{title}</Text></Pressable>;
    const go = (query: Omit<ObservationRequest, 'dotId'>) => { void load({ ...query, dotId } as ObservationRequest); };
    const turn = (turnId: string) => go({ action: 'turn', turnId, section: 'overview' } as Omit<ObservationRequest, 'dotId'>);
    const work = (workId: string) => go({ action: 'work', workId } as Omit<ObservationRequest, 'dotId'>);
    const memory = (keyDigest: string, section: 'versions' | 'usage' = 'versions') => go({ action: 'memory', keyDigest, section, scope: memoryScope } as Omit<ObservationRequest, 'dotId'>);
    const clipped = (value: { text: string; truncated: boolean }) => <Text selectable style={body}>{value.text || '无'}{value.truncated ? '\n（展示内容已截断）' : ''}</Text>;
    const events = (items: ObservationEvent[]) => items.map(event => <View key={event.id} style={card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ ...body, fontWeight: '500' }}>{eventTitle(event)}</Text>
            <Text style={muted}>{date(event.at)}</Text>
        </View>
        {event.reason && <Text style={muted}>原因：{event.reason}</Text>}
        {event.previousIdentity && <><Text style={muted}>修改前：{event.previousIdentity.name}</Text><Text selectable style={body}>{event.previousIdentity.instruction}</Text></>}
        {event.identity && <><Text style={muted}>修改后：{event.identity.name}</Text><Text selectable style={body}>{event.identity.instruction}</Text></>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {event.turnId && button('查看本轮依据', () => turn(event.turnId!))}
            {event.workId && button('查看工作经过', () => work(event.workId!))}
            {event.keyDigest && overview?.memory && button('查看记忆记录', () => memory(event.keyDigest!))}
        </View>
    </View>);
    const listTurns = (items: { id: string; seq: number; createdAt: string; source: string; status: string; trigger: { text: string; truncated: boolean }; memoryRevision?: number }[]) => items.map(item => <View key={`${item.id}:${item.memoryRevision ?? ''}`} style={card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ ...body, fontWeight: '500' }}>第 {item.seq} 轮 · {item.source === 'user' ? '用户消息' : '执行结果'}</Text>
            <Text style={muted}>{states[item.status] ?? item.status}{item.memoryRevision ? ` · 带入第 ${item.memoryRevision} 版` : ''}</Text>
        </View>
        {clipped(item.trigger)}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
            <Text style={muted}>{date(item.createdAt)}</Text>
            {button(`检查第 ${item.seq} 轮`, () => turn(item.id))}
        </View>
    </View>);
    const nativeThreadId = storage.getState().sessions[dotSessionId]?.metadata?.codexThreadId;
    const detail = result && (result.action === 'turn' || result.action === 'memory' || result.action === 'work');
    return <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            {detail ? (
                <Pressable accessibilityRole="button" accessibilityLabel="返回观察列表" disabled={busy}
                    onPress={() => { void load(initial); }}
                    style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: colors.surfaceHigh, borderRadius: 8, justifyContent: 'center' }}>
                    <Text style={{ ...body, fontSize: 13, fontWeight: '500' }}>← 返回列表</Text>
                </Pressable>
            ) : (
                <Text accessibilityRole="header" style={{ ...body, fontSize: 16, fontWeight: '600' }}>
                    {{ activity: '活动记录', memory: '长期记忆', basis: '本轮依据' }[mode]}
                </Text>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="刷新观察台" disabled={busy}
                onPress={() => { void load(shown?.query ?? initial); }}
                style={{ paddingVertical: 6, paddingHorizontal: 12, backgroundColor: colors.surfaceHigh, borderRadius: 8, opacity: busy ? 0.5 : 1, justifyContent: 'center' }}>
                <Text style={{ ...muted, color: colors.text, fontSize: 13 }}>刷新</Text>
            </Pressable>
        </View>
        {mode === 'memory' && <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['dot', 'user'] as const).map(value => <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === 'dot' ? 'Dot级记忆' : '用户级记忆'}
                accessibilityState={{ selected: memoryScope === value }} onPress={() => setMemoryScope(value)} style={{ padding: 10, borderRadius: 8, backgroundColor: memoryScope === value ? colors.surfaceHigh : 'transparent' }}>
                <Text style={body}>{value === 'dot' ? 'Dot级 · 私有' : '用户级 · 所有Dot共享'}</Text>
            </Pressable>)}
        </View>}
        {mode === 'memory' && <Text style={muted}>{memoryScope === 'user' ? '同一宿主账号的通用记忆；只操作用户级，不影响同名Dot级记录。' : '仅当前Dot可用；只操作Dot级，不影响同名用户级记录。'}</Text>}
        {moving && <ActivityIndicator />}
        {error && <Text accessibilityRole="alert" style={{ ...body, color: colors.textDestructive }}>{error}</Text>}
        {move.error && <Text accessibilityRole="alert" style={{ ...body, color: colors.textDestructive }}>{move.error}</Text>}
        {move.notice && <Text accessibilityLiveRegion="polite" style={body}>{move.notice}</Text>}
        {move.pending.map(intent => <View key={intent.requestID} style={{ gap: 4 }}>
            <Text style={muted}>有一次记忆移动待核对（{intent.sourceScope === 'dot' ? 'Dot → 用户级' : '用户级 → 当前 Dot'}），重试沿用原请求。</Text>
            {button(move.pending.length === 1 ? '恢复上次移动' : `恢复移动 ${intent.requestID.slice(0, 8)}`, () => move.recover(intent))}
            {move.receipt?.requestID === intent.requestID && ['ready', 'target_saved', 'needs_attention'].includes(move.receipt.status)
                && button('停止本次移动并保留记录', () => move.cancel(intent))}
        </View>)}
        {!detail && overview && <View style={{ gap: 4, paddingVertical: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <Text style={muted}>宿主：{{ healthy: '在线', unhealthy: '异常', stopped: '未运行' }[overview.host.status]} · Dot 连接：{presence === 'online' ? '在线' : '待确认'}</Text>
                {overview.tasks.length > 0 && <Text style={muted}>· {overview.tasks.length} 项进行中任务</Text>}
            </View>
            {(overview.host.error || overview.channel.error) && <Text accessibilityRole="alert" style={{ ...body, color: colors.textDestructive }}>{overview.host.error || overview.channel.error}</Text>}
            {mode === 'memory' && overview.memory && (
                <Text style={muted}>记忆共 {overview.memory.total} 项（有效 {overview.memory.counts.effective} · 待确认 {overview.memory.counts.unconfirmed} · 过期 {overview.memory.counts.expired} · 已忘记 {overview.memory.counts.deleted}）</Text>
            )}
            {mode === 'basis' && nativeThreadId && <Text style={muted}>对话沿用原生会话历史；长期记忆以实际工具调用为准。</Text>}
            {overview.tasks.map(task => <Text key={task.id} style={muted}>{task.title} · {testloopWorkStatus(task)}</Text>)}
        </View>}
        {result?.action === 'activity' && <>
            {Boolean(overview?.retention.droppedEvents) && <Text style={muted}>较早的 {overview?.retention.droppedEvents} 条记录已自动归档</Text>}
            {events(result.page.items)}
        </>}
        {result?.action === 'memories' && <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, flex: 1 }}>
                    {(['all', 'effective', 'unconfirmed', 'expired', 'deleted'] as const).map(status => {
                        const active = (shown?.query.action === 'memories' ? (shown.query.status ?? 'all') : 'all') === status;
                        const title = status === 'all' ? '全部记忆' : observationMemoryStatus[status];
                        return <Pressable key={status} accessibilityRole="button" accessibilityLabel={title} disabled={busy}
                            onPress={() => go({ action: 'memories', status, scope: memoryScope } as Omit<ObservationRequest, 'dotId'>)}
                            style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, backgroundColor: active ? colors.surfaceHigh : 'transparent', borderWidth: 1, borderColor: active ? colors.surfaceHigh : colors.divider }}>
                            <Text style={{ ...muted, color: active ? colors.text : colors.textSecondary, fontSize: 12, fontWeight: active ? '600' : '400' }}>{title}</Text>
                        </Pressable>;
                    })}
                </View>
                {overview?.memory?.access.includes('write') && (
                    <Pressable accessibilityRole="button" accessibilityLabel="添加记忆" disabled={busy}
                        onPress={() => onAddMemory(memoryScope)}
                        style={{ paddingVertical: 5, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.surfaceHigh }}>
                        <Text style={{ ...body, fontSize: 12, fontWeight: '500' }}>+ 添加记忆</Text>
                    </Pressable>
                )}
            </View>
            {result.page.items.map(item => <View key={item.keyDigest}><Pressable accessibilityRole="button"
                accessibilityLabel={`查看记忆：${label(item.key, item.keyDigest)}`} disabled={moving}
                onPress={() => memory(item.keyDigest)}
                style={({ pressed }) => ({ ...card, opacity: pressed ? 0.7 : 1 })}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ ...body, fontWeight: '600', flex: 1 }} numberOfLines={1}>{label(item.key, item.keyDigest)}</Text>
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: colors.surfaceHigh, marginLeft: 8 }}>
                        <Text style={[muted, { fontSize: 11 }]}>{observationMemoryStatus[item.status]}</Text>
                    </View>
                </View>
                {item.status !== 'deleted' && item.preview && clipped(item.preview)}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                    <Text style={[muted, { fontSize: 11 }]}>第 {item.revision} 版{item.kind ? ` · ${item.kind}` : ''}{item.deletedAt ? ` · 忘记于 ${date(item.deletedAt)}` : ''}</Text>
                    <Text style={[muted, { fontSize: 12, color: colors.textSecondary }]}>详情 →</Text>
                </View>
            </Pressable>{canMove && item.status === 'effective' && button(memoryScope === 'dot' ? '移至用户级' : '移至当前Dot',
                () => move.start(item.keyDigest, item.revision, memoryScope))}
                {canInspectMove && item.status !== 'effective' && button('核对未完成移动', () => move.inspect(item.keyDigest, item.revision, memoryScope))}</View>)}
        </>}
        {result?.action === 'memory' && <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 }}>
                <Text style={{ ...body, fontSize: 16, fontWeight: '600', flex: 1 }}>{label(result.memory.key, result.memory.keyDigest)}</Text>
                <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.surfaceHigh }}>
                    <Text style={[muted, { fontSize: 12 }]}>{observationMemoryStatus[result.memory.status]}</Text>
                </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, padding: 3, backgroundColor: colors.surfaceHigh, borderRadius: 8 }}>
                <Pressable accessibilityRole="button" accessibilityLabel="查看版本变化" disabled={busy}
                    onPress={() => memory(result.memory.keyDigest)}
                    style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: result.section === 'versions' ? colors.surface : 'transparent' }}>
                    <Text style={{ ...body, fontSize: 13, fontWeight: result.section === 'versions' ? '600' : '400' }}>版本变化</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="查看历史带入记录" disabled={busy}
                    onPress={() => memory(result.memory.keyDigest, 'usage')}
                    style={{ flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 6, backgroundColor: result.section === 'usage' ? colors.surface : 'transparent' }}>
                    <Text style={{ ...body, fontSize: 13, fontWeight: result.section === 'usage' ? '600' : '400' }}>历史带入记录</Text>
                </Pressable>
            </View>
            {result.memory.deletedAt && <Text style={muted}>已于 {date(result.memory.deletedAt)} 忘记，正文已清除。</Text>}
            {canMove && result.memory.status === 'effective' && button(memoryScope === 'dot' ? '移至用户级' : '移至当前Dot',
                () => move.start(result.memory.keyDigest, result.memory.revision, memoryScope))}
            {canInspectMove && result.memory.status !== 'effective' && button('核对未完成移动',
                () => move.inspect(result.memory.keyDigest, result.memory.revision, memoryScope))}
            {result.section === 'usage' && memoryScope === 'user' && <Text style={muted}>用户级记忆的原生工具读取不记录在旧轮次背景快照中。</Text>}
            {result.section === 'versions' ? result.memory.status === 'deleted' ? null : result.page.items.map(version => <View key={version.revision} style={card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ ...body, fontWeight: '600' }}>第 {version.revision} 版 · {version.action === 'confirm' ? '确认' : '保存或更新'} · {version.historical ? '历史版本' : '当前版本'}</Text>
                </View>
                <Text selectable style={[body, { backgroundColor: colors.surfaceHigh, padding: 10, borderRadius: 8 }]}>{JSON.stringify(version.value)}</Text>
                <Text style={muted}>来源：{version.source}{version.sourceRef ? ` · ${version.sourceRef}` : ''} · {version.verified ? '已确认' : '未确认'}</Text>
                <Text style={muted}>记录于 {date(version.recordedAt)}{version.expiresAt ? ` · 有效期至 ${date(version.expiresAt)}` : ''}</Text>
                {!version.historical && result.memory.key && <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    {overview?.memory?.access.includes('write') && button('编辑这条记忆', () => onEditMemory(result.memory.key!, version, memoryScope), { flex: 1 })}
                    {overview?.memory?.access.includes('forget') && button('请求忘记这条记忆', () => onForgetMemory(result.memory.key!, memoryScope), { flex: 1 })}
                </View>}
            </View>) : listTurns(result.page.items)}
        </>}
        {!nativeThreadId && result?.action === 'turns' && listTurns(result.page.items)}
        {result?.action === 'turn' && <>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 3, backgroundColor: colors.surfaceHigh, borderRadius: 8 }}>
                {(['overview', 'history', 'memory', 'selection'] as const).map(section => {
                    const active = (shown?.query.action === 'turn' ? shown.query.section : 'overview') === section;
                    const label = { overview: '轮次概览', history: '带入的历史消息', memory: '带入的记忆', selection: '记忆选择原因' }[section];
                    return <Pressable key={section} accessibilityRole="button" accessibilityLabel={label} disabled={busy}
                        onPress={() => { if (shown?.query.action === 'turn') void load({ dotId, action: 'turn', turnId: shown.query.turnId, section }); }}
                        style={{ flex: 1, minWidth: 70, paddingVertical: 6, alignItems: 'center', borderRadius: 6, backgroundColor: active ? colors.surface : 'transparent' }}>
                        <Text style={{ ...body, fontSize: 12, fontWeight: active ? '600' : '400' }}>{label}</Text>
                    </Pressable>;
                })}
            </View>
            {result.section === 'overview' && <>
                <Text style={body}>第 {result.turn.seq} 轮 · {result.turn.source === 'user' ? '用户消息' : '执行结果事件'} · {states[result.turn.status] ?? result.turn.status}</Text>
                <Text style={muted}>上下文冻结于 {date(result.turn.frozenAt)}</Text>
                {!result.turn.contextAvailable && <Text style={muted}>本轮尚无已保存的冻结上下文。</Text>}
                {result.turn.identity && <><Text style={body}>当时的 Dot：{result.turn.identity.name}</Text><Text selectable style={body}>{result.turn.identity.instruction}</Text></>}
                <Text style={muted}>触发内容</Text>{clipped(result.turn.trigger)}<Text style={muted}>实际回复</Text>{clipped(result.turn.reply)}
                <Text style={body}>结构化决定：{result.turn.decisionKind ?? '尚无记录'}</Text>
                {result.turn.decision.text && button(showDecision ? '收起结构化决定' : '查看结构化决定', () => setShowDecision(value => !value))}
                {showDecision && clipped(result.turn.decision)}
                {result.turn.error && <Text accessibilityRole="alert" style={{ ...body, color: colors.textDestructive }}>记录错误：{result.turn.error}</Text>}
                {result.turn.deliveries.map((delivery, index) => <Text key={index} style={muted}>回报：{{ pending: '等待发送', accepted: '服务端已接收，待核对入库', stored_verified: '已核对入库', error: '发送错误' }[delivery.status]} · 尝试 {delivery.attempts} 次{delivery.error ? ` · ${delivery.error}` : ''}</Text>)}
                {result.turn.relatedWork.map(workId => <React.Fragment key={workId}>{button('查看关联工作', () => work(workId))}</React.Fragment>)}
                {result.turn.calls.map((call, index) => <Text key={call.id} style={muted}>调用 {index + 1}：{date(call.reservedAt)} → {date(call.finishedAt)}{call.elapsedMs !== null ? ` · ${call.elapsedMs}ms` : ''}</Text>)}
                {result.turn.inputDigest && <Text style={muted}>本轮输入摘要：{result.turn.inputDigest}</Text>}
            </>}
            {result.section === 'history' && result.page.items.map(item => <View key={item.seq} style={card}>
                <Text style={muted}>第 {item.seq} 轮 · {item.source === 'user' ? '用户消息' : '执行结果事件'}</Text>
                {clipped(item.user)}{clipped(item.reply)}{item.inputTruncated && <Text style={muted}>这段历史在进入本轮上下文时已被截断。</Text>}
            </View>)}
            {result.section === 'memory' && <>
                {(result.backgroundOmitted > 0 || result.catalogOmitted > 0) && <Text style={muted}>有效背景另有 {result.backgroundOmitted} 条未选入；管理目录另有 {result.catalogOmitted} 条未展示。</Text>}
                {result.page.items.map(item => <View key={`${item.keyDigest}:${item.revision}`} style={card}>
                    <Text style={body}>{item.key} · 第 {item.revision} 版</Text>
                    <Text style={muted}>{item.locations.map(location => location === 'background' ? '有效背景' : '管理目录').join('、')} · {item.verified ? '已确认' : '未确认'}{item.expired ? ' · 当时已过期' : ''}</Text>
                    <Text selectable style={body}>{JSON.stringify(item.value)}</Text>
                </View>)}
            </>}
            {result.section === 'selection' && <>
                {!result.available ? <Text style={muted}>本轮未保留逐条选择原因（仅保留最近 {overview?.retention.selectionTurnLimit ?? 20} 轮）。</Text>
                    : <Text style={muted}>选择策略 v{result.policy?.version} · 最多 {result.policy?.maxEntries} 条 / {result.policy?.maxBytes} 字节 · {date(result.policy?.asOf)}</Text>}
                {result.page.items.map(item => <View key={item.keyDigest} style={card}><Text style={body}>{label(item.key, item.keyDigest)} · 当时第 {item.revision} 版</Text>
                    <Text style={muted}>{observationReasons[item.reason]}；这是有效背景的选择结果。</Text></View>)}
            </>}
        </>}
        {result?.action === 'work' && <>
            <Text style={{ ...body, fontWeight: '600', fontSize: 16 }}>{result.work.title} · {testloopWorkStatus(result.work)}</Text>
            <Text selectable style={body}>{result.work.instruction}</Text>
            {result.work.businessVerification === 'independent_agent_report' && <Text style={muted}>已有独立执行会话提供验收报告</Text>}
            {result.work.reason && <Text style={muted}>原因：{result.work.reason}</Text>}
            <Text style={muted}>{date(result.work.startedAt)} → {date(result.work.finishedAt)}</Text>
            {result.work.steps.map(step => <Text key={step.id} style={body}>{step.title} · {states[step.status] ?? step.status}</Text>)}
            {clipped(result.work.result)}
            {result.work.executionSessionId && button('打开执行会话', () => onExecution(result.work.executionSessionId!))}
            {events(result.page.items)}
        </>}
        {result && 'page' in result && <>
            {result.page.total === 0 ? (
                <Text style={[muted, { textAlign: 'center', paddingVertical: 18 }]}>当前没有此类记录。</Text>
            ) : (
                (result.page.total > result.page.items.length || result.page.offset > 0) && <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 }}>
                    <Text style={muted}>共 {result.page.total} 条（第 {result.page.offset + 1}–{result.page.offset + result.page.items.length} 条）</Text>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                        {result.page.offset > 0 && button('回到第一页', () => { if (shown) void load({ ...shown.query, offset: 0, snapshotId: undefined }); })}
                        {result.page.nextOffset !== null && button('下一页', () => { if (shown) void load({ ...shown.query, offset: result.page.nextOffset!, snapshotId: result.snapshotId }); })}
                    </View>
                </View>
            )}
        </>}
    </View>;
}
