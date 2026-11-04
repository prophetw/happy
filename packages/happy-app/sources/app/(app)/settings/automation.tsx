import * as React from 'react';
import { View, Text, TextInput, Pressable, Platform, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView } from 'expo-camera';
import { useAuth } from '@/auth/AuthContext';
import { automationApprovalApi, automationConnectionQR, consentProjects, parseAutomationQR, type AutomationConsent } from '@/auth/automationApproval';
import { getServerUrl } from '@/sync/serverConfig';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { QRCode } from '@/components/qr';
import { Typography } from '@/constants/Typography';
import { useScanQrCode } from '@/hooks/useScanQrCode';
import { useCheckScannerPermissions } from '@/hooks/useCheckCameraPermissions';
import { ServiceTokenDelivery } from '@/components/automation/ServiceAccess';

const methodLabels: Record<string, string> = {
    'machines.list': '查看授权机器', 'sessions.list': '列出授权会话', 'tasks.create': '创建专用任务',
    'requests.get': '查询操作回执', 'sessions.send': '追加任务指令', 'sessions.status': '查看任务状态',
    'sessions.logs': '读取增量日志', 'sessions.result': '读取任务结果', 'sessions.cancel': '请求停止任务',
    'options.list': '发现可选启动项',
};
const stateLabels: Record<string, string> = { pending: '待你确认', approved: '已授权', expired: '已过期', revoked: '已撤销' };
const errorLabels: Record<string, string> = {
    OWNER_AUTH_REQUIRED: '请先登录 Happy，再审查这项助手连接。',
    PROJECT_SCOPE_APPROVAL_UPGRADE_REQUIRED: '请刷新并使用支持多项目范围的新版批准页面，完整核对所有项目。',
    GRANT_EXPIRED: '连接申请已过期，请让助手刷新申请后重新打开链接。',
    GRANT_NOT_FOUND: '未找到这项连接，请检查链接或让助手重新申请。',
    AUTOMATION_UPGRADE_REQUIRED: '控制组件版本不兼容，请更新后重试。',
};
function displayState(consent: AutomationConsent, now: number) {
    if (consent.state === 'revoked') return 'revoked';
    if (consent.expiresAt <= now || (consent.state === 'pending' && consent.pendingUntil <= now)) return 'expired';
    return consent.state;
}
function friendlyError(error: unknown) {
    const code = error instanceof Error ? error.message : '';
    return errorLabels[code] ?? '暂时无法读取或更新连接，请检查网络后重试。';
}
function formatTime(value: number) { return new Date(value).toLocaleString(); }
function screenFont(weight: 'regular' | 'semiBold' = 'regular') {
    const font = Typography.default(weight);
    return Platform.OS === 'web' ? { fontFamily: `"${font.fontFamily}", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` } : font;
}

function Action({ label, onPress, disabled = false, primary = false, destructive = false }: {
    label: string; onPress: () => void; disabled?: boolean; primary?: boolean; destructive?: boolean;
}) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
        style={({ pressed }) => [styles.button, primary ? styles.primaryButton : styles.secondaryButton, (disabled || pressed) && styles.dimmed]}>
        <Text style={[styles.buttonText, primary ? styles.primaryButtonText : styles.text, destructive && styles.destructive]}>{label}</Text>
    </Pressable>;
}
function Detail({ label, value }: { label: string; value: string }) {
    return <View style={styles.detail}><Text style={styles.label}>{label}</Text><Text selectable style={styles.value}>{value}</Text></View>;
}

