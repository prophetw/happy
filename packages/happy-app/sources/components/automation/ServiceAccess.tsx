import * as React from 'react';
import { AppState, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect } from 'expo-router';
import { automationApprovalApi, type AutomationConsent, type ServiceConnectionOptions } from '@/auth/automationApproval';

import { DirectoryPicker } from '@/components/DirectoryPicker';

type API = ReturnType<typeof automationApprovalApi>;
const day = 24 * 3600000;
const labels: Record<string, string> = { 'machines.list': '查看机器', 'sessions.list': '列出会话', 'tasks.create': '创建任务', 'requests.get': '查询回执', 'sessions.send': '追加指令', 'sessions.status': '查看状态', 'sessions.logs': '读取日志', 'sessions.result': '读取结果', 'sessions.cancel': '取消任务', 'options.list': '发现启动选项' };
const readOnly = (methods: string[]) => methods.filter(m => !['tasks.create', 'sessions.send', 'sessions.cancel'].includes(m));
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.button, disabled && { opacity: 0.5 }]}><Text style={styles.text}>{label}</Text></Pressable>;
}

/** Secret exists only in this mounted component; never in persistence, URLs, logs or navigation. */
export function ServiceTokenDelivery({ consent, api, disabled = false }: { consent: AutomationConsent; api: API; disabled?: boolean }) {
    const [token, setToken] = React.useState<string | null>(null), [shown, setShown] = React.useState(false), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState('');
    const attempted = React.useRef(false), generation = React.useRef(0), foreground = React.useRef(AppState.currentState === 'active'), focused = React.useRef(false), secret = React.useRef<string | null>(null);
    const clearPrivate = React.useCallback(() => {
        generation.current++; secret.current = null; setToken(null); setShown(false); setBusy(false);
        if (attempted.current) setMessage('令牌已隐藏或交付中断，无法再次找回。需要更换时请撤销并重新创建授权。');
    }, []);
    React.useLayoutEffect(() => {
        clearPrivate(); foreground.current = AppState.currentState === 'active';
        const listener = AppState.addEventListener('change', state => {
            foreground.current = state === 'active';
            if (!foreground.current) clearPrivate();
        });
        return () => { clearPrivate(); listener.remove(); };
    }, [api, consent.id, clearPrivate]);
    useFocusEffect(React.useCallback(() => {
        focused.current = true;
        return () => { focused.current = false; clearPrivate(); };
    }, [api, consent.id, clearPrivate]));
    const issue = async () => {
        if (attempted.current || disabled || !focused.current || !foreground.current) return;
        attempted.current = true; const version = generation.current; setBusy(true); setMessage('');
        try {
            const issued = await api.issueServiceToken(consent.id);
            if (version === generation.current && foreground.current && focused.current) { secret.current = issued.token; setToken(issued.token); setMessage('令牌仅在本页临时显示。请安全交付给这个服务的后端；离开页面后无法找回。'); }
        } catch {
            if (version === generation.current) setMessage('交付结果未确认，或令牌已经交付。不会自动补发；请撤销此连接后重新创建并批准。');
        } finally { if (version === generation.current) setBusy(false); }
    };
    if (consent.credentialMode !== 'service-token-v1' || consent.state !== 'approved') return null;
    return <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>服务访问令牌</Text>
        <Text style={styles.secondary}>持有令牌的后端可在已批准范围内调用 REST。到期或撤销后失效；撤销不会自动停止已运行任务。</Text>
        {!token && !attempted.current && !consent.serviceToken?.issued && <Button label="生成服务访问令牌（仅交付一次）" disabled={disabled || busy} onPress={() => void issue()} />}
        {!token && consent.serviceToken?.issued && <Text style={styles.secondary}>令牌已交付，无法再次查看。需要更换时，请撤销后重新创建授权。</Text>}
        {!!message && <Text accessibilityRole="alert" style={styles.secondary}>{message}</Text>}
        {token && <>
            <TextInput accessibilityLabel="一次性服务访问令牌" value={token} editable={false} secureTextEntry={!shown} autoComplete="off" textContentType="none" selectTextOnFocus style={styles.input} />
            <Button label={shown ? '隐藏服务令牌' : '显示服务令牌'} onPress={() => { if (focused.current && foreground.current && secret.current === token) setShown(!shown); }} />
            <Button label="复制服务令牌" onPress={() => { if (!focused.current || !foreground.current || secret.current !== token) return; const version = generation.current; void Clipboard.setStringAsync(token).then(() => { if (version === generation.current) setMessage('已复制。请通过安全渠道交付，不要粘贴到聊天、URL 或日志。'); }).catch(() => { if (version === generation.current) setMessage('复制未完成，请使用本页显示功能安全取用。'); }); }} />
        </>}
    </View>;
}

