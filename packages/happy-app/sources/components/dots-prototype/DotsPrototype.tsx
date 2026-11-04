/**
 * THROWAWAY: compare three Dots home layouts at /dots?prototype=1&variant=A.
 * A = assistants + attention; B = compact directory; C = work-first agenda.
 * All mutations are fixture-only. Reuse Happy's shell, typography, theme and icons.
 */
import * as React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/StyledText';
import { prototypeReducer, seedState, workLabels, type Dot, type Memory, type PrototypeState, type Work, type WorkStatus } from './model';

type Variant = 'A' | 'B' | 'C';
type Tab = 'chat' | 'work' | 'memory';
const variants: Variant[] = ['A', 'B', 'C'];
const variantNames = { A: '助理与待办', B: '紧凑目录', C: '工作优先' };
type HomeProps = { state: PrototypeState; openDot: (id: string) => void; openWork: (work: Work) => void; create: () => void; compact: boolean };

function useStyles() {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    return React.useMemo(() => {
        const accent = theme.dark ? '#b5a2ff' : '#6650b7';
        return { colors, accent, styles: StyleSheet.create({
            root: { flex: 1, backgroundColor: colors.surface, minHeight: 0 },
            page: { padding: 28, gap: 26, width: '100%', maxWidth: 1140, alignSelf: 'center', paddingBottom: 36 },
            row: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
            between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
            title: { color: colors.text, fontSize: 30, fontWeight: '600', letterSpacing: -0.6 },
            heading: { color: colors.text, fontSize: 18, fontWeight: '600' },
            body: { color: colors.text, fontSize: 14, lineHeight: 23 },
            muted: { color: colors.textSecondary, fontSize: 13, lineHeight: 21 },
            eyebrow: { color: accent, fontSize: 11, fontWeight: '600', letterSpacing: 2 },
            card: { borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.surface, borderRadius: 18, padding: 22, gap: 14 },
            inset: { padding: 18, borderRadius: 14, backgroundColor: colors.surfaceHigh, gap: 10 },
            divider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
            avatar: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
            badge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, backgroundColor: colors.surfaceHigh },
            input: { color: colors.text, borderColor: colors.divider, borderWidth: 1, borderRadius: 12, padding: 14, fontSize: 14, minHeight: 48, backgroundColor: colors.surface },
            button: { minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
            tabs: { flexDirection: 'row', gap: 6, padding: 5, borderRadius: 12, backgroundColor: colors.surfaceHigh },
            panel: { flex: 1, minHeight: 0 },
            backdrop: { flex: 1, padding: 16, backgroundColor: '#00000066', alignItems: 'center', justifyContent: 'center' },
            sheet: { width: '100%', maxWidth: 620, maxHeight: '92%', borderRadius: 22, backgroundColor: colors.surface, overflow: 'hidden' },
            sheetHeader: { padding: 22, borderBottomWidth: 1, borderBottomColor: colors.divider, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
        }) };
    }, [colors, theme.dark]);
}

function Button({ label, onPress, primary = false, icon, disabled = false, style }: {
    label: string; onPress: () => void; primary?: boolean; icon?: React.ComponentProps<typeof Ionicons>['name']; disabled?: boolean; style?: StyleProp<ViewStyle>;
}) {
    const { styles: s, colors, accent } = useStyles();
    const foreground = primary ? '#ffffff' : colors.text;
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
        style={({ pressed }) => [s.button, { backgroundColor: primary ? '#6650b7' : pressed ? colors.surfacePressed : colors.surfaceHigh, opacity: disabled ? 0.4 : pressed ? 0.8 : 1 }, style]}>
        {icon && <Ionicons name={icon} size={16} color={primary ? foreground : accent} />}
        <Text style={{ color: foreground, fontSize: 13, fontWeight: '600' }}>{label}</Text>
    </Pressable>;
}

function Avatar({ dot, small = false }: { dot: Dot; small?: boolean }) {
    const { styles: s } = useStyles();
    return <View style={[s.avatar, { backgroundColor: dot.color }, small && { width: 34, height: 34, borderRadius: 11 }]}>
        <Text style={{ color: '#fff', fontSize: small ? 14 : 18, fontWeight: '600' }}>{dot.mark}</Text>
    </View>;
}

function Status({ status }: { status: WorkStatus }) {
    const { styles: s, colors } = useStyles();
    const { theme } = useUnistyles();
    const color = status === 'review' || status === 'proposed' ? (theme.dark ? '#efc57a' : '#946415')
        : status === 'accepted' ? (theme.dark ? '#7ad0a0' : '#26714b') : colors.textSecondary;
    return <View style={s.badge}><Text style={{ color, fontSize: 11, fontWeight: '600' }}>{workLabels[status]}</Text></View>;
}

function WorkRow({ work, onPress, dotName }: { work: Work; onPress: () => void; dotName?: string }) {
    const { styles: s, colors } = useStyles();
    return <Pressable accessibilityRole="button" accessibilityLabel={`查看工作项：${work.title}`} onPress={onPress}
        style={({ pressed }) => [s.row, { flexWrap: 'nowrap', paddingVertical: 15, opacity: pressed ? 0.65 : 1 }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text style={[s.body, { fontWeight: '600' }]}>{work.title}</Text>
            <Text style={s.muted}>{dotName ? `${dotName} · ` : ''}{work.project}</Text>
        </View>
        <Status status={work.status} />
        <Ionicons name="chevron-forward" size={15} color={colors.textSecondary} />
    </Pressable>;
}

function HomeHeader({ create }: Pick<HomeProps, 'create'>) {
    const { styles: s } = useStyles();
    return <View style={s.between}><View style={{ gap: 7 }}>
        <Text style={s.eyebrow}>YOUR PERSONAL TEAM</Text>
        <Text accessibilityRole="header" style={s.title}>Dots</Text>
        <Text style={s.muted}>把事情交给熟悉你的助理，随时回来看看进展。</Text>
    </View><Button label="新建 Dot" primary icon="add" onPress={create} /></View>;
}

function Attention({ state, openWork }: Pick<HomeProps, 'state' | 'openWork'>) {
    const { styles: s, accent } = useStyles();
    const items = state.works.filter(work => work.status === 'review' || work.status === 'proposed');
    if (!items.length) return null;
    return <View style={[s.inset, { borderLeftWidth: 3, borderLeftColor: accent }]}>
        <View style={s.between}><Text style={s.heading}>需要你处理</Text><Text style={s.muted}>{items.length} 件</Text></View>
        {items.map(work => <WorkRow key={work.id} work={work} dotName={state.dots.find(dot => dot.id === work.dotId)?.name} onPress={() => openWork(work)} />)}
    </View>;
}

// A: attention strip, then a grid of standing assistants. Default agreed design.
export function VariantA({ state, openDot, openWork, create, compact }: HomeProps) {
    const { styles: s, colors } = useStyles();
    return <View style={{ gap: 28 }}><HomeHeader create={create} /><Attention state={state} openWork={openWork} />
        <View style={{ gap: 16 }}><Text accessibilityRole="header" style={s.heading}>我的 Dots <Text style={s.muted}>/ {state.dots.length}</Text></Text>
            <View style={[s.row, { alignItems: 'stretch', gap: 16 }]}>{state.dots.map(dot => {
                const work = state.works.filter(item => item.dotId === dot.id);
                const attention = work.filter(item => item.status === 'review' || item.status === 'proposed').length;
                return <Pressable key={dot.id} accessibilityRole="button" accessibilityLabel={`进入 ${dot.name}`} onPress={() => openDot(dot.id)}
                    style={({ pressed }) => [s.card, { width: compact ? '100%' : '47%', flexGrow: 1, opacity: pressed ? 0.7 : 1 }]}>
                    <View style={s.between}><Avatar dot={dot} /><Text style={[s.muted, attention > 0 && { color: dot.color }]}>{attention ? `${attention} 件待处理` : work.some(item => item.status === 'running') ? '有工作在执行' : '暂无待处理事项'}</Text></View>
                    <Text style={s.heading}>{dot.name}</Text><Text style={[s.muted, { minHeight: 42 }]}>{dot.instruction}</Text>
                    <View style={[s.between, { paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.divider }]}>
                        <Text style={s.muted}>{work.find(item => item.status === 'review') ? '收到执行结果，等待验收' : `${work.length} 个工作项`}</Text>
                        <Ionicons name="arrow-forward" size={18} color={dot.color} />
                    </View>
                </Pressable>;
            })}</View>
        </View>
    </View>;
}

// B: dense directory with an adjacent decision queue; no card grid.
export function VariantB({ state, openDot, openWork, create, compact }: HomeProps) {
    const { styles: s, colors } = useStyles();
    return <View style={{ gap: 30 }}><HomeHeader create={create} />
        <View style={{ flexDirection: compact ? 'column' : 'row', gap: 30, alignItems: 'flex-start' }}>
            <View style={{ flex: 1, width: '100%', gap: 12 }}><Text style={s.heading}>助理目录</Text>
                {state.dots.map(dot => <Pressable key={dot.id} accessibilityRole="button" accessibilityLabel={`进入 ${dot.name}`} onPress={() => openDot(dot.id)}
                    style={({ pressed }) => [s.row, s.divider, { flexWrap: 'nowrap', paddingVertical: 22, opacity: pressed ? 0.65 : 1 }]}>
                    <Avatar dot={dot} /><View style={{ flex: 1, gap: 5 }}><Text style={s.heading}>{dot.name}</Text><Text style={s.muted}>{dot.instruction}</Text></View>
                    <Ionicons name="chevron-forward" size={17} color={colors.textSecondary} />
                </Pressable>)}
            </View>
            <View style={{ width: compact ? '100%' : 280 }}><Attention state={state} openWork={openWork} /></View>
        </View>
    </View>;
}

// C: work grouped by next action, followed by a small assistant strip.
export function VariantC({ state, openDot, openWork, create }: HomeProps) {
    const { styles: s } = useStyles();
    const groups: { label: string; statuses: WorkStatus[] }[] = [
        { label: '等你决定', statuses: ['review', 'proposed'] }, { label: '正在推进', statuses: ['running'] }, { label: '已结束', statuses: ['accepted', 'canceled'] },
    ];
    return <View style={{ gap: 28 }}><HomeHeader create={create} />
        {groups.map(group => {
            const items = state.works.filter(item => group.statuses.includes(item.status));
            return items.length ? <View key={group.label} style={{ gap: 6 }}>
                <Text style={s.eyebrow}>{group.label} / {items.length}</Text>
                {items.map(work => <View key={work.id} style={s.divider}><WorkRow work={work} dotName={state.dots.find(dot => dot.id === work.dotId)?.name} onPress={() => openWork(work)} /></View>)}
            </View> : null;
        })}
        <View style={[s.inset, { gap: 16 }]}><Text style={s.heading}>找一位助理聊聊</Text>
            <View style={s.row}>{state.dots.map(dot => <Pressable key={dot.id} accessibilityRole="button" accessibilityLabel={`进入 ${dot.name}`} onPress={() => openDot(dot.id)} style={s.row}>
                <Avatar dot={dot} small /><Text style={s.body}>{dot.name}</Text>
            </Pressable>)}</View>
        </View>
    </View>;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
    const { styles: s } = useStyles();
    return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <KeyboardAvoidingView style={s.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View accessibilityViewIsModal style={s.sheet}>
                <View style={s.sheetHeader}><Text accessibilityRole="header" style={[s.heading, { flex: 1 }]}>{title}</Text><Button label="关闭" icon="close" onPress={onClose} /></View>
                <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 22, gap: 18 }}>{children}</ScrollView>
            </View>
        </KeyboardAvoidingView>
    </Modal>;
}

function CreateDot({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, instruction: string) => void }) {
    const { styles: s, colors } = useStyles();
    const [name, setName] = React.useState('');
    const [instruction, setInstruction] = React.useState('');
    return <Sheet title="创建你的 Dot" onClose={onClose}>
        <Text style={s.muted}>给它一个名字和清晰的长期职责。之后可以在专属对话里持续交办。</Text>
        <Text style={s.body}>名称</Text><TextInput autoFocus accessibilityLabel="Dot 名称" placeholder="例如：产品助理" placeholderTextColor={colors.textSecondary} maxLength={80} value={name} onChangeText={setName} style={s.input} />
        <Text style={s.body}>长期职责</Text><TextInput accessibilityLabel="Dot 长期职责" placeholder="希望它持续帮你推进什么？" placeholderTextColor={colors.textSecondary} maxLength={2000} multiline value={instruction} onChangeText={setInstruction} style={[s.input, { minHeight: 110, textAlignVertical: 'top' }]} />
        <Button label="创建并开始对话" primary disabled={!name.trim() || !instruction.trim()} onPress={() => onCreate(name.trim(), instruction.trim())} />
        <Text style={s.muted}>原型演示：只创建临时示例 Dot，刷新后恢复。</Text>
    </Sheet>;
}

function MemoryEditor({ memory, dotId, onClose, dispatch }: { memory: Memory | null; dotId: string; onClose: () => void; dispatch: React.Dispatch<Parameters<typeof prototypeReducer>[1]> }) {
    const { styles: s, colors } = useStyles();
    const [text, setText] = React.useState(memory?.text ?? '');
    const [deleting, setDeleting] = React.useState(false);
    return <Sheet title={deleting ? '确认删除这条记忆？' : memory ? '编辑记忆' : '添加记忆'} onClose={onClose}>
        {deleting ? <><Text style={s.body}>{memory?.text}</Text><Button label="确认删除示例记忆" onPress={() => { if (memory) dispatch({ type: 'forget', id: memory.id }); onClose(); }} /></>
            : <><Text style={s.muted}>仅属于当前 Dot，不影响其他助理。</Text><TextInput autoFocus accessibilityLabel="记忆内容" value={text} onChangeText={setText} placeholder="希望这个 Dot 长期记住什么？" placeholderTextColor={colors.textSecondary} multiline style={[s.input, { minHeight: 120 }]} />
                <Button label="确认保存记忆" primary disabled={!text.trim()} onPress={() => { dispatch({ type: 'memory', dotId, id: memory?.id ?? `memory-${Date.now()}`, text: text.trim() }); onClose(); }} />
                {memory && <Button label="删除这条记忆" icon="trash-outline" onPress={() => setDeleting(true)} />}</>}
    </Sheet>;
}

export default function DotsPrototype({ topContentInset = 0 }: { topContentInset?: number }) {
    const params = useLocalSearchParams<{ variant?: string }>();
    const variant: Variant = variants.includes(params.variant as Variant) ? params.variant as Variant : 'A';
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { styles: s, colors, accent } = useStyles();
    const [state, dispatch] = React.useReducer(prototypeReducer, undefined, seedState);
    const [dotId, setDotId] = React.useState<string | null>(null);
    const [tab, setTab] = React.useState<Tab>('chat');
    const [sideTab, setSideTab] = React.useState<'work' | 'memory'>('work');
    const [panelVisible, setPanelVisible] = React.useState(true);
    const [width, setWidth] = React.useState(0);
    const [creating, setCreating] = React.useState(false);
    const [selectedWorkId, setSelectedWorkId] = React.useState<string | null>(null);
    const [executionVisible, setExecutionVisible] = React.useState(false);
    const [reviewChecks, setReviewChecks] = React.useState<string[]>([]);
    const [memoryEditor, setMemoryEditor] = React.useState<{ memory: Memory | null } | null>(null);
    const [drafts, setDrafts] = React.useState<Record<string, string>>({});
    const [inspect, setInspect] = React.useState(false);
    const [offline, setOffline] = React.useState(false);
    const chatRef = React.useRef<ScrollView>(null);
    const dot = state.dots.find(item => item.id === dotId);
    const selectedWork = state.works.find(item => item.id === selectedWorkId);
    const compact = width < 760;
    const wide = width >= 960;
    const openDot = (id: string) => { setDotId(id); setTab('chat'); setPanelVisible(true); };
    const openWork = (work: Work) => { setDotId(work.dotId); setSelectedWorkId(work.id); setExecutionVisible(false); setReviewChecks([]); };
    const draft = dot ? drafts[dot.id] ?? '' : '';
    const works = state.works.filter(work => work.dotId === dotId);
    const memories = state.memories.filter(memory => memory.dotId === dotId);
    const messages = state.messages.filter(message => message.dotId === dotId);
    const setVariant = React.useCallback((step: number) => {
        const next = variants[(variants.indexOf(variant) + step + variants.length) % variants.length];
        router.setParams({ variant: next });
    }, [router, variant]);
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        const listener = (event: KeyboardEvent) => {
            const target = event.target;
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
                || creating || selectedWorkId || memoryEditor
                || target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable],[role="textbox"]')) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setVariant(event.key === 'ArrowLeft' ? -1 : 1); }
        };
        window.addEventListener('keydown', listener);
        return () => window.removeEventListener('keydown', listener);
    }, [setVariant, creating, selectedWorkId, memoryEditor]);

    const workPanel = <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }}>
        <View style={{ gap: 8 }}><Text style={s.eyebrow}>长期职责</Text><Text style={s.body}>{dot?.instruction}</Text></View>
        <View style={{ gap: 4 }}><View style={s.between}><Text style={s.heading}>工作项</Text><Text style={s.muted}>{works.length}</Text></View>
            {works.length ? works.map(work => <View style={s.divider} key={work.id}><WorkRow work={work} onPress={() => openWork(work)} /></View>)
                : <Text style={[s.muted, { marginTop: 12 }]}>还没有工作项。先在对话里交办一件事。</Text>}
        </View>
        <Text style={s.muted}>执行会话保存具体工作过程；这里保留你和 Dot 的长期上下文。</Text>
    </ScrollView>;
    const memoryPanel = <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <View style={s.between}><Text style={s.heading}>这个 Dot 的记忆</Text><Button label="添加" icon="add" onPress={() => setMemoryEditor({ memory: null })} /></View>
        <Text style={s.muted}>明确保存的偏好和事实，仅用于当前助理。</Text>
        {memories.map(memory => <Pressable key={memory.id} accessibilityRole="button" accessibilityLabel={`编辑记忆：${memory.text}`} onPress={() => setMemoryEditor({ memory })} style={s.inset}>
            <Text style={s.body}>{memory.text}</Text><Text style={{ color: accent, fontSize: 12 }}>编辑 →</Text>
        </Pressable>)}
        {!memories.length && <Text style={s.muted}>暂未保存记忆。</Text>}
    </ScrollView>;
    const conversation = <KeyboardAvoidingView style={s.panel} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
        <ScrollView ref={chatRef} onContentSizeChange={() => chatRef.current?.scrollToEnd({ animated: false })} contentContainerStyle={{ padding: compact ? 18 : 32, gap: 25, flexGrow: 1 }}>
            <Text style={[s.muted, { textAlign: 'center', fontSize: 11 }]}>长期专属对话 · 示例内容</Text>
            {messages.map(message => <View key={message.id} style={{ alignItems: message.role === 'user' ? 'flex-end' : 'flex-start', gap: 8 }}>
                <Text style={s.muted}>{message.role === 'user' ? '你' : dot?.name}</Text>
                <View style={[message.role === 'user' ? s.inset : { gap: 12 }, { maxWidth: wide ? '88%' : '100%' }]}>
                    <Text selectable style={[s.body, { fontSize: 15, lineHeight: 26 }]}>{message.text}</Text>
                    {message.workId && (() => {
                        const work = state.works.find(item => item.id === message.workId);
                        return work ? <Pressable accessibilityRole="button" accessibilityLabel={`打开交办：${work.title}`} onPress={() => openWork(work)} style={[s.card, { padding: 15, marginTop: 8 }]}>
                            <View style={s.between}><Text style={s.body}>{work.title}</Text><Status status={work.status} /></View>
                            <Text style={{ color: accent, fontSize: 12 }}>查看范围与进展 →</Text>
                        </Pressable> : null;
                    })()}
                </View>
            </View>)}
        </ScrollView>
        <View style={{ padding: compact ? 16 : 24, paddingTop: 10, gap: 8, borderTopWidth: 1, borderTopColor: colors.divider }}>
            <View style={[s.input, { flexDirection: 'row', alignItems: 'flex-end', gap: 12 }]}>
                <TextInput accessibilityLabel="给 Dot 交办" placeholder="继续交办，或补充你的想法…" placeholderTextColor={colors.textSecondary} value={draft}
                    onChangeText={value => dot && setDrafts(previous => ({ ...previous, [dot.id]: value }))} multiline maxLength={2000}
                    style={{ flex: 1, minWidth: 0, minHeight: 32, maxHeight: 120, color: colors.text, fontSize: 14, paddingVertical: 5 }} />
                <Button label="发送" icon="arrow-up" primary disabled={!draft.trim() || offline} onPress={() => {
                    if (!dot || !draft.trim()) return;
                    dispatch({ type: 'send', id: `message-${Date.now()}`, dotId: dot.id, text: draft.trim() });
                    setDrafts(previous => ({ ...previous, [dot.id]: '' }));
                }} />
            </View><Text style={[s.muted, { fontSize: 11 }]}>演示回复为固定脚本 · 不调用模型 · 不消耗额度</Text>
        </View>
    </KeyboardAvoidingView>;

    return <View testID="dots-interactive-prototype" onLayout={event => setWidth(event.nativeEvent.layout.width)} style={[s.root, { paddingTop: topContentInset }]}>
        <View style={{ paddingHorizontal: compact ? 16 : 28, paddingVertical: 8, backgroundColor: colors.surfaceHigh }}>
            <Text style={[s.muted, { fontSize: 11 }]}>交互原型 / 全部为示例数据 / 刷新恢复初始状态</Text>
        </View>
        {offline && <View style={[s.inset, { borderRadius: 0 }]}><Text accessibilityRole="alert" style={s.body}>连接状态待确认 · 当前展示的是上次状态（示例），连接恢复后再提交操作。</Text></View>}
        {!dot ? <ScrollView contentContainerStyle={[s.page, compact && { padding: 18 }]}>
            {React.createElement(variant === 'B' ? VariantB : variant === 'C' ? VariantC : VariantA, { state, openDot, openWork, create: () => setCreating(true), compact })}
        </ScrollView> : <View style={s.panel}>
            <View style={{ padding: compact ? 16 : 24, gap: 16, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                <View style={s.between}><Button label="返回 Dots" icon="arrow-back" onPress={() => setDotId(null)} />
                    <Text style={s.muted}>{offline ? '状态待确认' : '空闲 · 示例'}</Text></View>
                <View style={[s.row, { flexWrap: 'nowrap' }]}><Avatar dot={dot} /><View style={{ flex: 1, gap: 4 }}><Text accessibilityRole="header" style={s.heading}>{dot.name}</Text><Text style={s.muted}>{dot.instruction}</Text></View>
                    {wide && <Button label={panelVisible ? '收起工作栏' : '展开工作栏'} icon="albums-outline" onPress={() => setPanelVisible(value => !value)} />}
                </View>
                {!wide && <View accessibilityRole="tablist" style={s.tabs}>{(['chat', 'work', 'memory'] as Tab[]).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: tab === item }} onPress={() => setTab(item)}
                    style={[s.button, { flex: 1, backgroundColor: tab === item ? colors.surface : 'transparent' }]}><Text style={s.body}>{{ chat: '对话', work: '工作', memory: '记忆' }[item]}</Text></Pressable>)}</View>}
            </View>
            <View style={[s.panel, { flexDirection: 'row' }]}>
                {wide || tab === 'chat' ? conversation : tab === 'work' ? workPanel : memoryPanel}
                {wide && panelVisible && <View style={{ width: 310, borderLeftWidth: 1, borderLeftColor: colors.divider }}>
                    <View style={[s.tabs, { margin: 14 }]}>{(['work', 'memory'] as const).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: sideTab === item }} onPress={() => setSideTab(item)} style={[s.button, { flex: 1, backgroundColor: sideTab === item ? colors.surface : 'transparent' }]}>
                        <Text style={s.body}>{item === 'work' ? '工作' : '记忆'}</Text></Pressable>)}</View>
                    {sideTab === 'work' ? workPanel : memoryPanel}
                </View>}
            </View>
        </View>}

        {creating && <CreateDot onClose={() => setCreating(false)} onCreate={(name, instruction) => {
            const id = `dot-${Date.now()}`; dispatch({ type: 'create', id, name, instruction }); setCreating(false); openDot(id);
        }} />}
        {selectedWork && <Sheet title={executionVisible ? '执行会话 · 示例' : selectedWork.title} onClose={() => { setSelectedWorkId(null); setExecutionVisible(false); }}>
            {executionVisible ? <>
                <Button label="返回原 Dot 的工作项" icon="arrow-back" onPress={() => setExecutionVisible(false)} />
                <Text style={s.eyebrow}>执行 Agent / 独立上下文</Text>
                <Text style={s.body}>收到委派：{selectedWork.scope}</Text>
                <View style={s.inset}><Text style={s.body}>执行记录和代码差异会显示在这里。本原型没有运行 Agent，也没有修改项目代码。</Text></View>
                <Text style={s.muted}>执行会话用于具体工作；目标、决策和验收结论仍保留在原 Dot。</Text>
            </> : <>
                <View style={s.between}><Text style={s.muted}>{state.dots.find(item => item.id === selectedWork.dotId)?.name} / {selectedWork.project}</Text><Status status={selectedWork.status} /></View>
                <Text style={s.heading}>范围</Text><Text style={s.body}>{selectedWork.scope}</Text>
                <Text style={s.heading}>验收条件</Text>{selectedWork.criteria.map((criterion, index) => <Text key={index} style={s.body}>· {criterion}</Text>)}
                {selectedWork.status === 'review' && <>
                    <View style={s.inset}><Text style={s.heading}>执行结束，尚未验收</Text><Text style={s.body}>示例摘要：执行方报告已交付候选结果。真实产品需要对应的产物、版本和验证证据。</Text></View>
                    <Text style={s.muted}>下面仅模拟验收交互。勾选示例条件后，体验结论如何回到 Dot 和首页。</Text>
                    {selectedWork.criteria.map(criterion => <Pressable key={criterion} accessibilityRole="checkbox" accessibilityLabel={`模拟核对：${criterion}`} accessibilityState={{ checked: reviewChecks.includes(criterion) }}
                        onPress={() => setReviewChecks(previous => previous.includes(criterion) ? previous.filter(item => item !== criterion) : [...previous, criterion])} style={s.row}>
                        <Ionicons name={reviewChecks.includes(criterion) ? 'checkbox' : 'square-outline'} color={accent} size={22} /><Text style={[s.body, { flex: 1 }]}>{criterion}</Text>
                    </Pressable>)}
                    <Button label="模拟验收通过" primary disabled={offline || reviewChecks.length !== selectedWork.criteria.length} onPress={() => dispatch({ type: 'work', workId: selectedWork.id, status: 'accepted' })} />
                    <Button label="模拟返工" disabled={offline} onPress={() => { dispatch({ type: 'work', workId: selectedWork.id, status: 'running' }); setReviewChecks([]); }} />
                </>}
                {selectedWork.status === 'proposed' && <><Text style={s.muted}>模拟确认只改变示例状态；正式版本仍需验证项目授权、有效提案和验收条件。</Text>
                    <Button label="模拟确认交办" primary disabled={offline} onPress={() => dispatch({ type: 'work', workId: selectedWork.id, status: 'running' })} />
                    <Button label="取消这次示例交办" disabled={offline} onPress={() => dispatch({ type: 'work', workId: selectedWork.id, status: 'canceled' })} /></>}
                {selectedWork.status === 'running' && <><Text style={s.muted}>执行中。可模拟结果返回，观察它进入待验收而非直接完成。</Text><Button label="模拟执行结束" primary disabled={offline} onPress={() => { dispatch({ type: 'work', workId: selectedWork.id, status: 'review' }); setReviewChecks([]); }} /></>}
                {selectedWork.status === 'accepted' && <Text style={s.body}>已记录模拟验收结论，首页待处理事项同步更新。真实验收未发生。</Text>}
                <Button label="查看示例执行会话" icon="open-outline" onPress={() => setExecutionVisible(true)} />
                <Button label="回到这个 Dot 的对话" icon="chatbubble-outline" onPress={() => { openDot(selectedWork.dotId); setSelectedWorkId(null); }} />
            </>}
        </Sheet>}
        {memoryEditor && dot && <MemoryEditor memory={memoryEditor.memory} dotId={dot.id} onClose={() => setMemoryEditor(null)} dispatch={dispatch} />}

        {inspect && <ScrollView style={{ maxHeight: 200, borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.surfaceHigh }} contentContainerStyle={{ padding: 16, gap: 10 }}>
            <View style={s.row}><Button label={offline ? '恢复示例连接' : '模拟断线'} onPress={() => setOffline(value => !value)} /><Button label="重置原型" onPress={() => {
                dispatch({ type: 'reset' }); setDotId(null); setTab('chat'); setSelectedWorkId(null); setMemoryEditor(null); setCreating(false); setDrafts({}); setOffline(false);
            }} /></View>
            <Text selectable style={[s.muted, { fontSize: 10 }]}>{JSON.stringify({ variant, dotId, tab, offline, ...state }, null, 2)}</Text>
        </ScrollView>}
        <View style={{ paddingBottom: Math.max(insets.bottom, 10), paddingTop: 9, alignItems: 'center', borderTopWidth: 1, borderTopColor: colors.divider }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: '#24212e' }}>
                <Pressable accessibilityRole="button" accessibilityLabel="上一个首页方案" onPress={() => setVariant(-1)} style={{ padding: 12 }}><Ionicons name="arrow-back" color="#fff" size={16} /></Pressable>
                <Text style={{ color: '#fff', fontSize: 12 }}>原型 {variant} · {variantNames[variant]}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="下一个首页方案" onPress={() => setVariant(1)} style={{ padding: 12 }}><Ionicons name="arrow-forward" color="#fff" size={16} /></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={inspect ? '隐藏原型状态' : '查看原型状态'} onPress={() => setInspect(value => !value)} style={{ padding: 12 }}><Ionicons name="options-outline" color="#bdb3d5" size={17} /></Pressable>
            </View>
        </View>
    </View>;
}