/** Dedicated consent UI. Account login and explicit automation approval remain separate. */
export default function AutomationConnections() {
    const auth = useAuth(), params = useLocalSearchParams<{ connection?: string }>(), router = useRouter();
    const { theme } = useUnistyles();
    const [id, setID] = React.useState(params.connection ?? ''), [consent, setConsent] = React.useState<AutomationConsent | null>(null);
    const [connections, setConnections] = React.useState<AutomationConsent[]>([]), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
    const [unknownMutation, setUnknownMutation] = React.useState(false);
    const [listError, setListError] = React.useState(''), [details, setDetails] = React.useState(false), [showQR, setShowQR] = React.useState(false), [now, setNow] = React.useState(Date.now);
    const operation = React.useRef(0), listOperation = React.useRef(0);
    const permissions = useCheckScannerPermissions();
    const signedIn = !!auth.credentials?.token;
    const api = React.useMemo(() => automationApprovalApi(getServerUrl(), () => {
        if (!auth.credentials?.token) throw new Error('OWNER_AUTH_REQUIRED');
        return `Bearer ${auth.credentials.token}`;
    }), [auth.credentials?.token]);
    React.useLayoutEffect(() => {
        setConsent(null); setConnections([]); setDetails(false); setShowQR(false); setUnknownMutation(false); setBusy(false);
        return () => { operation.current++; listOperation.current++; };
    }, [api]);
    const load = React.useCallback(async (connectionID: string) => {
        const version = ++operation.current, current = () => operation.current === version;
        setBusy(true); setError(''); setConsent(null); setUnknownMutation(false); setDetails(false); setShowQR(false);
        try {
            await api.compatibility(); if (!current()) return;
            const next = await api.consent(connectionID.trim());
            if (current()) { setConsent(next); setID(connectionID.trim()); setNow(Date.now()); }
        } catch (e) { if (current()) setError(friendlyError(e)); }
        finally { if (current()) setBusy(false); }
    }, [api]);
    const refresh = React.useCallback(async () => {
        const version = ++listOperation.current;
        setListError('');
        if (!signedIn) { setConnections([]); return; }
        try {
            await api.compatibility(); if (version !== listOperation.current) return;
            const next = await api.list(); if (version === listOperation.current) setConnections(next);
        } catch (e) { if (version === listOperation.current) setListError(friendlyError(e)); }
    }, [api, signedIn]);
    React.useEffect(() => { void refresh(); if (params.connection) void load(params.connection); }, [refresh, load, params.connection]);
    React.useEffect(() => {
        if (!consent || !['pending', 'approved'].includes(consent.state)) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [consent]);
    const scan = useScanQrCode({ urlPrefix: 'happy:///automation?', onScan: async value => {
        try { await load(parseAutomationQR(value)); return true; } catch { setError('无效的助手连接二维码'); return false; }
    }, scanWithCamera: async () => { if (await permissions()) await CameraView.launchScanner({ barcodeTypes: ['qr'] }); } });
    React.useEffect(() => {
        if (Platform.OS === 'web' || !CameraView.isModernBarcodeScannerAvailable) return;
        const listener = CameraView.onModernBarcodeScanned(event => {
            if (!event.data.startsWith('happy:///automation?')) return;
            void CameraView.dismissScanner().catch(() => {});
            try { void load(parseAutomationQR(event.data)); } catch { setError('无效的助手连接二维码'); }
        });
        return () => listener.remove();
    }, [load]);
    const mutate = async (approve: boolean) => {
        if (!consent || busy || (approve && (unknownMutation || displayState(consent, Date.now()) !== 'pending'))) return;
        const version = ++operation.current, current = () => operation.current === version;
        setBusy(true); setError('');
        try {
            if (approve) await api.approve(consent); else await api.revoke(consent.id);
            if (!current()) return;
            const next = await api.consent(consent.id); if (!current()) return;
            setConsent(next); setUnknownMutation(false); setNow(Date.now()); await refresh();
        } catch {
            if (!current()) return;
            // A lost response does not prove approval/revocation failed. Never retry the mutation.
            setUnknownMutation(true);
            try {
                const observed = await api.consent(consent.id);
                if (!current()) return;
                setConsent(observed); setNow(Date.now());
                if (observed.state === (approve ? 'approved' : 'revoked')) { setUnknownMutation(false); await refresh(); }
            } catch { /* Keep the uncertain result visible until an explicit read succeeds. */ }
        }
        finally { if (current()) setBusy(false); }
    };
    const state = consent ? displayState(consent, now) : '';
    return <>
        <Stack.Screen options={{ title: '助手连接' }} />
        <ItemList containerStyle={styles.page}>
            <ItemGroup>
                <View style={styles.card}>
                    <View style={styles.heading}>
                        <View style={styles.icon}><Ionicons name="shield-checkmark-outline" size={25} color={theme.colors.text} /></View>
                        <View style={styles.grow}><Text style={styles.eyebrow}>独立助手授权</Text><Text accessibilityRole="header" style={styles.title}>由你决定助手能做什么</Text></View>
                    </View>
                    <Text style={styles.description}>先核对机器、项目和操作范围，再批准连接。登录 Happy 不会自动授予助手权限。</Text>
                    {!signedIn && <View style={styles.notice}>
                        <Text style={styles.noticeTitle}>先登录你的 Happy 账号</Text>
                        <Text style={styles.description}>登录后重新打开助手发来的批准链接。账号密钥不会交给云端助手。</Text>
                        <Action label="前往 Happy 登录" onPress={() => router.push('/')} />
                    </View>}
                    {signedIn && <Action label="为后端创建服务授权" onPress={() => router.push('/settings/automation-service')} />}
                    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
                    {busy && <ActivityIndicator accessibilityLabel="正在读取连接" color={theme.colors.textSecondary} />}
                    {consent && <>
                        <View style={styles.divider} />
                        <View style={styles.identityRow}>
                            <View style={styles.grow}><Text style={styles.label}>{consent.credentialMode === 'service-token-v1' ? '申请授权的服务' : '申请连接的助手'}</Text><Text selectable style={styles.assistant}>{consent.clientName}</Text></View>
                            <View style={[styles.badge, !unknownMutation && state === 'approved' && styles.approvedBadge]}><Text style={styles.badgeText}>{unknownMutation ? '结果待核实' : stateLabels[state] ?? '状态未知'}</Text></View>
                        </View>
                        {consent.credentialMode === 'service-token-v1' && <View style={styles.notice}><Text style={styles.noticeTitle}>服务令牌授权</Text><Text style={styles.description}>批准后可一次性交付专用令牌。持有者可在以下范围内调用 REST；不需要 Happy 账号密钥。</Text></View>}
                        {unknownMutation && <View accessibilityRole="alert" style={styles.notice}>
                            <Text style={styles.noticeTitle}>操作结果尚未确认</Text><Text style={styles.description}>请求可能已经生效。请重新读取连接状态，不要重复批准；如需终止访问，可以明确撤销。</Text>
                            <Action label="重新核实连接状态" disabled={busy} onPress={() => void load(consent.id)} />
                        </View>}
                        {state === 'expired' && <View accessibilityRole="alert" style={styles.notice}>
                            <Text style={styles.noticeTitle}>这项连接已过期</Text><Text style={styles.description}>旧申请不能继续批准。请让助手刷新连接，再打开新的批准链接。</Text>
                        </View>}
                        {state === 'revoked' && <Text style={styles.description}>这项连接的访问权限已撤销。如需继续使用，请让助手重新申请。</Text>}
                        <Text accessibilityRole="header" style={styles.sectionTitle}>授权范围</Text>
                        <View style={styles.scope}>
                            <Detail label="运行机器 / Worker" value={consent.workerName} />
                            {consentProjects(consent).map((project, index) => <View key={project.id}>
                                <Detail label={consent.scopeVersion !== undefined ? `项目 ${index + 1}` : '项目'} value={project.id} />
                                <Detail label={consent.scopeVersion !== undefined ? `工作目录 ${index + 1}` : '工作目录'} value={project.directory} />
                            </View>)}
                            <Detail label="可访问的会话" value={consent.sessionIDs.length ? `本连接新建的专用会话，以及以下既有会话：${consent.sessionIDs.join(', ')}` : '仅本连接新建的专用会话；不含任何既有会话'} />
                            {!!consent.options?.agents.length && <Detail label="允许的启动选项（默认启动始终可用）" value={consent.options.agents.map(a =>
                                `${a.agent}：模型 [${a.models.length ? a.models.join(', ') : '仅默认'}]；权限模式 [${a.permissionModes.length ? a.permissionModes.join(', ') : '仅默认'}]`).join('\n')} />}
                            <Detail label="授权到期" value={formatTime(consent.expiresAt)} />
                            {state === 'pending' && <Detail label="请在此时间前确认" value={formatTime(consent.pendingUntil)} />}
                        </View>
                        <Text accessibilityRole="header" style={styles.sectionTitle}>允许的操作 · {consent.methods.length} 项</Text>
                        <View style={styles.methods}>{consent.methods.map(method => <View key={method} style={styles.method}>
                            <Text style={styles.methodLabel}>{methodLabels[method] ?? method}</Text><Text selectable style={styles.methodCode}>{method}</Text>
                        </View>)}</View>
                        <View style={styles.notice}><Text style={styles.noticeTitle}>数据与撤销说明</Text><Text style={styles.description}>{consent.disclosure}</Text></View>
                        <Pressable accessibilityRole="button" accessibilityLabel={details ? '收起身份与安全详情' : '查看身份与安全详情'} accessibilityState={{ expanded: details }} onPress={() => setDetails(!details)} style={styles.disclosure}>
                            <Text style={styles.link}>{details ? '收起' : '查看'}身份与安全详情</Text><Ionicons name={details ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                        {details && <View style={styles.scope}>
                            <Detail label="Happy 账号 ID" value={consent.userID} /><Detail label="助手 ID" value={consent.clientID} />
                            <Detail label={consent.credentialMode === 'service-token-v1' ? '服务身份指纹' : '助手公钥指纹'} value={consent.clientFingerprint} /><Detail label="Worker ID" value={consent.workerID} />
                            <Detail label="Worker 公钥指纹" value={consent.workerFingerprint} /><Detail label="机器 ID" value={consent.machineID} />
                            <Detail label="连接 ID" value={consent.id} />
                            {consent.externalIdentity && <><Detail label="授权服务器" value={consent.externalIdentity.issuer} /><Detail label="助手身份 / 租户" value={`${consent.externalIdentity.subject} / ${consent.externalIdentity.tenant}`} /><Detail label="OAuth 客户端" value={consent.externalIdentity.oauthClientID} /></>}
                        </View>}
                        {!unknownMutation && state === 'pending' && <>
                            <Action primary label="确认批准以上权限" disabled={busy} onPress={() => void mutate(true)} />
                            <Action destructive label="拒绝连接" disabled={busy} onPress={() => void mutate(false)} />
                            <Pressable accessibilityRole="button" accessibilityLabel={showQR ? '收起连接二维码' : '显示连接二维码'} accessibilityState={{ expanded: showQR }} onPress={() => setShowQR(!showQR)} style={styles.disclosure}><Text style={styles.link}>{showQR ? '收起' : '显示'}连接二维码</Text></Pressable>
                            {showQR && <View style={styles.qr}><QRCode data={automationConnectionQR(consent.id)} size={160} /><Text style={styles.caption}>仅适用于支持助手连接的新版 Happy；当前网页可直接审查并批准。</Text></View>}
                        </>}
                        {(state === 'approved' || unknownMutation) && <Action destructive label="撤销连接" disabled={busy} onPress={() => void mutate(false)} />}
                        {state === 'approved' && !unknownMutation && consent.credentialMode === 'service-token-v1' && <ServiceTokenDelivery key={consent.id} consent={consent} api={api} disabled={busy} />}
                    </>}
                </View>
            </ItemGroup>
            <ItemGroup title="打开其他连接">
                <View style={styles.card}>
                    <TextInput accessibilityLabel="助手连接 ID" placeholder="粘贴助手提供的连接 ID" placeholderTextColor={theme.colors.input.placeholder} value={id} onChangeText={setID} autoCapitalize="none" autoCorrect={false} editable={!busy} style={styles.input} />
                    <Action label="审查连接" disabled={busy || !id.trim() || !signedIn} onPress={() => void load(id)} />
                    {Platform.OS !== 'web' && <Action label="扫描助手连接二维码" disabled={busy} onPress={scan.scanQrCode} />}
                </View>
            </ItemGroup>
            <ItemGroup title="连接记录">
                {connections.length === 0 && <View style={styles.card}><Text style={styles.description}>{signedIn ? '暂无连接记录。助手发起申请后，可从批准链接打开。' : '登录后可查看你申请和批准过的连接。'}</Text></View>}
                {connections.map(c => <Item key={c.id} disabled={busy} title={c.clientName} subtitle={`${c.scopeVersion !== undefined ? (c.projectIDs ?? []).join('、') : c.projectID} · ${stateLabels[displayState(c, now)] ?? '状态未知'}`} onPress={() => void load(c.id)} />)}
                {!!listError && <View style={styles.card}><Text accessibilityRole="alert" style={styles.error}>{listError}</Text></View>}
            </ItemGroup>
        </ItemList>
    </>;
}

const styles = StyleSheet.create(theme => ({
    page: { paddingTop: 8, paddingBottom: 40 }, card: { padding: 24, gap: 18 }, text: { color: theme.colors.text },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    icon: { width: 52, height: 52, borderRadius: 16, backgroundColor: theme.colors.surfaceHigh, alignItems: 'center', justifyContent: 'center' },
    grow: { flex: 1, minWidth: 0 },
    eyebrow: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 12, marginBottom: 4 },
    title: { ...screenFont('semiBold'), color: theme.colors.text, fontSize: 22, lineHeight: 30 },
    description: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 14, lineHeight: 23 },
    identityRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    assistant: { ...screenFont('semiBold'), color: theme.colors.text, fontSize: 19, lineHeight: 28 },
    badge: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surfaceHighest, flexShrink: 0 },
    approvedBadge: { borderWidth: 1, borderColor: theme.colors.success },
    badgeText: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 12 },
    divider: { height: 1, backgroundColor: theme.colors.divider },
    sectionTitle: { ...screenFont('semiBold'), color: theme.colors.text, fontSize: 15, marginTop: 2 },
    scope: { gap: 16, backgroundColor: theme.colors.surfaceHigh, borderRadius: 12, padding: 16 },
    detail: { gap: 4, minWidth: 0 }, label: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    value: { ...screenFont(), color: theme.colors.text, fontSize: 14, lineHeight: 22, flexShrink: 1, ...Platform.select({ web: { wordBreak: 'break-all' as const } }) },
    methods: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    method: { flexGrow: 1, flexBasis: 140, minWidth: 0, padding: 12, gap: 4, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.divider },
    methodLabel: { ...screenFont('semiBold'), color: theme.colors.text, fontSize: 13 },
    methodCode: { ...Typography.mono(), color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17 },
    notice: { backgroundColor: theme.colors.surfaceHigh, padding: 16, borderRadius: 12, gap: 8 },
    noticeTitle: { ...screenFont('semiBold'), color: theme.colors.text, fontSize: 14 },
    error: { ...screenFont(), color: theme.colors.textDestructive, fontSize: 14, lineHeight: 22 },
    button: { minHeight: 46, paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
    primaryButton: { backgroundColor: theme.colors.button.primary.background }, secondaryButton: { borderWidth: 1, borderColor: theme.colors.divider },
    buttonText: { ...screenFont('semiBold'), fontSize: 14, lineHeight: 21 }, primaryButtonText: { color: theme.colors.button.primary.tint },
    destructive: { color: theme.colors.textDestructive }, dimmed: { opacity: 0.5 },
    disclosure: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
    link: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 13 },
    input: { ...screenFont(), minHeight: 46, color: theme.colors.text, backgroundColor: theme.colors.input.background, borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 14 },
    qr: { alignItems: 'center', gap: 12 }, caption: { ...screenFont(), color: theme.colors.textSecondary, fontSize: 12, lineHeight: 19, textAlign: 'center' },
}));
