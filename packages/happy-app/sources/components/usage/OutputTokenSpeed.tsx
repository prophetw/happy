import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

export function formatTokenSpeed(tokensPerSecond: number | undefined): string | null {
    if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
    return tokensPerSecond < 0.1 ? '<0.1' : tokensPerSecond.toFixed(1);
}

export const OutputTokenSpeed = React.memo(function OutputTokenSpeed(props: { tokensPerSecond?: number }) {
    const { theme } = useUnistyles();
    const speed = formatTokenSpeed(props.tokensPerSecond);
    if (speed === null) return null;
    const label = t('agentInput.context.outputSpeed', { speed });
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={10}
            onPress={() => Modal.alert(t('agentInput.context.outputSpeedTitle'), t('agentInput.context.outputSpeedDescription'))}
        >
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                {label}
            </Text>
        </Pressable>
    );
});
