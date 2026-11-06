import * as React from 'react';
import { ActivityIndicator, AppState, Pressable, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { useUnistyles } from 'react-native-unistyles';
import { dotsMcpError, requestDotsMcp, type DotsMcpMutation, type DotsMcpView } from '@/sync/dotsMcpConnections';

const httpExample = JSON.stringify({ url: 'https://example.com/mcp' }, null, 2);
const happyControlExample = JSON.stringify({ url: 'https://example.com/happy-control/mcp' }, null, 2);
const stdioExample = JSON.stringify({ command: 'node', args: ['/absolute/path/server.mjs'], env_vars: ['MY_MCP_TOKEN'] }, null, 2);
export function DotsMcpPanel({ sessionId, dotId, current }: { sessionId: string; dotId?: string; current: () => boolean }) {
    const { theme } = useUnistyles();
    const [view, setView] = React.useState<DotsMcpView | null>(null), [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null), [notice, setNotice] = React.useState<string | null>(null);
    const [editing, setEditing] = React.useState<string | null>(null), [name, setName] = React.useState('');
    const [raw, setRaw] = React.useState(httpExample), [form, setForm] = React.useState(false);
    const [token, setToken] = React.useState(''), [clearToken, setClearToken] = React.useState(false), [storedToken, setStoredToken] = React.useState(false);
    const epoch = React.useRef(0), inFlight = React.useRef(false);
    const run = React.useCallback(async (mutation?: DotsMcpMutation, revision?: number) => {
        if (inFlight.current || !current()) return;
        const version = epoch.current; inFlight.current = true; setBusy(true); setError(null); setNotice(null);
        try {
            const result = await requestDotsMcp(sessionId, mutation ? { ...mutation, revision: revision!, requestId: randomUUID() } : { action: 'list' });
            if (version !== epoch.current || !current()) return;
            setView(result);
            if (mutation) { setNotice(mutation.action === 'check' ? '检查完成，请查看连接状态。' : '已保存。'); setForm(false); setRaw(httpExample); setName(''); setEditing(null); setToken(''); setClearToken(false); setStoredToken(false); }
        } catch (failure) { if (version === epoch.current && current()) { setError(dotsMcpError(failure)); setToken(''); } }
        finally { if (version === epoch.current) { inFlight.current = false; setBusy(false); } }
    }, [current, sessionId]);
    React.useEffect(() => { void run(); return () => { epoch.current++; }; }, [run]);
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
    const button = (label: string, action: () => void) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label}
        onPress={action} disabled={busy} style={{ padding: 12, borderRadius: 8, minHeight: 44, backgroundColor: theme.colors.surfaceHigh, opacity: busy ? 0.5 : 1 }}><Text style={text}>{label}</Text></Pressable>;
    const dots = view?.dots.filter(dot => !dotId || dot.id === dotId) ?? [];
    return <View style={{ gap: 12 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 19, fontWeight: '600' }}>MCP 工具</Text>
        <Text style={muted}>Dot 可直接发现并调用已授权服务的工具。支持 Streamable HTTP 和本地 stdio；新 Dot 默认不启用。授权服务即允许 Dot 在你的请求范围内使用其工具。</Text>
        {busy && <ActivityIndicator />}{error && <Text accessibilityRole="alert" style={{ ...text, color: '#b04b36' }}>{error}</Text>}
        {notice && <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text>}
        {button('刷新 MCP 连接', () => void run())}
        {view && button('添加 MCP 服务', () => { setForm(true); setEditing(null); setName(''); setRaw(httpExample); setError(null); setToken(''); setClearToken(false); setStoredToken(false); })}
        {form && <View style={{ gap: 10 }}>
            <TextInput accessibilityLabel="MCP 名称" placeholder="服务名称" value={name} onChangeText={setName} editable={!busy} maxLength={80} style={input} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{button('HTTP 配置示例', () => setRaw(httpExample))}{button('Happy Control 配置示例', () => { setRaw(happyControlExample); setName('Happy Control'); })}{button('stdio 配置示例', () => setRaw(stdioExample))}</View>
            <Text style={muted}>填入单个服务的 JSON 配置，HTTP Token 可在下方填写，不需要配置环境变量。也可在 JSON 中填写 bearer_token_env_var 引用宿主环境变量，请只选择一种方式。可用 enabled_tools 数组限制工具，省略则允许服务全部工具。本地命令在 TestLoop 宿主运行。</Text>
            <TextInput accessibilityLabel="MCP JSON 配置" multiline value={raw} onChangeText={setRaw} editable={!busy} maxLength={20000}
                autoCapitalize="none" autoCorrect={false} style={{ ...input, minHeight: 170, textAlignVertical: 'top' }} />
            {view?.capabilities?.storedToken === 1 ? <>
                <Text style={muted}>{storedToken ? 'Token 已加密保存。留空保留，填写新 Token 可替换。' : 'Token 可选；无需认证的服务留空。'}请填写 Token 本身，不含 Bearer 前缀。</Text>
                <TextInput accessibilityLabel="MCP Token" placeholder={storedToken ? '已保存（留空保留）' : '粘贴服务 Token（可选）'} value={token} onChangeText={value => { setToken(value); if (value) setClearToken(false); }}
                    secureTextEntry editable={!busy} maxLength={8192} autoCapitalize="none" autoCorrect={false} style={input} />
                {storedToken && <Pressable accessibilityRole="checkbox" accessibilityLabel="清除已保存 Token" accessibilityState={{ checked: clearToken, disabled: busy }} aria-checked={clearToken}
                    disabled={busy} onPress={() => { setClearToken(!clearToken); setToken(''); }} style={{ padding: 12, minHeight: 44 }}><Text style={text}>{clearToken ? '☑' : '☐'} 清除已保存 Token（保存后生效）</Text></Pressable>}
            </> : <Text style={muted}>宿主版本尚不支持直接保存 Token，请更新宿主后刷新。</Text>}
            {button('检查并保存 MCP', () => {
                try {
                    const config: unknown = JSON.parse(raw);
                    if (!name.trim() || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
                    mutate({ action: 'save', ...(editing ? { connectionID: editing } : {}), name: name.trim(), config: config as Record<string, unknown>,
                        ...(token.trim() ? { token: token.trim() } : clearToken ? { token: null } : {}) });
                } catch { setError('请填写名称和有效的 JSON 配置对象。'); }
            })}{button('取消 MCP 编辑', () => { setForm(false); setRaw(httpExample); setName(''); setToken(''); setClearToken(false); setStoredToken(false); })}
        </View>}
        {view?.connections.map(connection => <View key={connection.id} style={{ borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 12, padding: 16, gap: 10 }}>
            <Text style={{ ...text, fontWeight: '600' }}>{connection.name} · {!connection.enabled ? '已停用' : connection.error ? '连接失败' : '检查通过'}</Text>
            <Text selectable style={muted}>{typeof connection.config.url === 'string' ? connection.config.url : 'stdio · ' + String(connection.config.command)}</Text>
            {connection.error && <Text style={{ ...text, color: '#b04b36' }}>{dotsMcpError(new Error(connection.error))}</Text>}
            <Text style={muted}>最近检查：{connection.checkedAt ? new Date(connection.checkedAt).toLocaleString() : '尚未检查'}{'\n'}工具（{connection.tools.length}）：{connection.tools.map(tool => tool.name).join('、') || '无'}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {button(`检查 MCP：${connection.name}`, () => mutate({ action: 'check', connectionID: connection.id }))}
                {button(`编辑 MCP：${connection.name}`, () => { setForm(true); setEditing(connection.id); setName(connection.name); setRaw(JSON.stringify(connection.config, null, 2)); setToken(''); setClearToken(false); setStoredToken(Boolean(connection.tokenConfigured)); })}
                {button(`${connection.enabled ? '停用' : '启用'} MCP：${connection.name}`, () => mutate({ action: 'enable', connectionID: connection.id, enabled: !connection.enabled }))}
                {button(`删除 MCP：${connection.name}`, () => mutate({ action: 'delete', connectionID: connection.id }))}
            </View>
            {dots.map(dot => { const selected = dot.connectionIDs.includes(connection.id); return <Pressable key={dot.id} accessibilityRole="checkbox"
                accessibilityLabel={`为 ${dot.name} 启用 MCP ${connection.name}`} accessibilityState={{ checked: selected, disabled: busy }}
                aria-checked={selected} disabled={busy} onPress={() => mutate({ action: 'bind', dotId: dot.id,
                    connectionIDs: selected ? dot.connectionIDs.filter(id => id !== connection.id) : [...dot.connectionIDs, connection.id] })} style={{ padding: 12, minHeight: 44 }}>
                <Text style={text}>{selected ? '☑' : '☐'} {dot.name}</Text>
            </Pressable>; })}
        </View>)}
        {!!view && !view.connections.length && <Text style={muted}>尚未配置 MCP 服务。</Text>}
        <Text style={muted}>变更在下一轮对话生效；已运行的调用使用启动时配置。检查只获取工具目录，不调用业务工具。</Text>
    </View>;
}
