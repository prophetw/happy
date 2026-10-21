import * as React from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ProjectSearchOption } from '@/sync/recentProjects';
import { searchDirectoryOptions } from '@/utils/directorySearch';

/** A project choice carries its computer with it; query text never enters the session draft. */
export function WebProjectSearch({ options, onSelect, onFocus }: {
    options: readonly ProjectSearchOption[];
    onSelect: (option: ProjectSearchOption) => void;
    onFocus?: () => void;
}) {
    const { theme } = useUnistyles();
    const [query, setQuery] = React.useState('');
    const [expanded, setExpanded] = React.useState(false);
    const [highlighted, setHighlighted] = React.useState(0);
    const list = React.useRef<ScrollView>(null);
    const results = React.useMemo(() => searchDirectoryOptions(options, query), [options, query]);
    const visible = query.trim() ? results : results.slice(0, 6);
    const choose = (option: ProjectSearchOption) => {
        setQuery('');
        setExpanded(false);
        onSelect(option);
    };

    return (
        <View
            style={[styles.container, expanded && styles.expanded]}
            testID="web-project-search"
            onBlur={(event) => {
                // Input blur can precede Pressable's delayed press-in. Keep the list while
                // focus moves to a result; close it only when focus leaves the whole picker.
                const focus = event as unknown as React.FocusEvent<HTMLElement>;
                if (!focus.currentTarget.contains(focus.relatedTarget)) setExpanded(false);
            }}
        >
            <View style={styles.inputRow}>
                <Ionicons name="search" size={17} color={theme.colors.textSecondary} />
                <TextInput
                    autoFocus
                    style={styles.input}
                    value={query}
                    placeholder={t('machineLauncher.searchDirectories')}
                    placeholderTextColor={theme.colors.textSecondary}
                    accessibilityRole="combobox"
                    accessibilityState={{ expanded }}
                    accessibilityLabel={`${t('machineLauncher.searchDirectories')} · ${t('machineLauncher.allMachines')}`}
                    onFocus={() => { setExpanded(true); onFocus?.(); }}
                    onChangeText={(value) => { setQuery(value); setHighlighted(0); setExpanded(true); }}
                    onKeyPress={(event) => {
                        if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
                        const key = event.nativeEvent.key;
                        if (key === 'Escape') { setExpanded(false); event.preventDefault(); }
                        if (key === 'ArrowDown' || key === 'ArrowUp') {
                            event.preventDefault();
                            setExpanded(true);
                            const next = Math.max(0, Math.min(visible.length - 1, highlighted + (key === 'ArrowDown' ? 1 : -1)));
                            setHighlighted(next);
                            list.current?.scrollTo({ y: Math.max(0, next * 72 - 180), animated: false });
                        }
                        if (key === 'Enter' && expanded && visible[highlighted]) {
                            event.preventDefault();
                            choose(visible[highlighted]);
                        }
                    }}
                />
                <Text style={styles.scope}>{t('machineLauncher.allMachines')}</Text>
            </View>
            {expanded && (
                <View style={styles.dropdown}>
                    <Text style={styles.heading}>{t('machineLauncher.recentDirectories')}</Text>
                    <ScrollView ref={list} style={styles.results} keyboardShouldPersistTaps="handled">
                        {visible.length === 0 && <Text style={styles.empty}>{t('machineLauncher.noMatchingDirectories')}</Text>}
                        {visible.map((option, index) => (
                            <Pressable
                                key={option.key}
                                accessibilityRole="button"
                                accessibilityLabel={`${option.name}, ${option.machineName}, ${option.path ?? ''}`}
                                testID="project-search-result"
                                onPress={() => choose(option)}
                                onHoverIn={() => setHighlighted(index)}
                                accessibilityState={{ selected: highlighted === index }}
                                style={({ pressed }) => [styles.result, (pressed || highlighted === index) && styles.highlighted]}
                            >
                                <View style={styles.resultTitle}>
                                    <Ionicons name="folder-outline" size={16} color={theme.colors.textSecondary} />
                                    <Text style={styles.name} numberOfLines={1}>{option.name}</Text>
                                    <Text style={[styles.machine, !option.online && styles.offline]} numberOfLines={1}>
                                        {option.machineName} · {t(option.online ? 'status.online' : 'status.offline')}
                                    </Text>
                                </View>
                                {option.path && <Text style={styles.path} numberOfLines={1}>{option.path}</Text>}
                            </Pressable>
                        ))}
                    </ScrollView>
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { position: 'relative', marginBottom: 12, zIndex: 20 },
    expanded: { zIndex: 1001 },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, borderRadius: 14, backgroundColor: theme.colors.surface },
    input: { flex: 1, minWidth: 0, height: 48, color: theme.colors.text, fontSize: 14, ...Typography.default() },
    scope: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    dropdown: { position: 'absolute', top: 54, left: 0, right: 0, borderRadius: 14, paddingVertical: 8, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.divider, boxShadow: '0px 8px 24px rgba(0,0,0,0.18)' },
    heading: { paddingHorizontal: 16, paddingVertical: 8, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    results: { maxHeight: 360 },
    result: { paddingHorizontal: 16, paddingVertical: 12, minHeight: 64 },
    highlighted: { backgroundColor: theme.colors.surfacePressed },
    resultTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { flex: 1, color: theme.colors.text, fontSize: 14, ...Typography.default('semiBold') },
    machine: { maxWidth: '50%', color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    offline: { opacity: 0.55 },
    path: { marginTop: 5, marginLeft: 24, color: theme.colors.textSecondary, fontSize: 12, ...Typography.default() },
    empty: { padding: 16, color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() },
}));
