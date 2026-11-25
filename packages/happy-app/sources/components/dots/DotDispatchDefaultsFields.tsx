import * as React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { NativeOptionsPicker, type NativeOptionsPickerOption } from '@/components/NativeOptionsPicker';
import { PickerSheet, PickerSheetOption } from '@/components/PickerSheet';
import type { TestloopDot } from '@/sync/testloopDots';
import type { useDotDispatchOptions } from './useDotDispatchOptions';

type DispatchDefaults = NonNullable<TestloopDot['dispatchDefaults']>;
type Choice = NativeOptionsPickerOption;
type Options = ReturnType<typeof useDotDispatchOptions>;
const toChoices = (values: string[]): Choice[] => [...new Set(values)].map(key => ({ key, label: key }));
const systemDefault = (value?: string) => value ? `系统默认 · ${value}` : '系统默认';

function optionState(value: string | undefined, options: Choice[], fallback: string, verified: boolean) {
    if (value === undefined) return { label: fallback, invalid: false };
    const found = options.some(option => option.key === value);
    return { label: verified && !found ? `已失效 · ${value}` : value, invalid: verified && !found };
}

function ChoiceValue({ label, disabled = false, invalid = false }: { label: string; disabled?: boolean; invalid?: boolean }) {
    const { theme } = useUnistyles();
    const color = invalid ? theme.colors.textDestructive : (disabled ? theme.colors.textSecondary : theme.colors.text);
    return <View style={styles.value}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color }}>{label}</Text>
        <Ionicons name="chevron-down" color={color} size={16} />
    </View>;
}

function DispatchPicker({ title, value, label, choices, disabled, invalid, onSelect }: {
    title: string; value: string; label: string; choices: Choice[]; disabled: boolean; invalid?: boolean; onSelect: (value: string) => void;
}) {
    const trigger = <ChoiceValue label={label} disabled={disabled} invalid={invalid} />;
    if (disabled) return trigger;
    const options = choices.some(choice => choice.key === value) ? choices : [{ key: value, label, disabled: true }, ...choices];
    return <NativeOptionsPicker title={title} triggerLabel={label} selectedKey={value} sections={[{ key: title, options }]}
        onSelect={selected => { if (choices.some(choice => choice.key === selected)) onSelect(selected); }}>
        {trigger}
    </NativeOptionsPicker>;
}

