import * as React from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { sync } from '@/sync/sync';
import { dotsMcpError, requestDotsMcp, type DotsMcpMutation, type DotsMcpView } from '@/sync/dotsMcpConnections';

const httpExample = JSON.stringify({ url: 'https://example.com/mcp' }, null, 2);
const happyControlExample = JSON.stringify({ url: 'https://example.com/happy-control/mcp' }, null, 2);
const stdioExample = JSON.stringify({ command: 'node', args: ['/absolute/path/server.mjs'], env_vars: ['MY_MCP_TOKEN'] }, null, 2);
type SelectionMutation = Extract<DotsMcpMutation, { action: 'bind' | 'bind-projects' }>;
type SelectionDraft = Record<string, Record<string, { selected: boolean; projectIDs: string[] }>>;
type Feedback = { connectionID: string | null; phase: 'saving' | 'saved' | 'failed' | 'unconfirmed' | 'conflict'; text: string };
const sameIDs = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every(id => b.includes(id));

/** Only explicit clicks create drafts. Plan against the last acknowledged revision. */
function nextSelectionMutation(view: DotsMcpView, drafts: SelectionDraft): SelectionMutation | undefined {
    for (const [dotId, connections] of Object.entries(drafts)) {
        const dot = view.dots.find(item => item.id === dotId);
        if (!dot) throw new Error('mcp_scope_denied');
        for (const [connectionID, draft] of Object.entries(connections)) {
            if (!view.connections.some(item => item.id === connectionID)) throw new Error('mcp_scope_denied');
            if (dot.connectionIDs.includes(connectionID) !== draft.selected) return { action: 'bind', dotId,
                connectionIDs: draft.selected ? [...dot.connectionIDs, connectionID] : dot.connectionIDs.filter(id => id !== connectionID) };
            if (draft.selected && !sameIDs(dot.projectBindings?.[connectionID] ?? [], draft.projectIDs)) {
                return { action: 'bind-projects', dotId, connectionID, projectIDs: draft.projectIDs };
            }
        }
    }
}

