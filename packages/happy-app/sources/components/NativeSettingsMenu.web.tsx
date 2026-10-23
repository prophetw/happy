import * as React from 'react';
import {
    Modal as RNModal,
    Platform,
    Pressable,
    ScrollView,
    Text,
    useWindowDimensions,
    View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { Typography } from '@/constants/Typography';
import type {
    NativeSettingsMenuGroup,
    NativeSettingsMenuOption,
    NativeSettingsMenuProps,
} from './NativeSettingsMenu';
import { isNativeMenuChoice } from './nativeMenuSelection';

function getIconForSystemImage(systemImage?: string): keyof typeof Ionicons.glyphMap | null {
    if (!systemImage) return null;
    switch (systemImage) {
        case 'paintpalette': return 'color-palette-outline';
        case 'shield': return 'shield-outline';
        case 'cube': return 'cube-outline';
        case 'bolt': return 'flash-outline';
        case 'rectangle.grid.1x2': return 'grid-outline';
        case 'checkmark': return 'checkmark';
        case 'gear': return 'settings-outline';
        case 'trash': return 'trash-outline';
        case 'share': return 'share-outline';
        case 'pencil': return 'pencil-outline';
        case 'folder': return 'folder-outline';
        case 'info.circle': return 'information-circle-outline';
        default: return 'ellipse-outline';
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    trigger: {
        cursor: 'pointer',
    },
    triggerDisabled: {
        cursor: 'auto',
    },
    defaultTrigger: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    triggerIcon: {
        marginRight: 2,
    },
    triggerText: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default(),
    },
    backdrop: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'transparent',
    },
    menuCard: {
        minWidth: 180,
        maxWidth: 320,
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.modal.border,
        shadowColor: theme.colors.shadow.color,
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 10,
        paddingVertical: 4,
        overflow: 'hidden',
        zIndex: 9999,
    },
    groupHeader: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    groupHeaderText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        ...Typography.default('semiBold'),
    },
    menuOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 12,
        gap: 8,
        cursor: 'pointer',
    },
    menuOptionHovered: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    menuOptionDisabled: {
        opacity: 0.5,
        cursor: 'auto',
    },
    leadingSlot: {
        width: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    labelContainer: {
        flex: 1,
        justifyContent: 'center',
    },
    primaryText: {
        fontSize: 13,
        lineHeight: 18,
        ...Typography.default('semiBold'),
    },
    secondaryText: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.textSecondary,
        marginTop: 2,
        ...Typography.default(),
    },
    groupDivider: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginVertical: 4,
    },
}));

