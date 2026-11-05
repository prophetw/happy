import * as React from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { getServerUrl } from '@/sync/serverConfig';
import { readTestloopDotsMetadata } from '@/sync/testloopDots';
import { dotsConnectionError, requestDotsConnections, type DotsConnectionsView,
    type DotsConnectionRequest, type DotsConnectionBinding } from '@/sync/dotsConnections';

function DotConnections({ dot, view, busy, save }: { dot: DotsConnectionsView['dots'][number]; view: DotsConnectionsView;
    busy: boolean; save: (bindings: DotsConnectionBinding) => void }) {
    const { theme } = useUnistyles();
    const [bindings, setBindings] = React.useState(dot.bindings);
    React.useEffect(() => setBindings(dot.bindings), [dot.bindings]);
    const selected = (connectionID: string, projectID: string) => bindings.some(binding => binding.connectionID === connectionID && binding.projectIDs.includes(projectID));
    const toggle = (connectionID: string, projectID: string) => setBindings(previous => {
        const ids = previous.find(binding => binding.connectionID === connectionID)?.projectIDs ?? [];
        return [...previous.filter(binding => binding.connectionID !== connectionID), { connectionID,
            projectIDs: ids.includes(projectID) ? ids.filter(id => id !== projectID) : [...ids, projectID] }].filter(binding => binding.projectIDs.length);
    });
    return <View style={{ gap: 12, borderTopWidth: 1, borderColor: theme.colors.divider, paddingTop: 18 }}>
        <Text style={{ color: theme.colors.text, fontWeight: '600', fontSize: 17 }}>{dot.name} · 可用连接与项目</Text>
        <Text style={{ color: theme.colors.textSecondary }}>{dot.source === 'existing'
            ? '当前沿用已有后台配置。保存后改为此 Dot 的显式选择。' : '仅勾选的项目可交给此 Dot；不选择表示不授予 REST 能力。'}</Text>
        {view.connections.map(connection => <View key={connection.id} style={{ gap: 8 }}>
            <Text style={{ color: theme.colors.text }}>{connection.name}{!connection.enabled ? '（已停用）' : ''}</Text>
            {connection.projects.map(project => <Pressable key={project.id} accessibilityRole="checkbox"
                accessibilityLabel={`${dot.name} 使用 ${connection.name} 的 ${project.id}`} accessibilityState={{ checked: selected(connection.id, project.id), disabled: busy }}
                aria-checked={selected(connection.id, project.id)} aria-disabled={busy}
                disabled={busy} onPress={() => toggle(connection.id, project.id)} style={{ padding: 12, minHeight: 44, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8 }}>
                <Text style={{ color: theme.colors.text }}>{selected(connection.id, project.id) ? '☑' : '☐'} {project.id}</Text>
                {!!project.directory && <Text style={{ color: theme.colors.textSecondary }}>{project.directory}</Text>}
            </Pressable>)}
        </View>)}
        {!view.connections.length && <Text style={{ color: theme.colors.textSecondary }}>先添加一个连接，再为此 Dot 选择项目。</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`保存 ${dot.name} 的授权选择`} disabled={busy} onPress={() => save(bindings)} style={{ padding: 14, minHeight: 44, backgroundColor: '#6650b7', borderRadius: 8 }}>
            <Text style={{ color: '#fff' }}>保存授权选择</Text>
        </Pressable>
    </View>;
}