export function DotsMcpPanel({ sessionId, dotId, current }: { sessionId: string; dotId?: string; current: () => boolean }) {
    const { theme } = useUnistyles();
    const [view, setView] = React.useState<DotsMcpView | null>(null), [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null), [notice, setNotice] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<string | null>(null), [name, setName] = React.useState('');
    const [raw, setRaw] = React.useState(httpExample), [form, setForm] = React.useState(false);
    const [token, setToken] = React.useState(''), [clearToken, setClearToken] = React.useState(false), [storedToken, setStoredToken] = React.useState(false);
    const [drafts, setDrafts] = React.useState<SelectionDraft>({}), [needsRefresh, setNeedsRefresh] = React.useState(false);
    const [expanded, setExpanded] = React.useState<string | null>(null), [scopeDot, setScopeDot] = React.useState(dotId ?? null);
    const [query, setQuery] = React.useState(''), [feedback, setFeedback] = React.useState<Feedback | null>(null);
    const [needsToken, setNeedsToken] = React.useState(false);
    const retrySelection = React.useRef<{ drafts: SelectionDraft; revision: number } | null>(null);
    const desired = React.useRef<SelectionDraft>({}), confirmed = React.useRef<DotsMcpView | null>(null);
    const requiresReconciliation = React.useRef(false);
    const epoch = React.useRef(0), inFlight = React.useRef(false), savingSelection = React.useRef(false);
    const run = React.useCallback(async (mutation?: DotsMcpMutation, revision?: number, selection = false) => {
        if (inFlight.current || !current() || (requiresReconciliation.current && (mutation || selection))) return;
        const version = epoch.current; inFlight.current = true; savingSelection.current = selection;
        setBusy(true); setError(null); setNotice(null);
        const saving = mutation?.action === 'save' ? mutation : undefined;
        if (saving) setFeedback({ connectionID: saving.connectionID ?? null, phase: 'saving', text: '正在保存' });
        else if (!selection && mutation) setFeedback(null);
        const settled = (phase: Feedback['phase'], text: string) => setFeedback(previous => previous ? { ...previous, phase, text } : previous);
        const accept = (result: DotsMcpView) => { confirmed.current = result; setView(result); };
        try {
            await sync.ensureSessionReady(sessionId);
            if (version !== epoch.current || !current()) return;
            if (selection) {
                let publicationPending = false;
                // One in-flight write. Re-plan after each ACK so later clicks supersede
                // unsent work, including cancelling a parent before any project grant.
                while (confirmed.current) {
                    const next = nextSelectionMutation(confirmed.current, desired.current);
                    if (!next) break;
                    const result = await requestDotsMcp(sessionId, { ...next, revision: confirmed.current.revision, requestId: randomUUID() });
                    if (version !== epoch.current || !current()) return;
                    const dot = result.dots.find(item => item.id === next.dotId);
                    if (result.revision <= confirmed.current.revision || !dot || (next.action === 'bind' && !sameIDs(dot.connectionIDs, next.connectionIDs))
                        || (next.action === 'bind-projects' && !sameIDs(dot.projectBindings?.[next.connectionID] ?? [], next.projectIDs))) {
                        throw new Error('mcp_response_unconfirmed');
                    }
                    publicationPending = Boolean(result.gatewayRefreshPending);
                    accept(result);
                }
                desired.current = {}; setDrafts({}); retrySelection.current = null;
                settled('saved', publicationPending ? '已保存，等待宿主同步。' : '已保存。');
            } else {
                const result = await requestDotsMcp(sessionId, mutation ? { ...mutation, revision: revision!, requestId: randomUUID() } : { action: 'list' });
                if (version !== epoch.current || !current()) return;
                if (saving && result.revision <= revision!) throw new Error('mcp_response_unconfirmed');
                accept(result); requiresReconciliation.current = false; setNeedsRefresh(false);
                if (!mutation) setFeedback(previous => previous?.phase === 'unconfirmed'
                    ? { ...previous, text: '回执待确认。已刷新当前记录，请核对后继续。' } : previous);
                if (saving) {
                    settled('saved', result.gatewayRefreshPending ? '已保存，等待宿主同步。' : '已保存。');
                    setForm(false); setRaw(httpExample); setName(''); setEditing(null); setToken(''); setClearToken(false); setStoredToken(false); setNeedsToken(false);
                } else if (mutation) setNotice(mutation.action === 'check' ? '检查完成，请查看连接状态。' : result.gatewayRefreshPending ? '已保存，等待宿主同步。' : '已保存。');
            }
        } catch (failure) {
            if (version === epoch.current && current()) {
                // An unconfirmed write may already have committed. Never retry it or
                // submit further edits with a guessed revision; a read must reconcile it.
                const code = failure instanceof Error ? failure.message : '';
                const conflict = code === 'mcp_revision_changed';
                const uncertain = ['mcp_transport_unconfirmed', 'mcp_response_unconfirmed', 'mcp_operation_failed', 'mcp_request_conflict'].includes(code);
                if (uncertain || conflict) { requiresReconciliation.current = true; setNeedsRefresh(true); }
                if (saving || selection) {
                    const reenterToken = typeof saving?.token === 'string';
                    if (reenterToken) setNeedsToken(true);
                    const prefix = uncertain ? '回执待确认。' : '保存失败。';
                    settled(uncertain ? 'unconfirmed' : conflict ? 'conflict' : 'failed', `${prefix}${dotsMcpError(failure)}${reenterToken ? '请重新填写本次 Token。' : ''}`);
                    if (selection && !uncertain && !conflict && confirmed.current) {
                        retrySelection.current = { drafts: desired.current, revision: confirmed.current.revision };
                    }
                } else setError(dotsMcpError(failure));
                desired.current = {}; setDrafts({}); setToken('');
            }
        } finally { if (version === epoch.current) { inFlight.current = false; savingSelection.current = false; setBusy(false); } }
    }, [current, sessionId]);
    React.useEffect(() => {
        desired.current = {}; setDrafts({}); confirmed.current = null; setView(null);
        retrySelection.current = null; setFeedback(null); setExpanded(null); setScopeDot(dotId ?? null); setQuery('');
        setForm(false); setEditing(null); setName(''); setRaw(httpExample); setToken(''); setNeedsToken(false); setClearToken(false); setStoredToken(false);
        inFlight.current = false; savingSelection.current = false; setBusy(false); requiresReconciliation.current = false; setNeedsRefresh(false);
        void run();
        return () => { epoch.current++; };
    }, [run, dotId]);
    const select = (targetDot: string, connectionID: string, selected: boolean, projectIDs: string[]) => {
        if (!current() || requiresReconciliation.current || (inFlight.current && !savingSelection.current)) return;
        desired.current = { ...desired.current, [targetDot]: { ...desired.current[targetDot], [connectionID]: { selected, projectIDs } } };
        retrySelection.current = null;
        setDrafts(desired.current); setNotice(null); setError(null);
        setFeedback({ connectionID, phase: 'saving', text: '正在保存选择（勾选为待保存状态）' });
        if (!inFlight.current) void run(undefined, undefined, true);
    };
    React.useEffect(() => {
        if (Platform.OS === 'ios' && feedback) AccessibilityInfo.announceForAccessibility(feedback.text);
    }, [feedback]);
    const selectionPending = Object.keys(drafts).length > 0;
    const selectionDisabled = needsRefresh || (busy && !selectionPending);
    React.useEffect(() => {
        const clear = () => setToken('');
        const subscription = AppState.addEventListener('change', state => { if (state !== 'active') clear(); });
        const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
        return () => { subscription.remove(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); };
    }, []);
    const mutate = (mutation: DotsMcpMutation) => { if (view) void run(mutation, view.revision); };
    const text = { color: theme.colors.text, lineHeight: 22 };
    const muted = { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 };
    const input = { color: theme.colors.text, borderColor: theme.colors.divider, borderWidth: 1, padding: 12, borderRadius: 8 };
    const button = (label: string, action: () => void, blocked = false, saving = false) => {
        const disabled = blocked || busy || (needsRefresh && label !== '刷新 MCP 连接' && label !== '取消 MCP 编辑');
        return <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy: saving }} aria-busy={saving}
            onPress={action} disabled={disabled} style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, minHeight: 44,
                flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: theme.colors.surfaceHigh, opacity: disabled && !saving ? 0.5 : 1 }}>
            {saving && <ActivityIndicator size="small" />}<Text style={[text, { flexShrink: 1 }]}>{label}</Text>
        </Pressable>;
    };
    const saveNotice = (connectionID: string | null) => <Text role="status" aria-live="polite" accessibilityLiveRegion="polite" aria-atomic
        style={[muted, (!feedback || feedback.connectionID !== connectionID || (feedback.phase === 'saving' && form)) &&
            { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }]}>
        {feedback?.connectionID === connectionID ? feedback?.text : ''}
    </Text>;
    const dots = (view?.dots.filter(dot => !dotId || dot.id === dotId) ?? []).map(dot => {
        const choices = drafts[dot.id];
        if (!choices) return dot;
        let connectionIDs = dot.connectionIDs;
        const projectBindings = { ...dot.projectBindings };
        for (const [id, choice] of Object.entries(choices)) {
            connectionIDs = choice.selected ? [...connectionIDs.filter(item => item !== id), id] : connectionIDs.filter(item => item !== id);
            projectBindings[id] = choice.selected ? choice.projectIDs : [];
        }
        return { ...dot, connectionIDs, projectBindings };
    });
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const connections = (view?.connections ?? []).filter(connection => {
        if (connection.id === expanded || !terms.length) return true;
        const { config, control } = connection;
        const fields = [connection.name, config.url, config.command, control?.machineID, control?.grantID,
            ...(control?.projects.flatMap(project => [project.id, project.directory]) ?? [])].join(' ').toLowerCase();
        return terms.every(term => fields.includes(term));
    });
    const missingEdit = Boolean(editing && !view?.connections.some(connection => connection.id === editing));
    const saveBlocked = needsToken || missingEdit || feedback?.phase === 'unconfirmed' || feedback?.phase === 'conflict';
    const editor = <View style={{ gap: 10 }}>
            <TextInput accessibilityLabel="MCP 名称" placeholder="服务名称" value={name} onChangeText={setName} editable={!busy} maxLength={80} style={input} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{button('HTTP 配置示例', () => setRaw(httpExample))}{button('Happy Control 配置示例', () => { setRaw(happyControlExample); setName('Happy Control'); })}{button('stdio 配置示例', () => setRaw(stdioExample))}</View>
            <Text style={muted}>填入单个服务的 JSON 配置，HTTP Token 可在下方填写，不需要配置环境变量。也可在 JSON 中填写 bearer_token_env_var 引用宿主环境变量，请只选择一种方式。可用 enabled_tools 数组限制工具，省略则允许服务全部工具。本地命令在 TestLoop 宿主运行。</Text>
            <Text style={muted}>需要确认时，聊天中可直接点击“确认这次操作”。常用工具可在 tool_policy 中逐项设置：read 为自动读取，confirm 为每次确认，allow 为允许直接执行，deny 为禁用。只有你明确设置 allow，写入操作才会直接执行；把发送、删除等工具标成 read 仍需确认。</Text>
            <TextInput accessibilityLabel="MCP JSON 配置" multiline value={raw} onChangeText={setRaw} editable={!busy} maxLength={20000}
                autoCapitalize="none" autoCorrect={false} style={{ ...input, minHeight: 170, textAlignVertical: 'top' }} />
            {view?.capabilities?.storedToken === 1 ? <>
                <Text style={muted}>{storedToken ? 'Token 已加密保存。留空保留，填写新 Token 可替换。' : 'Token 可选；无需认证的服务留空。'}请填写 Token 本身，不含 Bearer 前缀。</Text>
                <TextInput accessibilityLabel="MCP Token" placeholder={storedToken ? '已保存（留空保留）' : '粘贴服务 Token（可选）'} value={token} onChangeText={value => { setToken(value); if (value.trim()) { setClearToken(false); setNeedsToken(false); } }}
                    secureTextEntry editable={!busy} maxLength={8192} autoCapitalize="none" autoCorrect={false} style={input} />
                {storedToken && <Pressable accessibilityRole="checkbox" accessibilityLabel="清除已保存 Token" accessibilityState={{ checked: clearToken, disabled: busy }} aria-checked={clearToken}
                    disabled={busy} onPress={() => { setClearToken(!clearToken); setToken(''); if (!clearToken) setNeedsToken(false); }} style={{ padding: 12, minHeight: 44 }}><Text style={text}>{clearToken ? '☑' : '☐'} 清除已保存 Token（保存后生效）</Text></Pressable>}
            </> : <Text style={muted}>宿主版本尚不支持直接保存 Token，请更新宿主后刷新。</Text>}
            {button(feedback?.phase === 'saving' ? '正在保存' : '检查并保存 MCP', () => {
                if (saveBlocked) return;
                try {
                    const config: unknown = JSON.parse(raw);
                    if (!name.trim() || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
                    mutate({ action: 'save', ...(editing ? { connectionID: editing } : {}), name: name.trim(), config: config as Record<string, unknown>,
                        ...(token.trim() ? { token: token.trim() } : clearToken ? { token: null } : {}) });
                } catch { setError('请填写名称和有效的 JSON 配置对象。'); }
            }, saveBlocked, feedback?.phase === 'saving')}{button('取消 MCP 编辑', () => { setForm(false); setRaw(httpExample); setName(''); setToken(''); setClearToken(false); setStoredToken(false); setNeedsToken(false); setFeedback(null); })}
        </View>;
    return <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 19, fontWeight: '600' }}>MCP 工具</Text>
        <Text style={muted}>Dot 可直接发现并调用已授权服务的工具。支持 Streamable HTTP 和本地 stdio；新 Dot 默认不启用。授权服务即允许 Dot 在你的请求范围内使用其工具。</Text>
        {busy && !feedback && <ActivityIndicator />}{error && <Text accessibilityRole="alert" style={{ ...text, color: '#b04b36' }}>{error}</Text>}
        {needsRefresh && <Text style={muted}>保存结果待核对，请刷新 MCP 连接后继续修改。</Text>}
        {notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
        {button('刷新 MCP 连接', () => void run())}
        {view && button('添加 MCP 服务', () => { setForm(true); setEditing(null); setName(''); setRaw(httpExample); setError(null); setToken(''); setClearToken(false); setStoredToken(false); setNeedsToken(false); setFeedback(null); })}
        {form && (!editing || missingEdit) && editor}
        {form && missingEdit && <Text style={muted}>这条连接已从宿主移除，当前草稿可复制。</Text>}
        {saveNotice(missingEdit ? editing : null)}
        {!!view?.connections.length && <TextInput accessibilityLabel="搜索 MCP 连接" placeholder="搜索名称、服务地址、机器或项目"
            placeholderTextColor={theme.colors.textSecondary} style={input} value={query} autoCapitalize="none" autoCorrect={false}
            editable={!form && !busy} onChangeText={value => { setQuery(value); setExpanded(null); setScopeDot(dotId ?? null); }} />}
        {!!view?.connections.length && !connections.length && <Text style={muted}>没有匹配的 MCP 连接。</Text>}
        {connections.map(connection => {
            const open = expanded === connection.id;
            const endpoint = typeof connection.config.url === 'string' ? connection.config.url : 'stdio · ' + String(connection.config.command);
            const bound = dots.filter(dot => dot.connectionIDs.includes(connection.id)).length;
            return <View key={connection.id} style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10 }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`查看 MCP：${connection.name}`} accessibilityState={{ expanded: open }} aria-expanded={open}
                    disabled={form || busy} onPress={() => { setExpanded(open ? null : connection.id); setScopeDot(dotId ?? null); }}
                    style={{ paddingHorizontal: 12, paddingVertical: 6, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ ...text, fontWeight: '600' }}>{connection.name}</Text>
                        <Text numberOfLines={1} style={muted}>{connection.control ? `${bound} 个 Dot · ${connection.control.projects.length} 个可用项目 · ${connection.control.machineID}` : `${bound} 个 Dot · ${endpoint}`}</Text>
                    </View>
                    <Text numberOfLines={1} style={muted}>{!connection.enabled ? '已停用' : connection.error ? '连接失败' : '检查通过'}</Text>
                    <Text accessible={false} style={muted}>{open ? '⌃' : '⌄'}</Text>
                </Pressable>
                {open && <View style={{ padding: 12, gap: 10, borderTopWidth: 1, borderColor: theme.colors.divider }}>
                    {form && editing === connection.id && editor}
                    {saveNotice(connection.id)}
                    {(!form || editing !== connection.id) && <>
                        <Text selectable style={muted}>{endpoint}</Text>
                        {connection.control && <Text style={muted}>Happy 项目执行 · {connection.control.projects.length} 个项目 · {new Date(connection.control.expiresAt).toLocaleString()} 到期。派工、跟进和取消由后台任务统一处理。</Text>}
                        {!connection.control && typeof connection.config.url === 'string' && /\/happy-control\/mcp$/.test(connection.config.url)
                            && <Text style={muted}>后台执行需要 Happy 服务提供完整 MCP 工具及授权信息，请升级服务后重新检查。</Text>}
                        {connection.error && <Text style={{ ...text, color: '#b04b36' }}>{dotsMcpError(new Error(connection.error))}</Text>}
                        <Text style={muted}>最近检查：{connection.checkedAt ? new Date(connection.checkedAt).toLocaleString() : '尚未检查'}{'\n'}工具（{connection.tools.length}）：{connection.tools.map(tool => tool.name).join('、') || '无'}</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                            {button(`检查 MCP：${connection.name}`, () => mutate({ action: 'check', connectionID: connection.id }))}
                            {button(`编辑 MCP：${connection.name}`, () => { setForm(true); setEditing(connection.id); setName(connection.name); setRaw(JSON.stringify(connection.config, null, 2)); setToken(''); setClearToken(false); setStoredToken(Boolean(connection.tokenConfigured)); setNeedsToken(false); setFeedback(null); })}
                            {button(`${connection.enabled ? '停用' : '启用'} MCP：${connection.name}`, () => mutate({ action: 'enable', connectionID: connection.id, enabled: !connection.enabled }))}
                            {button(`删除 MCP：${connection.name}`, () => mutate({ action: 'delete', connectionID: connection.id }))}
                        </View>
                        {dots.map(dot => {
                            const selected = dot.connectionIDs.includes(connection.id);
                            return <View key={dot.id} style={{ gap: 4 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                                    <Pressable accessibilityRole="checkbox"
                                    accessibilityLabel={`为 ${dot.name} 启用 MCP ${connection.name}`} accessibilityState={{ checked: selected, disabled: selectionDisabled }}
                                    aria-checked={selected} disabled={selectionDisabled} onPress={() => {
                                        if (!selected && connection.control) setScopeDot(dot.id);
                                        select(dot.id, connection.id, !selected, !selected ? connection.control?.projects.map(project => project.id) ?? [] : []);
                                    }} style={{ padding: 12, minHeight: 44 }}>
                                    <Text style={text}>{selected ? '☑' : '☐'} {dot.name}</Text>
                                </Pressable>
                                    {selected && connection.control && <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${dot.name} 的项目授权`}
                                        accessibilityState={{ expanded: scopeDot === dot.id }} aria-expanded={scopeDot === dot.id} onPress={() => setScopeDot(scopeDot === dot.id ? null : dot.id)}
                                        style={{ padding: 10, minHeight: 44, justifyContent: 'center' }}>
                                        <Text style={muted}>项目 {dot.projectBindings?.[connection.id]?.length ?? 0}/{connection.control.projects.length} {scopeDot === dot.id ? '⌃' : '⌄'}</Text>
                                    </Pressable>}
                                </View>
                            {selected && connection.control && scopeDot === dot.id && <View style={{ gap: 6, paddingLeft: 12 }}>
                                <Text style={muted}>勾选上方连接时将选中当前全部项目，可逐项调整；新 Dot 默认不启用后台执行</Text>
                                {connection.control.projects.map(project => {
                                    const projects = dot.projectBindings?.[connection.id] ?? [];
                                    const checked = projects.includes(project.id);
                                    return <Pressable key={project.id} accessibilityRole="checkbox" accessibilityLabel={`为 ${dot.name} 启用项目 ${project.id}`}
                                        accessibilityState={{ checked, disabled: selectionDisabled }} aria-checked={checked} disabled={selectionDisabled}
                                        onPress={() => select(dot.id, connection.id, true, checked ? projects.filter(id => id !== project.id) : [...projects, project.id])} style={{ padding: 12, minHeight: 44 }}>
                                        <Text style={text}>{checked ? '☑' : '☐'} {project.directory}</Text>
                                    </Pressable>;
                                })}
                            </View>}
                            </View>;
                        })}
                    </>}
                    {feedback?.connectionID === connection.id && feedback.phase === 'failed' && retrySelection.current?.revision === view?.revision &&
                        button('重试保存选择', () => {
                            const retry = retrySelection.current;
                            if (inFlight.current || requiresReconciliation.current || !retry || retry.revision !== confirmed.current?.revision || !current()) return;
                            desired.current = retry.drafts; retrySelection.current = null;
                            setDrafts(desired.current);
                            setFeedback({ connectionID: connection.id, phase: 'saving', text: '正在保存选择（勾选为待保存状态）' });
                            void run(undefined, undefined, true);
                        })}
                </View>}
            </View>;
        })}
        {!!view && !view.connections.length && <Text style={muted}>尚未配置 MCP 服务。</Text>}
        <Text style={muted}>变更在下一轮对话生效；后台任务会在派发前重新核对权限。检查读取工具目录，Happy 服务另读取当前授权，不创建或批准授权，也不派发任务。</Text>
    </View>;
}