export function NativeSettingsMenu({
    groups,
    children,
    style,
    accessibilityLabel,
    onMenuOpen,
    flat = false,
    triggerLabel,
    triggerSystemImage,
    triggerAlignment,
    anchor = 'bottom',
}: NativeSettingsMenuProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const triggerRef = React.useRef<View>(null);
    const [isOpen, setIsOpen] = React.useState(false);
    const [anchorRect, setAnchorRect] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();

    const hasOptions = React.useMemo(() => (
        groups?.some((group) => group.options.length > 0) ?? false
    ), [groups]);

    const handleTriggerPress = React.useCallback(() => {
        if (!hasOptions) return;
        if (isOpen) {
            setIsOpen(false);
            return;
        }

        const node = triggerRef.current as any;
        const onMeasured = (rect: { x: number; y: number; width: number; height: number }) => {
            setAnchorRect(rect);
            onMenuOpen?.();
            setIsOpen(true);
        };

        if (node) {
            if (typeof node.getBoundingClientRect === 'function') {
                const r = node.getBoundingClientRect();
                onMeasured({ x: r.left, y: r.top, width: r.width, height: r.height });
                return;
            }
            if (typeof node.measureInWindow === 'function') {
                node.measureInWindow((x: number, y: number, width: number, height: number) => {
                    onMeasured({ x, y, width, height });
                });
                return;
            }
        }
        onMenuOpen?.();
        setIsOpen(true);
    }, [hasOptions, isOpen, onMenuOpen]);

    const handleClose = React.useCallback(() => {
        setIsOpen(false);
    }, []);

    React.useEffect(() => {
        if (!isOpen || Platform.OS !== 'web' || typeof window === 'undefined') return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setIsOpen(false);
            }
        };
        const handleDismiss = () => setIsOpen(false);

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleDismiss);
        window.addEventListener('scroll', handleDismiss, true);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleDismiss);
            window.removeEventListener('scroll', handleDismiss, true);
        };
    }, [isOpen]);

    const menuPositionStyle = React.useMemo(() => {
        if (!anchorRect) return {};
        const MARGIN = 12;
        const isAnchorBottom = anchor === 'bottom' || (!anchor && anchorRect.y > windowHeight / 2);

        const verticalStyle = isAnchorBottom
            ? { bottom: Math.max(MARGIN, windowHeight - anchorRect.y + 6) }
            : { top: Math.max(MARGIN, anchorRect.y + anchorRect.height + 6) };

        const isTrailing = triggerAlignment === 'trailing' || (!triggerAlignment && (anchorRect.x + anchorRect.width / 2 > windowWidth / 2));

        const horizontalStyle = isTrailing
            ? { right: Math.max(MARGIN, windowWidth - (anchorRect.x + anchorRect.width)) }
            : { left: Math.max(MARGIN, anchorRect.x) };

        return {
            position: 'absolute' as const,
            ...verticalStyle,
            ...horizontalStyle,
        };
    }, [anchor, anchorRect, triggerAlignment, windowHeight, windowWidth]);

    const triggerIcon = triggerSystemImage ? getIconForSystemImage(triggerSystemImage) : null;

    const renderOption = (group: NativeSettingsMenuGroup, option: NativeSettingsMenuOption, showLeadingSlot: boolean) => {
        const hasChoice = isNativeMenuChoice(group);
        const isSelected = hasChoice && group.selectedKey === option.key;
        const lines = option.label.split('\n');
        const primaryText = lines[0];
        const secondaryText = lines.slice(1).join('\n');
        const optionIcon = getIconForSystemImage(option.systemImage);

        return (
            <Pressable
                key={`${group.key}:${option.key}`}
                disabled={option.disabled}
                onPress={() => {
                    if (option.disabled) return;
                    setIsOpen(false);
                    group.onSelect(option.key);
                }}
                accessibilityRole="menuitem"
                accessibilityState={{ disabled: Boolean(option.disabled), selected: isSelected }}
                style={({ pressed, hovered }: any) => [
                    styles.menuOption,
                    (hovered || pressed) && !option.disabled && styles.menuOptionHovered,
                    option.disabled && styles.menuOptionDisabled,
                ]}
            >
                {showLeadingSlot && (
                    <View style={styles.leadingSlot}>
                        {isSelected ? (
                            <Ionicons name="checkmark" size={16} color={theme.colors.text} />
                        ) : optionIcon ? (
                            <Ionicons name={optionIcon} size={16} color={theme.colors.textSecondary} />
                        ) : null}
                    </View>
                )}
                <View style={styles.labelContainer}>
                    <Text
                        style={[
                            styles.primaryText,
                            { color: option.disabled ? theme.colors.textSecondary : theme.colors.text },
                        ]}
                        numberOfLines={1}
                    >
                        {primaryText}
                    </Text>
                    {Boolean(secondaryText) && (
                        <Text style={styles.secondaryText}>
                            {secondaryText}
                        </Text>
                    )}
                </View>
            </Pressable>
        );
    };

    return (
        <>
            <Pressable
                ref={triggerRef}
                onPress={handleTriggerPress}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel ?? triggerLabel}
                accessibilityState={{ expanded: isOpen }}
                style={({ pressed }: any) => [
                    hasOptions ? styles.trigger : styles.triggerDisabled,
                    style,
                    pressed && hasOptions && { opacity: 0.7 },
                ]}
            >
                {children ?? (
                    <View style={styles.defaultTrigger}>
                        {triggerIcon && <Ionicons name={triggerIcon} size={16} color={theme.colors.text} style={styles.triggerIcon} />}
                        {triggerLabel && <Text style={styles.triggerText}>{triggerLabel}</Text>}
                    </View>
                )}
            </Pressable>

            {isOpen && (
                <RNModal
                    transparent
                    visible={isOpen}
                    onRequestClose={handleClose}
                    animationType="none"
                >
                    <Pressable onPress={handleClose} style={styles.backdrop} />
                    <View style={[styles.menuCard, menuPositionStyle]}>
                        <ScrollView
                            bounces={false}
                            showsVerticalScrollIndicator={false}
                            contentContainerStyle={{ paddingVertical: 2 }}
                        >
                            {groups.map((group, groupIndex) => {
                                const hasChoice = isNativeMenuChoice(group);
                                const hasIcons = group.options.some((o) => Boolean(o.systemImage));
                                const showLeadingSlot = hasChoice || hasIcons;

                                return (
                                    <View key={group.key}>
                                        {Boolean(!flat && group.title) && (
                                            <View style={styles.groupHeader}>
                                                <Text style={styles.groupHeaderText}>{group.title}</Text>
                                            </View>
                                        )}
                                        {group.options.map((option) => renderOption(group, option, showLeadingSlot))}
                                        {groupIndex < groups.length - 1 && <View style={styles.groupDivider} />}
                                    </View>
                                );
                            })}
                        </ScrollView>
                    </View>
                </RNModal>
            )}
        </>
    );
}