/** Credentials travel only through encrypted session RPC; this component never sends a chat message. */
export function DotsConnectionsPanel({ sessionId, workspaceId, dotId, onClose }: {
    sessionId: string; workspaceId: string; dotId?: string; onClose: () => void;
}) {
    const { theme } = useUnistyles(), { credentials, isAuthenticated } = useAuth();
    const server = getServerUrl();
    const accountScope = React.useMemo(() => ({}), [credentials?.token, credentials?.secret, isAuthenticated, server, sessionId, workspaceId]);
    const [renderScope, setRenderScope] = React.useState(accountScope);
    const [view, setView] = React.useState<DotsConnectionsView | null>(null);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null), [notice, setNotice] = React.useState<string | null>(null);
    const [name, setName] = React.useState(''), [endpoint, setEndpoint] = React.useState(''), [token, setToken] = React.useState('');
    const epoch = React.useRef(0), inFlight = React.useRef(false);
    const current = React.useCallback(() => {
        const binding = readTestloopDotsMetadata(storage.getState().sessions[sessionId]?.metadata);
        return isAuthenticated && credentials?.token === sync.getCredentials()?.token
            && credentials?.secret === sync.getCredentials()?.secret && server === getServerUrl()
            && binding?.kind === 'workspace' && binding.workspaceId === workspaceId;
    }, [sessionId, workspaceId, credentials?.token, credentials?.secret, isAuthenticated, server]);
    const run = React.useCallback(async (request: DotsConnectionRequest) => {
        if (inFlight.current || !current()) return;
        const operation = epoch.current; inFlight.current = true; setBusy(true); setError(null); setNotice(null);
        try {
            await sync.ensureSessionReady(sessionId);
            if (operation !== epoch.current || !current()) return;
            const result = await requestDotsConnections(sessionId, request);
            if (operation !== epoch.current || !current()) return;
            setView(result);
            if (request.action !== 'list') setNotice(request.action === 'check' ? '已完成连接检查，请查看状态。' : '连接配置已保存。');
            if (request.action === 'add') { setName(''); setEndpoint(''); }
        } catch (failure) {
            if (operation === epoch.current && current()) setError(dotsConnectionError(failure));
        } finally {
            if (operation === epoch.current) { setToken(''); setBusy(false); inFlight.current = false; }
        }
    }, [current, sessionId]);
    React.useEffect(() => {
        setRenderScope(accountScope);
        epoch.current++; inFlight.current = false; setView(null); setToken(''); setError(null); setNotice(null);
        void run({ action: 'list' });
        return () => { epoch.current++; inFlight.current = false; };
    }, [run, accountScope]);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', state => { if (state !== 'active') setToken(''); });
        const clear = () => { if (document.visibilityState !== 'visible') setToken(''); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', clear);
        return () => { subscription.remove(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', clear); };
    }, []);
    const text = { color: theme.colors.text, lineHeight: 22 };
    const muted = { color: theme.colors.textSecondary, lineHeight: 21, fontSize: 13 };
    const input = { borderWidth: 1, borderColor: theme.colors.divider, color: theme.colors.text, borderRadius: 8, padding: 12, fontSize: 15 };
    const button = (label: string, action: () => void, disabled = busy) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={action}
        style={{ padding: 12, minHeight: 44, backgroundColor: theme.colors.surfaceHigh, borderRadius: 8, opacity: disabled ? 0.5 : 1 }}><Text style={text}>{label}</Text></Pressable>;
    const mutate = (request: Omit<Extract<DotsConnectionRequest, { action: 'enable' }>, 'requestId' | 'revision'>
        | Omit<Extract<DotsConnectionRequest, { action: 'check' }>, 'requestId' | 'revision'>
        | Omit<Extract<DotsConnectionRequest, { action: 'bind' }>, 'requestId' | 'revision'>) => {
        if (view) void run({ ...request, revision: view.revision, requestId: randomUUID() });
    };
    if (renderScope !== accountScope || !current()) return null;
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#00000066', padding: 18, alignItems: 'center', justifyContent: 'center' }}>
            <ScrollView accessibilityViewIsModal keyboardShouldPersistTaps="handled" style={{ maxHeight: '94%', width: '100%', maxWidth: 720, backgroundColor: theme.colors.surface, borderRadius: 18 }} contentContainerStyle={{ padding: 24, gap: 18 }}>
                <Text accessibilityRole="header" style={{ ...text, fontSize: 22, fontWeight: '600' }}>连接与授权</Text>
                <Text style={muted}>REST 是外置能力。后台保管服务令牌，每个 Dot 单独选择获准的项目；新 Dot 默认没有 REST 权限。</Text>
                {button('关闭连接管理', onClose, false)}
                {busy && <ActivityIndicator />}
                {error && <Text accessibilityRole="alert" style={text}>{error}</Text>}
                {notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
                {button('刷新连接与授权', () => void run({ action: 'list' }))}
                {view?.connections.map(connection => <View key={connection.id} style={{ gap: 8, borderTopWidth: 1, borderColor: theme.colors.divider, paddingTop: 16 }}>
                    <Text style={{ ...text, fontWeight: '600' }}>{connection.name} · {{ disabled: '已停用', expired: '已到期', error: '检查失败', verified: '已验证', unverified: '未验证' }[connection.status]}</Text>
                    <Text selectable style={muted}>{connection.endpoint}</Text>
                    <Text selectable style={muted}>授权：{connection.grantID}{'\n'}机器：{connection.machineID}</Text>
                    <Text style={muted}>{connection.source === 'existing' ? '来源：已有后台配置' : '来源：手动添加'} · {connection.credentialSource === 'environment' ? '宿主环境变量' : '后台加密保存'} · {connection.credentialConfigured ? '凭据已配置' : '凭据缺失'}</Text>
                    <Text style={muted}>到期：{connection.expiresAt === null ? '尚未检查' : new Date(connection.expiresAt).toLocaleString()}{'\n'}最近检查：{connection.checkedAt ? new Date(connection.checkedAt).toLocaleString() : '尚未检查'}</Text>
                    <Text style={muted}>允许操作：{connection.methods.join('、') || '尚未检查'}</Text>
                    {connection.projects.map(project => <Text key={project.id} selectable style={muted}>{project.id}{project.directory ? ` · ${project.directory}` : ''}</Text>)}
                    {connection.error && <Text accessibilityRole="alert" style={text}>{dotsConnectionError(new Error(connection.error))}</Text>}
                    {button(`检查连接：${connection.name}`, () => mutate({ action: 'check', connectionID: connection.id }))}
                    {button(`${connection.enabled ? '停用' : '启用'}连接：${connection.name}`, () => mutate({ action: 'enable', connectionID: connection.id, enabled: !connection.enabled }))}
                </View>)}
                {!dotId && <View style={{ gap: 12, borderTopWidth: 1, borderColor: theme.colors.divider, paddingTop: 18 }}>
                    <Text style={{ ...text, fontWeight: '600' }}>添加 Happy REST 连接</Text>
                    <Text style={muted}>先在 Happy「助手连接」批准服务授权，再将服务令牌填在这里。保存前会只读核验授权范围；不会创建任务。</Text>
                    <TextInput accessibilityLabel="连接名称" placeholder="连接名称" value={name} onChangeText={setName} editable={!busy} maxLength={80} style={input} />
                    <TextInput accessibilityLabel="REST 服务地址" placeholder="https://…/happy-control/v1" value={endpoint} onChangeText={setEndpoint} editable={!busy} maxLength={2048} autoCapitalize="none" autoCorrect={false} style={input} />
                    <TextInput accessibilityLabel="服务访问令牌" placeholder="服务访问令牌（仅提交后台）" value={token} onChangeText={setToken} editable={!busy} maxLength={256} secureTextEntry autoCapitalize="none" autoCorrect={false} style={input} />
                    {button('核验并保存连接', () => { if (view) void run({ action: 'add', requestId: randomUUID(), revision: view.revision, name: name.trim(), endpoint: endpoint.trim(), token: token.trim() }); }, busy || !view || !name.trim() || !endpoint.trim() || !token.trim())}
                </View>}
                {view?.dots.filter(dot => !dotId || dot.id === dotId).map(dot => <DotConnections key={dot.id} dot={dot} view={view} busy={busy} save={bindings => mutate({ action: 'bind', dotId: dot.id, bindings })} />)}
                <Text style={muted}>取消项目选择或停用连接会阻止后续派工与访问，不会自动停止已在远端运行的任务。需要停止时，请先在执行会话处理。任务和对话历史会保留。到期或撤销后需重新批准并添加新连接。</Text>
            </ScrollView>
        </View>
    </Modal>;
}
