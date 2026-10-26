import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { TokenSpeedSample } from '@/sync/typesMessage';

export function formatTokenSpeed(tokensPerSecond: number | undefined): string | null {
    if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
    return tokensPerSecond < 0.1 ? '<0.1' : tokensPerSecond.toFixed(1);
}

/** Groups digits without relying on Intl, which is optional in some Hermes builds. */
function formatTokenCount(tokens: number): string {
    return Math.round(tokens).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Explains the sampled ratio itself: tokens ÷ measured seconds = rate. */
export function formatTokenSpeedCalculation(sample: TokenSpeedSample | undefined): string | null {
    if (!sample || !Number.isFinite(sample.tokens) || sample.tokens <= 0
        || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0
        || !Number.isFinite(sample.requests) || sample.requests < 1) return null;
    const seconds = sample.durationMs / 1000;
    const speed = formatTokenSpeed(sample.tokens / seconds);
    if (speed === null) return null;
    return t('agentInput.context.outputSpeedCalculation', {
        tokens: formatTokenCount(sample.tokens),
        seconds: seconds.toFixed(2),
        requests: Math.round(sample.requests),
        speed,
    });
}

export const OutputTokenSpeed = React.memo(function OutputTokenSpeed(props: {
    tokensPerSecond?: number;
    sample?: TokenSpeedSample;
}) {
    const { theme } = useUnistyles();
    const speed = formatTokenSpeed(props.tokensPerSecond);
    if (speed === null) return null;
    const label = t('agentInput.context.outputSpeed', { speed });
    const description = t('agentInput.context.outputSpeedDescription');
    const calculation = formatTokenSpeedCalculation(props.sample);
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={10}
            onPress={() => Modal.alert(
                t('agentInput.context.outputSpeedTitle'),
                calculation ? `${calculation}\n\n${description}` : description,
            )}
        >
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                {label}
            </Text>
        </Pressable>
    );
});
