import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import type { DotMemoryHint, DotMemoryRecallItem, DotMemoryTarget } from '@/utils/dotMemoryTool';

/**
 * Small in-conversation card for the hosted Dot memory tools. Running, failed
 * and unreadable replies each say exactly what happened; a write is only called
 * saved when the host returned `ok` with the matching status.
 */
export const DotMemoryToolHint = React.memo(function DotMemoryToolHint({ hint, onOpen }: {
    hint: DotMemoryHint;
    onOpen?: (target: DotMemoryTarget) => void;
}) {
    // Recall details stay collapsed until the user asks for them.
    const styles = useMemoryHintStyles();
    const [expanded, setExpanded] = React.useState(false);
    const ready = hint.kind === 'recall' && hint.status === 'ready';
    const title = hintTitle(hint);
    const testID = hint.kind === 'recall' ? 'dot-memory-recall-hint'
        : hint.kind === 'propose' ? 'dot-memory-propose-hint' : 'dot-memory-write-hint';
    const target = hint.kind === 'write' ? hint.target : null;
    return <View testID={testID} style={styles.container}>
        <Text style={styles.title}>{title}</Text>
        {ready && hint.count > 0 && <>
            <Pressable accessibilityRole="button" accessibilityLabel={expanded ? t('dots.memoryHint.collapse') : t('dots.memoryHint.expand')}
                onPress={() => setExpanded(value => !value)} style={styles.toggle}>
                <Text style={styles.toggleText}>{expanded ? t('dots.memoryHint.collapse') : t('dots.memoryHint.expand')}</Text>
            </Pressable>
            {expanded && <View style={styles.items}>
                {hint.memories.map((item, index) => <RecallItem key={`${item.keyDigest ?? item.key}:${index}`} item={item} onOpen={onOpen} />)}
            </View>}
        </>}
        {target && onOpen && <Pressable accessibilityRole="button" accessibilityLabel={t('dots.memoryHint.viewMemory')}
            onPress={() => onOpen(target)} style={styles.toggle}>
            <Text style={styles.toggleText}>{t('dots.memoryHint.viewMemory')}</Text>
        </Pressable>}
    </View>;
});

const RecallItem = React.memo(function RecallItem({ item, onOpen }: {
    item: DotMemoryRecallItem;
    onOpen?: (target: DotMemoryTarget) => void;
}) {
    const styles = useMemoryHintStyles();
    const scope = item.scope === 'dot' ? t('dots.memoryHint.scopeDot') : item.scope === 'user' ? t('dots.memoryHint.scopeUser') : null;
    const meta = [item.source !== null ? t('dots.memoryHint.sourceValue', { source: item.source }) : null,
        scope !== null ? t('dots.memoryHint.scopeValue', { scope }) : null].filter(Boolean).join(' · ');
    const body = <>
        <Text style={styles.itemTitle} numberOfLines={1}>{item.key}</Text>
        {item.valueSummary !== null && <Text style={styles.itemValue} numberOfLines={2}>{item.valueSummary}</Text>}
        {meta.length > 0 && <Text style={styles.itemMeta}>{meta}</Text>}
    </>;
    if (!item.target || !onOpen) return <View style={styles.item}>{body}</View>;
    const target = item.target;
    return <Pressable accessibilityRole="button" accessibilityLabel={t('dots.memoryHint.viewRecallItem', { key: item.key })}
        onPress={() => onOpen(target)} style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}>
        {body}
    </Pressable>;
});

function hintTitle(hint: DotMemoryHint): string {
    if (hint.kind === 'recall') {
        if (hint.status === 'running') return t('dots.memoryHint.recallRunning');
        if (hint.status === 'failed') return t('dots.memoryHint.recallFailed');
        if (hint.status === 'unreadable') return t('dots.memoryHint.recallUnreadable');
        return hint.count > 0 ? t('dots.memoryHint.recallFound', { count: hint.count }) : t('dots.memoryHint.recallEmpty');
    }
    if (hint.kind === 'propose') {
        if (hint.status === 'running') return t('dots.memoryHint.proposeRunning');
        if (hint.status === 'failed') return t('dots.memoryHint.proposeFailed');
        if (hint.status === 'unreadable') return t('dots.memoryHint.proposeUnreadable');
        return hint.status === 'proposed' ? t('dots.memoryHint.proposePending') : t('dots.memoryHint.proposeReturned');
    }
    if (hint.tool === 'dot_memory_confirm') {
        if (hint.status === 'running') return t('dots.memoryHint.confirmRunning');
        if (hint.status === 'failed') return t('dots.memoryHint.confirmFailed');
        if (hint.status === 'unreadable') return t('dots.memoryHint.confirmUnreadable');
    } else {
        if (hint.status === 'running') return t('dots.memoryHint.writeRunning');
        if (hint.status === 'failed') return t('dots.memoryHint.writeFailed');
        if (hint.status === 'unreadable') return t('dots.memoryHint.writeUnreadable');
    }
    if (hint.status === 'saved') return t('dots.memoryHint.writeSaved');
    if (hint.status === 'forgotten') return t('dots.memoryHint.writeForgotten');
    return t('dots.memoryHint.writePending');
}

function useMemoryHintStyles() {
    const { theme } = useUnistyles();
    const colors = theme.colors;
    return React.useMemo(() => ({
        container: {
            marginHorizontal: 16,
            marginVertical: 6,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 10,
            backgroundColor: colors.surfaceHigh,
            gap: 6,
        },
        title: {
            color: colors.text,
            fontSize: 13,
            lineHeight: 19,
        },
        toggle: {
            alignSelf: 'flex-start' as const,
            minHeight: 28,
            justifyContent: 'center' as const,
            paddingVertical: 2,
        },
        toggleText: {
            color: colors.textSecondary,
            fontSize: 12,
            lineHeight: 18,
        },
        items: {
            gap: 2,
        },
        item: {
            paddingVertical: 6,
            gap: 2,
        },
        itemPressed: {
            opacity: 0.7,
        },
        itemTitle: {
            color: colors.text,
            fontSize: 13,
            lineHeight: 19,
            fontWeight: '500' as const,
        },
        itemValue: {
            color: colors.text,
            fontSize: 12,
            lineHeight: 18,
        },
        itemMeta: {
            color: colors.textSecondary,
            fontSize: 11,
            lineHeight: 16,
        },
    }), [colors]);
}