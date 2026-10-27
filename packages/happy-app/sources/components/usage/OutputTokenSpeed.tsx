import * as React from 'react';
import { Pressable, Text } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { GenerationMetrics, TokenSpeedSample } from '@/sync/typesMessage';

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
    generationMetrics?: GenerationMetrics;
}) {
    const { theme } = useUnistyles();
    const generation = props.generationMetrics;
    const speed = formatTokenSpeed(generation ? generation.tokensPerSecond : props.tokensPerSecond);
    const wait = generation?.timeToFirstTokenMs;
    const waitLabel = typeof wait === 'number' && Number.isFinite(wait) && wait >= 0
        ? t('agentInput.context.firstTokenWait', { seconds: (wait / 1000).toFixed(2) }) : null;
    const label = [speed !== null ? t(generation ? 'agentInput.context.generationSpeed' : 'agentInput.context.outputSpeed', { speed }) : null,
        waitLabel].filter(Boolean).join(' · ');
    if (!label) return null;
    const description = t(generation ? 'agentInput.context.generationSpeedDescription' : 'agentInput.context.outputSpeedDescription');
    const calculation = formatTokenSpeedCalculation(generation ? generation.sample : props.sample);
    return (
        <Pressable
            style={{ flexShrink: 1 }}
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={10}
            onPress={() => Modal.alert(
                t(generation ? 'agentInput.context.generationSpeedTitle' : 'agentInput.context.outputSpeedTitle'),
                [calculation, waitLabel, description].filter(Boolean).join('\n\n'),
            )}
        >
            <Text style={{ fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() }}>
                {label}
            </Text>
        </Pressable>
    );
});
