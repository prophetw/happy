import * as React from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata } from '@/sync/testloopDots';
import { dotsConnectionError, dotsConnectionStatus, dotsConnectionUsable, dotsProjectName, previewDotsConnection,
    requestDotsConnections, type DotsConnectionsView, type DotsConnectionRequest, type DotsConnectionPreview,
    type DotsConnection, type DotsConnectionBinding } from '@/sync/dotsConnections';

type Screen = { kind: 'home' } | { kind: 'dot'; dotId: string }
    | { kind: 'choose'; dotId: string; oldID?: string }
    | { kind: 'projects'; dotId: string; connectionID: string; oldID?: string }
    | { kind: 'credential'; oldID?: string; dotId?: string };
type Mutation = DotsConnectionRequest extends infer R ? R extends { revision: number; requestId: string } ? Omit<R, 'revision' | 'requestId'> : never : never;

/** Credentials travel only through encrypted workspace RPC, never through chat or model input. */
export function DotsConnectionsPanel({ sessionId, workspaceId, dotId, onClose }: {
    sessionId: string; workspaceId: string; dotId?: string; onClose: () => void;
}) {
    const { theme } = useUnistyles(), { credentials, isAuthenticated } = useAuth();
    const server = getServerUrl();
    const accountScope = React.useMemo(() => ({}), [credentials?.token, credentials?.secret, isAuthenticated, server, sessionId, workspaceId]);
    const [renderScope, setRenderScope] = React.useState(accountScope);
    const [view, setView] = React.useState<DotsConnectionsView | null>(null);
    const [screen, setScreen] = React.useState<Screen>(dotId ? { kind: 'dot', dotId } : { kind: 'home' });
    const [tab, setTab] = React.useState<'connections' | 'dots'>('connections');
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null), [notice, setNotice] = React.useState<string | null>(null);
    const [name, setName] = React.useState(''), [endpoint, setEndpoint] = React.useState(''), [token, setToken] = React.useState('');
    const [preview, setPreview] = React.useState<DotsConnectionPreview | null>(null), [projectIDs, setProjectIDs] = React.useState<string[]>([]);
    const [targetDot, setTargetDot] = React.useState<string | null>(null), [expanded, setExpanded] = React.useState<string | null>(null);
    const [showInactive, setShowInactive] = React.useState(false);
    const epoch = React.useRef(0), inFlight = React.useRef(false);
    const current = React.useCallback(() => {
        const binding = readTestloopDotsMetadata(storage.getState().sessions[sessionId]?.metadata);
        return isAuthenticated && credentials?.token === sync.getCredentials()?.token
            && credentials?.secret === sync.getCredentials()?.secret && server === getServerUrl()
            && binding?.kind === 'workspace' && binding.workspaceId === workspaceId;
    }, [sessionId, workspaceId, credentials?.token, credentials?.secret, isAuthenticated, server]);
    const clearSecret = React.useCallback(() => { setToken(''); setPreview(null); }, []);
    const navigate = (next: Screen) => { clearSecret(); setError(null); setNotice(null); setScreen(next); };
    const run = React.useCallback(async <T,>(operation: () => Promise<T>, apply: (result: T) => void) => {
        if (inFlight.current || !current()) return;
        const version = epoch.current; inFlight.current = true; setBusy(true); setError(null); setNotice(null);
        try {
            await sync.ensureSessionReady(sessionId);
            if (version !== epoch.current || !current()) return;
            const result = await operation();
            if (version === epoch.current && current()) apply(result);
        } catch (failure) {
            if (version === epoch.current && current()) { setError(dotsConnectionError(failure)); clearSecret(); }
        } finally {
            if (version === epoch.current) { setBusy(false); inFlight.current = false; }
        }
    }, [current, sessionId, clearSecret]);
    const refresh = React.useCallback(() => run(() => requestDotsConnections(sessionId, { action: 'list' }), setView), [run, sessionId]);
    const mutate = (request: Mutation, next?: Screen) => {
        if (!view) return;
        void run(() => requestDotsConnections(sessionId, { ...request, revision: view.revision, requestId: randomUUID() }), result => {
            setView(result); clearSecret(); if (next) setScreen(next);
            setNotice(request.action === 'check' ? '检查完成。' : request.action === 'replace' ? '已换用新授权，项目选择已保存。' : '已保存。');
        });
    };
    React.useEffect(() => {
        setRenderScope(accountScope); epoch.current++; inFlight.current = false; setView(null); clearSecret(); setError(null); setNotice(null);
        setScreen(dotId ? { kind: 'dot', dotId } : { kind: 'home' });
        void refresh();
        return () => { epoch.current++; inFlight.current = false; };
    }, [refresh, accountScope, dotId, clearSecret]);
    React.useEffect(() => {
        const clear = () => { epoch.current++; inFlight.current = false; setBusy(false); clearSecret(); };
        const subscription = AppState.addEventListener('change', state => { if (state !== 'active') clear(); });
        const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
        return () => { subscription.remove(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); };
    }, [clearSecret]);
    const text = { color: theme.colors.text, lineHeight: 22 };
    const muted = { color: theme.colors.textSecondary, lineHeight: 20, fontSize: 13 };
    const card = { gap: 12, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.divider } as const;
    const input = { borderWidth: 1, borderColor: theme.colors.divider, color: theme.colors.text, borderRadius: 8, padding: 12, fontSize: 15 };
    const row = { flexDirection: 'row', flexWrap: 'wrap', gap: 8 } as const;
    const button = (label: string, action: () => void, primary = false, disabled = busy) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
        disabled={disabled} onPress={action} style={{ padding: 12, minHeight: 44, backgroundColor: primary ? '#6650b7' : theme.colors.surfaceHigh, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}>
        <Text style={{ ...text, color: primary ? '#fff' : text.color }}>{label}</Text></Pressable>;
    const heading = (title: string) => <Text accessibilityRole="header" style={{ ...text, fontSize: 19, fontWeight: '600' }}>{title}</Text>;
    const findConnection = (id: string) => view?.connections.find(c => c.id === id);
    const dot = 'dotId' in screen ? view?.dots.find(d => d.id === screen.dotId) : undefined;
    const old = 'oldID' in screen && screen.oldID ? findConnection(screen.oldID) : undefined;
    const selectedConnection = screen.kind === 'projects' ? findConnection(screen.connectionID) : undefined;
    const startCredential = (oldID?: string, selectedDot?: string) => {
        const connection = oldID ? findConnection(oldID) : undefined;
        navigate({ kind: 'credential', oldID, dotId: selectedDot }); setName(connection?.name ?? 'Happy 项目执行');
        let defaultEndpoint = ''; try { defaultEndpoint = new URL(server).origin + '/happy-control/v1'; } catch { /* User can enter a service address. */ }
        setEndpoint(connection?.endpoint ?? view?.connections[0]?.endpoint ?? defaultEndpoint);
        const attached = view?.dots.filter(d => d.bindings.some(b => b.connectionID === oldID)) ?? [];
        setTargetDot(selectedDot ?? (connection && attached.length === 1 ? attached[0].id : null)); setProjectIDs([]);
    };
    const projectPicker = (projects: DotsConnection['projects']) => <View style={{ gap: 8 }}>
        <View style={{ ...row, alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={text}>启用项目 · {projectIDs.length} / {projects.length}</Text>
            <View style={row}>{button('全选项目', () => setProjectIDs(projects.map(p => p.id)))}{button('清空项目', () => setProjectIDs([]))}</View>
        </View>
        {projects.map(p => <Pressable key={p.id} accessibilityRole="checkbox" accessibilityLabel={`启用项目 ${dotsProjectName(p)}`}
            accessibilityState={{ checked: projectIDs.includes(p.id), disabled: busy }} aria-checked={projectIDs.includes(p.id)} disabled={busy}
            onPress={() => setProjectIDs(ids => ids.includes(p.id) ? ids.filter(id => id !== p.id) : [...ids, p.id])}
            style={{ ...card, gap: 3, backgroundColor: projectIDs.includes(p.id) ? theme.colors.surfaceHigh : theme.colors.surface }}>
            <Text style={text}>{projectIDs.includes(p.id) ? '☑' : '☐'} {dotsProjectName(p)}</Text>
            {!!p.directory && <Text selectable style={muted}>{p.directory}</Text>}
        </Pressable>)}
    </View>;
    const connectionCard = (connection: DotsConnection) => <View key={connection.id} style={card}>
        <View style={{ ...row, justifyContent: 'space-between' }}><Text style={{ ...text, fontWeight: '600' }}>{connection.name}</Text><Text style={muted}>{dotsConnectionStatus(connection)}</Text></View>
        <Text style={muted}>{connection.projects.length} 个项目 · {connection.expiresAt ? `${new Date(connection.expiresAt).toLocaleDateString()} 到期` : '尚未核验到期时间'}</Text>
        <Text style={text}>{connection.projects.map(dotsProjectName).join('、') || '尚未读取项目'}</Text>
        {connection.error && <Text style={{ ...muted, color: '#b04b36' }}>{dotsConnectionError(new Error(connection.error))}</Text>}
        <View style={row}>{button(`更新授权：${connection.name}`, () => startCredential(connection.id))}
            {button(`连接详情：${connection.name}`, () => setExpanded(expanded === connection.id ? null : connection.id))}</View>
        {expanded === connection.id && <View style={{ gap: 10, borderTopWidth: 1, borderColor: theme.colors.divider, paddingTop: 12 }}>
            <Text selectable style={muted}>{connection.endpoint}</Text>
            <Text selectable style={muted}>授权 ID：{connection.grantID}{'\n'}机器 ID：{connection.machineID}</Text>
            <Text style={muted}>凭据：{connection.credentialSource === 'stored' ? '后台加密保存' : '宿主环境变量'} · {connection.credentialConfigured ? '已配置' : '缺失'}</Text>
            <Text style={muted}>最近检查：{connection.checkedAt ? new Date(connection.checkedAt).toLocaleString() : '尚未检查'}{'\n'}允许操作：{connection.methods.join('、')}</Text>
            <View style={row}>{button(`检查连接：${connection.name}`, () => mutate({ action: 'check', connectionID: connection.id }))}
                {button(`${connection.enabled ? '停用' : '启用'}连接：${connection.name}`, () => mutate({ action: 'enable', connectionID: connection.id, enabled: !connection.enabled }))}</View>
        </View>}
    </View>;
    const saveProjects = () => {
        if (!dot || !selectedConnection || screen.kind !== 'projects') return;
        const bindings: DotsConnectionBinding = dot.bindings.filter(b => b.connectionID !== screen.oldID && b.connectionID !== selectedConnection.id);
        if (projectIDs.length) bindings.push({ connectionID: selectedConnection.id, projectIDs });
        mutate({ action: 'bind', dotId: dot.id, bindings }, { kind: 'dot', dotId: dot.id });
    };
    const back = () => navigate(screen.kind !== 'dot' && 'dotId' in screen && screen.dotId ? { kind: 'dot', dotId: screen.dotId } : { kind: 'home' });
    if (renderScope !== accountScope || !current()) return null;
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#00000066', padding: 12, alignItems: 'center', justifyContent: 'center' }}>
            <View accessibilityViewIsModal style={{ maxHeight: '92%', width: '100%', maxWidth: 800, backgroundColor: theme.colors.surface, borderRadius: 18, overflow: 'hidden' }}>
                <View style={{ padding: 16, gap: 12, borderBottomWidth: 1, borderColor: theme.colors.divider }}>
                    <View style={{ ...row, alignItems: 'center', justifyContent: 'space-between' }}>
                        {heading('连接与授权')}<View style={row}>{screen.kind !== 'home' && button('返回', back)}
                            {button('关闭连接管理', onClose, false, false)}</View>
                    </View>
                    {screen.kind === 'home' && <View style={row}>{button('我的连接', () => setTab('connections'), tab === 'connections')}
                        {button('Dot 授权', () => setTab('dots'), tab === 'dots')}{button('刷新连接与授权', () => void refresh())}</View>}
                </View>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, gap: 16 }}>
                    {busy && <ActivityIndicator />}
                    {error && <View style={card}><Text accessibilityRole="alert" style={{ ...text, color: '#b04b36' }}>{error}</Text>{button('刷新核对', () => void refresh())}</View>}
                    {notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
                    {!view && !busy && !error && <Text style={muted}>暂无连接信息。</Text>}
                    {view && !view.capabilities && <Text style={muted}>宿主尚未支持授权预览与换绑，请更新 TestLoop 宿主后重试。</Text>}
                    {view && screen.kind === 'home' && tab === 'connections' && <>
                        <Text style={muted}>连接保存服务令牌和授权范围；到「Dot 授权」为每个 Dot 选择可用项目。</Text>
                        {button('添加连接', () => startCredential(), true, busy || !view.capabilities)}
                        {view.connections.filter(dotsConnectionUsable).map(connectionCard)}
                        {!view.connections.some(dotsConnectionUsable) && <Text style={text}>还没有可用连接。添加新的服务令牌，验证后即可选择项目。</Text>}
                        {view.connections.some(c => !dotsConnectionUsable(c)) && button(`${showInactive ? '收起' : '查看'}不可用连接（${view.connections.filter(c => !dotsConnectionUsable(c)).length}）`, () => setShowInactive(!showInactive))}
                        {showInactive && view.connections.filter(c => !dotsConnectionUsable(c)).map(connectionCard)}
                    </>}
                    {view && screen.kind === 'home' && tab === 'dots' && <>
                        <Text style={muted}>每个 Dot 独立选择连接和项目。新 Dot 默认没有项目执行权限。</Text>
                        {view.dots.map(d => <View key={d.id} style={card}><Text style={{ ...text, fontWeight: '600' }}>{d.name}</Text>
                            <Text style={muted}>{d.bindings.length ? `${d.bindings.reduce((n, b) => n + b.projectIDs.length, 0)} 个已选项目` : '尚未授权'}</Text>
                            {button(`管理 ${d.name} 的授权`, () => navigate({ kind: 'dot', dotId: d.id }))}</View>)}
                    </>}
                    {dot && screen.kind === 'dot' && <>
                        {heading(dot.name)}<Text style={muted}>当前可用连接与项目。授权变更对后续派工生效，已有任务和会话保留。</Text>
                        {dot.bindings.map(binding => { const c = findConnection(binding.connectionID); return c && <View key={c.id} style={card}>
                            <Text style={{ ...text, fontWeight: '600' }}>{c.name} · {dotsConnectionStatus(c)}</Text>
                            <Text style={text}>{c.projects.filter(p => binding.projectIDs.includes(p.id)).map(dotsProjectName).join('、')}</Text>
                            {c.error && <Text style={muted}>{dotsConnectionError(new Error(c.error))}</Text>}
                            <View style={row}>{button(`更换连接：${c.name}`, () => navigate({ kind: 'choose', dotId: dot.id, oldID: c.id }))}
                                {button(`更新服务令牌：${c.name}`, () => startCredential(c.id, dot.id), false, busy || !view?.capabilities)}
                                {button(`调整项目：${c.name}`, () => { navigate({ kind: 'projects', dotId: dot.id, connectionID: c.id }); setProjectIDs(binding.projectIDs); })}
                                {button(`解除连接：${c.name}`, () => mutate({ action: 'bind', dotId: dot.id, bindings: dot.bindings.filter(b => b.connectionID !== c.id) }))}</View>
                        </View>; })}
                        {!dot.bindings.length && <Text style={text}>尚未授权，先为此 Dot 选择连接。</Text>}
                        {button('选择连接', () => navigate({ kind: 'choose', dotId: dot.id }), true)}
                    </>}
                    {dot && screen.kind === 'choose' && <>
                        {heading(`为 ${dot.name} 选择连接`)}{old && <Text style={muted}>替换当前连接：{old.name}</Text>}
                        {view?.connections.filter(c => dotsConnectionUsable(c) && c.id !== old?.id).map(c => <View key={c.id} style={card}>
                            <Text style={text}>{c.name} · {c.projects.length} 个项目</Text><Text style={muted}>{c.projects.map(dotsProjectName).join('、')}</Text>
                            {button(`使用连接：${c.name}`, () => { navigate({ kind: 'projects', dotId: dot.id, connectionID: c.id, oldID: old?.id }); setProjectIDs([]); })}</View>)}
                        {button('使用新的服务令牌', () => startCredential(old?.id, dot.id), true, busy || !view?.capabilities)}
                    </>}
                    {dot && selectedConnection && screen.kind === 'projects' && <>
                        {heading(`${dot.name} · 选择项目`)}<Text style={muted}>{selectedConnection.name} · {dotsConnectionStatus(selectedConnection)}</Text>
                        {projectPicker(selectedConnection.projects)}{button('保存项目选择', saveProjects, true)}
                    </>}
                    {view && screen.kind === 'credential' && <>
                        {heading(preview ? '核对授权与项目' : old ? '更新服务令牌' : '添加连接')}
                        {!preview ? <>
                            <Text style={muted}>填写 Happy「助手连接」中已批准的服务令牌。验证只读取授权，不会创建任务。</Text>
                            <TextInput accessibilityLabel="连接名称" placeholder="连接名称" value={name} onChangeText={setName} editable={!busy} maxLength={80} style={input} />
                            <TextInput accessibilityLabel="REST 服务地址" placeholder="https://…/happy-control/v1" value={endpoint} onChangeText={setEndpoint} editable={!busy && !old} maxLength={2048} autoCapitalize="none" autoCorrect={false} style={input} />
                            <TextInput accessibilityLabel="服务访问令牌" placeholder="粘贴完整服务令牌" value={token} onChangeText={setToken} editable={!busy} maxLength={256} secureTextEntry autoCapitalize="none" autoCorrect={false} style={input} />
                            {button('验证授权', () => void run(() => previewDotsConnection(sessionId, endpoint.trim(), token.trim()), result => { setPreview(result); setProjectIDs([]); }), true,
                                busy || !view.capabilities || !name.trim() || !endpoint.trim() || !token.trim())}
                        </> : <>
                            <View style={card}><Text style={{ ...text, fontWeight: '600' }}>授权有效 · {preview.projects.length} 个项目</Text>
                                <Text style={muted}>{new Date(preview.expiresAt).toLocaleString()} 到期{'\n'}{preview.endpoint}</Text></View>
                            {screen.dotId ? <Text style={text}>用于：{dot?.name}</Text> : <View style={{ gap: 8 }}>
                                <Text style={text}>{old ? '为哪个 Dot 更换授权？' : '同时授权给 Dot（可选）'}</Text>
                                {button(targetDot === null ? '✓ 仅保存连接' : '仅保存连接', () => setTargetDot(null))}
                                {view.dots.filter(d => !old || d.bindings.some(b => b.connectionID === old.id)).map(d => button(`${targetDot === d.id ? '✓ ' : ''}授权给 ${d.name}`, () => setTargetDot(d.id)))}
                            </View>}
                            {targetDot && projectPicker(preview.projects)}
                            <Text style={muted}>{targetDot ? `本次启用 ${projectIDs.length} 个项目。${old ? '只替换所选 Dot 的连接，其他 Dot 保留原选择。' : ''}` : '连接保存后，可在 Dot 授权中选择项目。'}</Text>
                            {button(old ? '保存并替换授权' : '保存连接与授权', () => {
                                const assignment = targetDot ? { dotId: targetDot, projectIDs } : undefined;
                                const next: Screen = targetDot ? { kind: 'dot', dotId: targetDot } : { kind: 'home' };
                                if (old) mutate({ action: 'replace', connectionID: old.id, name: name.trim(), token: token.trim(), previewDigest: preview.digest, assignments: assignment ? [assignment] : [] }, next);
                                else mutate({ action: 'add', name: name.trim(), endpoint: preview.endpoint, token: token.trim(), previewDigest: preview.digest, assignment }, next);
                            }, true, busy || !!targetDot && (!projectIDs.length || projectIDs.length > 16))}
                            {button('重新填写令牌', clearSecret)}
                        </>}
                    </>}
                </ScrollView>
            </View>
        </View>
    </Modal>;
}
