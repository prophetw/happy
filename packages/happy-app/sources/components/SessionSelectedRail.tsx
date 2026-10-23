import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { Theme } from '@/theme';

/**
 * The wash behind the chat that is currently open in the list.
 *
 * A selection that only shifts the surface tone is nearly invisible next to a
 * hovered row or a status colour, especially in the narrow sidebar. The open
 * chat therefore gets a blue wash as well as the rail below, so it can be
 * found at a glance.
 */
export function sessionSelectedBackgroundColor(theme: Theme): string {
    return theme.dark ? 'rgba(10, 132, 255, 0.16)' : 'rgba(0, 122, 255, 0.09)';
}

/**
 * Leading-edge rail for the open chat. Inset from the row's top and bottom so
 * it reads as a marker rather than a border, and stays clear of the rounded
 * corners on the first and last rows of a card.
 */
export const SessionSelectedRail = React.memo(function SessionSelectedRail() {
    return <View pointerEvents="none" style={styles.rail} />;
});

const styles = StyleSheet.create((theme) => ({
    rail: {
        position: 'absolute',
        left: 0,
        top: 6,
        bottom: 6,
        width: 3,
        borderRadius: 2,
        backgroundColor: theme.colors.radio.active,
    },
}));