/** Uses only operator-registered service identities and worker scopes; existing sessions default denied. */
export function ServiceConnectionForm({ api, onCreated }: { api: API; onCreated: (id: string) => void }) {
    const [options, setOptions] = React.useState<ServiceConnectionOptions | null>(null), [clientID, setClient] = React.useState(''), [workerID, setWorker] = React.useState(''), [projectIDs, setProjects] = React.useState<string[]>([]);
    const [methods, setMethods] = React.useState<string[]>([]), [days, setDays] = React.useState('30'), [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [submitted, setSubmitted] = React.useState(false);
    const generation = React.useRef(0), attempted = React.useRef(false), selectionVersion = React.useRef(0);
    const [customDirectories, setCustomDirectories] = React.useState<string[]>([]), [customPath, setCustomPath] = React.useState('');
    const [verified, setVerified] = React.useState<{ selectionID: string; projects: { id: string; directory: string }[]; expiresAt: number } | null>(null);
    const [checking, setChecking] = React.useState(false), [clock, setClock] = React.useState(Date.now());
    const invalidateSelection = () => { selectionVersion.current++; setVerified(null); setChecking(false); };
    React.useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
    React.useEffect(() => {
        const version = ++generation.current;
        setOptions(null); setError(''); setCustomDirectories([]); setCustomPath(''); invalidateSelection();
        void api.serviceOptions().then(value => {
            if (version !== generation.current) return;
            setOptions(value); setClient(value.clients[0]?.id ?? ''); setWorker(value.workers[0]?.id ?? ''); setProjects(value.workers[0]?.projects[0] ? [value.workers[0].projects[0].id] : []);
            setMethods(readOnly(value.workers[0]?.methods ?? [])); setDays(String(Math.min(30, value.maxGrantMs / day)));
        }).catch(() => { if (version === generation.current) setError('服务令牌功能未启用、身份未登录或暂不可用。请联系操作方登记服务及允许的 worker 范围。'); });
        return () => { generation.current++; };
    }, [api]);
    const worker = options?.workers.find(w => w.id === workerID);
    const multipleSupported = options?.projectScopes === 1 && worker?.projectScopes === 1;
    const directorySupported = options?.directoryScopes === 1 && worker?.directoryScopes === 1 && !!worker.directorySelection?.roots.length;
    const maxProjects = multipleSupported ? Math.min(options?.maxProjects ?? 32, 32) : 1;
    const duration = Math.floor(Number(days) * day);
    const pickedPaths = [...(worker?.projects.filter(p => projectIDs.includes(p.id)).map(p => p.directory) ?? []), ...customDirectories];
    const selectionReady = customDirectories.length === 0 || (!!directorySupported && !!verified && verified.expiresAt > clock);
    const valid = selectionReady && !!options && !!clientID && !!worker && pickedPaths.length > 0 && pickedPaths.length <= maxProjects
        && projectIDs.every(id => worker.projects.some(p => p.id === id)) && methods.length > 0 && Number.isFinite(duration) && duration >= 1000 && duration <= options.maxGrantMs;
    const create = async () => {
        if (!valid || !worker || !options || attempted.current) return;
        attempted.current = true; const version = generation.current; setSubmitted(true); setBusy(true); setError('');
        try {
            const next = await api.createService({ clientID, workerID, machineID: worker.machineID,
                ...(customDirectories.length && verified ? { scopeVersion: 3 as const, projectIDs: verified.projects.map(p => p.id), projects: verified.projects, selectionID: verified.selectionID } : projectIDs.length === 1 ? { projectID: projectIDs[0] } : { scopeVersion: 2 as const, projectIDs: [...projectIDs].sort() }), methods, sessionIDs: [], expiresInMs: duration });
            if (version === generation.current) onCreated(next.id);
        } catch (error) {
            if (version === generation.current) setError(error instanceof Error && error.message === 'SCOPE_DENIED'
                ? '创建申请被拒绝，未创建授权。请返回后重新检查项目、操作范围和有效时长。'
                : error instanceof Error && error.message === 'DIRECTORY_SELECTION_MISMATCH'
                    ? '目录核实已失效或与所选范围不一致，未创建授权。请返回后重新核实目录。'
                    : '创建结果未确认。请返回连接记录核实，不要重复创建；尚未批准的申请不会获得执行权限。');
        }
        finally { if (version === generation.current) setBusy(false); }
    };
    const addDirectory = (path: string) => {
        if (submitted || !directorySupported || !worker) return;
        const clean = path.trim();
        if (worker.directorySelection!.roots.includes(clean) || !worker.directorySelection!.roots.some(root => clean.startsWith(root + '/'))) { setError('请选择允许根目录内的具体项目目录。'); return; }
        if (!clean.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(clean) || clean.split('/').some(part => part === '.' || part === '..') || clean.endsWith('/')) { setError('请输入规范的绝对目录。'); return; }
        const known = worker.projects.find(p => p.directory === clean);
        if (known) setProjects(ids => ids.includes(known.id) ? ids : [...ids, known.id]);
        else setCustomDirectories(paths => paths.includes(clean) ? paths : [...paths, clean]);
        invalidateSelection(); setCustomPath(''); setError('');
    };
    const verifyDirectories = async () => {
        if (!worker || !directorySupported || submitted || checking || !pickedPaths.length || pickedPaths.length > maxProjects) return;
        const version = ++selectionVersion.current, identity = generation.current;
        setChecking(true); setVerified(null); setError('');
        try {
            const value = await api.resolveDirectories({ clientID, workerID, machineID: worker.machineID, directories: pickedPaths });
            if (version === selectionVersion.current && identity === generation.current) { setVerified(value); setClock(Date.now()); }
        } catch { if (version === selectionVersion.current && identity === generation.current) setError('目录核实失败：请确认 worker 在线、目录存在且位于允许范围内。未创建授权，可重新核实。'); }
        finally { if (version === selectionVersion.current && identity === generation.current) setChecking(false); }
    };
    return <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>为后端创建服务授权</Text>
        <Text style={styles.secondary}>先选择范围，再单独批准；批准后才可一次性生成令牌。每个后端使用独立服务身份。</Text>
        <Text style={styles.secondary}>项目范围限制任务入口和会话访问，不是操作系统文件沙箱；代理继续使用现有权限确认机制。</Text>
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {options && <>
            <Text style={styles.title}>服务身份</Text>
            {options.clients.map(c => <Choice key={c.id} label={c.name} selected={clientID === c.id} disabled={submitted} onPress={() => { setClient(c.id); invalidateSelection(); }} />)}
            <Text style={styles.title}>机器 / Worker</Text>
            {options.workers.map(w => <Choice key={w.id} label={`${w.name} · ${w.machineID}`} selected={workerID === w.id} disabled={submitted} onPress={() => { invalidateSelection(); setCustomDirectories([]); setCustomPath(''); setWorker(w.id); setProjects(w.projects[0] ? [w.projects[0].id] : []); setMethods(readOnly(w.methods)); }} />)}
            <Text style={styles.title}>项目目录（可多选）</Text>
            <Text style={styles.secondary}>已选 {pickedPaths.length} 个项目。同一令牌仅可访问勾选的目录；创建每个任务时仍需明确指定项目。</Text>
            {worker?.projects.map(p => <Choice key={p.id} label={`${p.id} · ${p.directory}`} selected={projectIDs.includes(p.id)} disabled={submitted} onPress={() => { invalidateSelection(); setProjects(ids => ids.includes(p.id) ? ids.filter(id => id !== p.id) : [...ids, p.id]); }} />)}
            {directorySupported && worker && <View style={styles.section}>
                <Text style={styles.title}>添加机器上的目录</Text>
                <Text style={styles.secondary}>可选根目录：{worker.directorySelection!.roots.join('、')}。只授权选中的具体目录，不会自动包含以后新增的项目。</Text>
                {!submitted && <DirectoryPicker key={worker.id} machineId={worker.machineID} machineKey={worker.id} machineName={worker.name} homeDir={worker.directorySelection!.roots[0]} initialPath={worker.directorySelection!.roots[0]} recentPaths={[]} onSelectDirectory={addDirectory} onSelectRecent={addDirectory} onRequestCustomPath={() => setError('可在下方输入机器上的绝对目录。')} />}
                <TextInput accessibilityLabel="要添加的项目绝对目录" value={customPath} onChangeText={setCustomPath} editable={!submitted} autoCapitalize="none" autoCorrect={false} style={styles.input} />
                <Button label="添加目录到本次选择" disabled={submitted || !customPath.trim()} onPress={() => addDirectory(customPath)} />
                {customDirectories.map(path => <Choice key={path} label={`移除已选目录 · ${path}`} selected disabled={submitted} onPress={() => { invalidateSelection(); setCustomDirectories(paths => paths.filter(p => p !== path)); }} />)}
                {!!customDirectories.length && <>
                    <Button label={checking ? '正在核实目录' : '让 Worker 核实所选目录'} disabled={submitted || checking || pickedPaths.length > maxProjects} onPress={() => void verifyDirectories()} />
                    {verified && verified.expiresAt > clock && <Text accessibilityRole="alert" style={styles.secondary}>目录已核实；批准页将展示以下真实路径：{verified.projects.map(p => p.directory).join('、')}。请在两分钟内创建申请，最终仍须单独批准。</Text>}
                    {verified && verified.expiresAt <= clock && <Text accessibilityRole="alert" style={styles.error}>目录核实已过期，请重新核实。</Text>}
                </>}
            </View>}
            {!multipleSupported && (worker?.projects.length ?? 0) > 1 && <Text accessibilityRole="alert" style={styles.secondary}>当前服务或在线 Worker 尚未报告多项目能力，请先只选一个项目；多选需要更新并连通受信 Worker。</Text>}
            {pickedPaths.length > maxProjects && <Text accessibilityRole="alert" style={styles.error}>当前最多可选 {maxProjects} 个项目。</Text>}
            <Text style={styles.title}>允许的操作</Text>
            <Text style={styles.secondary}>以下操作对所有勾选的项目生效，默认只读。派发任务需额外选择创建和追加指令；停止任务需选择取消。</Text>
            {worker?.methods.map(m => <Choice key={m} label={`${labels[m] ?? m} · ${m}`} selected={methods.includes(m)} disabled={submitted} onPress={() => setMethods(list => list.includes(m) ? list.filter(v => v !== m) : [...list, m])} />)}
            <Text style={styles.title}>有效时长（天）</Text>
            <TextInput accessibilityLabel="服务授权有效天数" value={days} onChangeText={setDays} keyboardType="decimal-pad" editable={!submitted} style={styles.input} />
            <Text style={styles.secondary}>本部署上限 {options.maxGrantMs / day} 天；从申请时计算，不会因生成令牌而延期。仅本授权新建的专用会话，不含既有会话。</Text>
            <Button label="创建申请并审查权限" disabled={!valid || busy || submitted} onPress={() => void create()} />
        </>}
    </View>;
}
function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} aria-checked={selected} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.selected]}><Text style={styles.text}>{selected ? '✓  ' : '○  '}{label}</Text></Pressable>;
}
const styles = StyleSheet.create(theme => ({
    section: { gap: 16, padding: 20 }, title: { color: theme.colors.text, fontSize: 16, fontWeight: '600', lineHeight: 24 },
    text: { color: theme.colors.text, fontSize: 14, lineHeight: 22 }, secondary: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 22 },
    error: { color: theme.colors.textDestructive, lineHeight: 22 }, button: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 10, padding: 14, alignItems: 'center', minHeight: 46 },
    choice: { borderWidth: 1, borderColor: theme.colors.divider, padding: 12, borderRadius: 10 }, selected: { backgroundColor: theme.colors.surfaceHigh },
    input: { color: theme.colors.text, backgroundColor: theme.colors.surfaceHigh, borderWidth: 1, borderColor: theme.colors.divider, padding: 12, borderRadius: 10 },
}));