export function DotDispatchDefaultsFields({ value, onChange, options, disabled }: {
    value: DispatchDefaults | null; onChange: (value: DispatchDefaults | null) => void; options: Options; disabled: boolean;
}) {
    const { theme } = useUnistyles();
    const [modelOpen, setModelOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const { catalog, targets, connection, loading, failed, selectTarget, retry } = options;
    const agent = catalog?.agents.find(option => option.agent === (value?.agent ?? catalog.defaultAgent));
    const agentChoices = toChoices(catalog?.agents.map(option => option.agent) ?? []);
    const models = toChoices(agent?.models ?? []);
    const efforts = toChoices(agent?.efforts ?? []);
    const agentState = optionState(value?.agent, agentChoices, systemDefault(catalog?.defaultAgent), !!catalog);
    const modelDefault = systemDefault(agent?.defaultModel);
    const effortDefault = agent && !efforts.length && !agent.defaultEffort ? '无可选推理强度' : systemDefault(agent?.defaultEffort);
    const modelState = optionState(value?.model, models, modelDefault, !!agent);
    const effortState = optionState(value?.effort, efforts, effortDefault, !!agent);
    const chooseAgent = (id: string) => onChange(id ? { ...value, agent: id } : null);
    const chooseModel = (id?: string) => { if (value) onChange({ ...value, model: id }); };
    const chooseEffort = (id?: string) => { if (value) onChange({ ...value, effort: id }); };
    const changeModel = !!(value && agent && (models.length || value.model)) && !disabled;
    const filtered = models.filter(option => option.label.toLowerCase().includes(search.trim().toLowerCase()));
    const text = { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 20 };
    const field = [styles.field, { borderColor: theme.colors.divider }];
    const closeModel = () => { setModelOpen(false); setSearch(''); };
    const reset = () => { closeModel(); onChange(null); };

    return <View style={{ gap: 10 }}>
        <Text accessibilityRole="header" style={{ color: theme.colors.text, fontSize: 18, fontWeight: '600' }}>派活默认值</Text>
        <Text style={text}>按目标读取选项，默认值用于此 Dot 的新任务。交办消息首行可用 /dispatch 单次覆盖。</Text>
        <Text style={text}>目标连接与机器</Text>
        <View style={field}>
            <DispatchPicker title="派活目标" value={connection?.connectionID ?? ''}
                label={connection ? `${connection.name} · ${connection.machineID}` : '选择授权目标'}
                choices={targets?.map(item => ({ key: item.connectionID, label: `${item.name} · ${item.machineID}` })) ?? []}
                disabled={disabled || !targets?.length} onSelect={selectTarget} />
        </View>
        {loading && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <ActivityIndicator size="small" /><Text accessibilityLiveRegion="polite" style={text}>正在读取派活选项…</Text>
        </View>}
        {failed && <Text accessibilityRole="alert" style={text}>无法读取派活选项，已保存的默认值仍可查看或清除。</Text>}
        {targets?.length === 0 && <Text style={text}>没有可读取派活选项的授权目标。请在「连接与授权」为此 Dot 绑定项目。</Text>}
        {catalog?.agents.length === 0 && <Text style={text}>此目标没有授权执行器。</Text>}
        {!loading && <Pressable accessibilityRole="button" disabled={disabled} onPress={retry} style={styles.link}>
            <Text style={{ color: theme.colors.textLink }}>{failed ? '重试读取派活选项' : '刷新派活选项'}</Text>
        </Pressable>}
        <Text style={text}>执行器</Text>
        <View style={field}>
            <DispatchPicker title="派活执行器" value={value?.agent ?? ''} {...agentState}
                choices={[{ key: '', label: systemDefault(catalog?.defaultAgent) }, ...agentChoices]}
                disabled={disabled || !agentChoices.length} onSelect={chooseAgent} />
        </View>
        <Text style={text}>模型</Text>
        <Pressable style={field} accessibilityRole="button" accessibilityLabel="派活模型" accessibilityValue={{ text: modelState.label }}
            accessibilityState={{ expanded: modelOpen, disabled: !changeModel }} disabled={!changeModel}
            onPress={() => setModelOpen(true)}>
            <ChoiceValue {...modelState} disabled={!changeModel} />
        </Pressable>
        {modelOpen && changeModel && <PickerSheet title="选择派活模型" visible avoidKeyboard onClose={closeModel}>
            <TextInput accessibilityLabel="搜索派活模型" placeholder="搜索模型" placeholderTextColor={theme.colors.textSecondary}
                value={search} onChangeText={setSearch} autoCorrect={false} autoCapitalize="none"
                style={[styles.search, { borderColor: theme.colors.divider, color: theme.colors.text }]} />
            <PickerSheetOption label={modelDefault} selected={value?.model === undefined}
                onPress={() => { chooseModel(); closeModel(); }} />
            {filtered.map(option => <PickerSheetOption key={option.key} label={option.label} selected={option.key === value?.model}
                onPress={() => { chooseModel(option.key); closeModel(); }} />)}
            {search.trim() && !filtered.length ? <Text style={[text, styles.empty]}>没有匹配的模型</Text> : null}
        </PickerSheet>}
        <Text style={text}>推理强度</Text>
        <View style={field}>
            <DispatchPicker title="派活推理强度" value={value?.effort ?? ''} {...effortState}
                choices={[{ key: '', label: effortDefault }, ...efforts]} onSelect={id => chooseEffort(id || undefined)}
                disabled={disabled || !value || !agent || (!efforts.length && !value.effort)} />
        </View>
        {!value && agentChoices.length > 0 && <Text style={text}>选择执行器后，可单独覆盖模型或推理强度。</Text>}
        {(agentState.invalid || modelState.invalid || effortState.invalid) && <Text accessibilityRole="alert" style={text}>
            有覆盖值在当前目标或执行器上不可用。请重选或清除后保存派活设置。
        </Text>}
        {value && <Pressable accessibilityRole="button" accessibilityLabel="恢复派活默认值" disabled={disabled} onPress={reset} style={styles.link}>
            <Text style={{ color: theme.colors.textLink }}>恢复系统默认</Text>
        </Pressable>}
    </View>;
}

const styles = StyleSheet.create({
    field: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minWidth: 0 },
    value: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
    link: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
    search: { minHeight: 44, borderWidth: 1, borderRadius: 10, marginHorizontal: 24, marginVertical: 8, paddingHorizontal: 12 },
    empty: { paddingHorizontal: 24, paddingVertical: 12 },
});
