/**
 * Agy Usage & Rate Limits Bridge
 *
 * Connects Antigravity (agy) live stream-json token counts and statusLine
 * quota metrics into the standard Happy Session Protocol:
 *
 * 1. Live context token usage -> SessionEnvelope with { t: 'service', text: '' }, { usage: SessionUsage }
 *    surfaced in the iOS/desktop app's input bar context gauge.
 * 2. Plan rate limits (5h & 7d windows) -> Session agentState.usageLimits
 *    surfaced as usage chips (5h / 7d) and popups.
 */

import { createEnvelope, type SessionEnvelope, type SessionUsage } from '@slopus/happy-wire';
import type { UsageLimits, UsageLimitWindow, UsageLimitWindowStatus } from '@/api/types';
import type { AgyStatusLineQuota, AgyContextWindowInfo } from './statusLine';

/**
 * Returns the estimated or standard context window size for a given agy model.
 */
export function resolveAgyModelContextWindow(modelName?: string): number {
  if (!modelName) {
    return 1_000_000; // Default to Gemini 3.8/3.7 Flash 1M context
  }
  const lower = modelName.toLowerCase();
  if (lower.includes('claude')) {
    return 200_000;
  }
  if (lower.includes('gpt') || lower.includes('oss')) {
    return 128_000;
  }
  if (lower.includes('gemini')) {
    return 1_000_000;
  }
  return 1_000_000;
}

export function pickTokenCount(message: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = message[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

/**
 * Converts a raw token-count message or step.usage / result.usage into a
 * usage-only SessionEnvelope that Happy clients consume to update contextSize.
 */
export function buildAgyUsageEnvelope(
  message: Record<string, unknown>,
  currentModel?: string,
): SessionEnvelope | null {
  const input = pickTokenCount(message, [
    'input_tokens',
    'inputTokens',
    'prompt_tokens',
    'promptTokens',
    'prompt_token_count',
    'total_input_tokens',
  ]);
  const output = pickTokenCount(message, [
    'output_tokens',
    'outputTokens',
    'completion_tokens',
    'completionTokens',
    'candidates_token_count',
    'total_output_tokens',
  ]);
  const cacheRead = pickTokenCount(message, [
    'cache_read_tokens',
    'cacheReadTokens',
    'cache_read_input_tokens',
    'cacheReadInputTokens',
    'cached_content_token_count',
    'cachedContentTokenCount',
    'cached_input_tokens',
  ]);
  const cacheCreation = pickTokenCount(message, [
    'cache_creation_tokens',
    'cacheCreationTokens',
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  ]);
  const total = pickTokenCount(message, [
    'total_tokens',
    'totalTokens',
    'total_token_count',
    'tokensUsed',
    'usedTokens',
  ]);
  const explicitWindow = pickTokenCount(message, [
    'context_window',
    'contextWindow',
    'context_window_size',
    'contextWindowSize',
    'model_context_window',
    'modelContextWindow',
    'max_tokens',
  ]);

  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheCreation === undefined &&
    total === undefined
  ) {
    return null;
  }

  const outputTokens = output ?? 0;
  const cacheCreationTokens = cacheCreation ?? 0;
  const cacheReadTokens = cacheRead ?? 0;
  const inputTokensIncludeCache =
    input !== undefined && total !== undefined && total === input + outputTokens;
  const fallbackInputTokens =
    input ?? Math.max(0, (total ?? 0) - outputTokens - cacheCreationTokens - cacheReadTokens);
  const inputTokens =
    inputTokensIncludeCache && input !== undefined
      ? Math.max(0, input - cacheCreationTokens - cacheReadTokens)
      : fallbackInputTokens;

  const contextWindow = explicitWindow ?? resolveAgyModelContextWindow(currentModel);

  const usage: SessionUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
    ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
    ...(contextWindow > 0 ? { context_window: contextWindow } : {}),
  };

  return createEnvelope('agent', { t: 'service', text: '' }, { usage });
}

/**
 * Builds a usage-only SessionEnvelope directly from AgyContextWindowInfo (from statusLine).
 */
export function buildUsageEnvelopeFromContextWindow(
  contextWindow: AgyContextWindowInfo,
  currentModel?: string,
): SessionEnvelope | null {
  const inputTokens = contextWindow.totalInputTokens;
  const outputTokens = contextWindow.totalOutputTokens ?? 0;
  if (inputTokens === undefined && contextWindow.contextWindowSize === undefined) {
    return null;
  }

  const contextWindowSize =
    contextWindow.contextWindowSize ?? resolveAgyModelContextWindow(currentModel);

  const usage: SessionUsage = {
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens,
    ...(contextWindow.currentUsage?.cacheReadInputTokens
      ? { cache_read_input_tokens: contextWindow.currentUsage.cacheReadInputTokens }
      : {}),
    ...(contextWindow.currentUsage?.cacheCreationInputTokens
      ? { cache_creation_input_tokens: contextWindow.currentUsage.cacheCreationInputTokens }
      : {}),
    ...(contextWindowSize > 0 ? { context_window: contextWindowSize } : {}),
  };

  return createEnvelope('agent', { t: 'service', text: '' }, { usage });
}

function synthesizeWindowStatus(utilization: number | null | undefined): UsageLimitWindowStatus {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return 'allowed';
  if (utilization >= 100) return 'rejected';
  if (utilization >= 90) return 'allowed_warning';
  return 'allowed';
}

/**
 * Translates AgyStatusLineQuota into the Happy AgentState.usageLimits format
 * for mobile rate-limit display.
 */
export function buildAgyUsageLimits(
  quota: AgyStatusLineQuota | null,
  currentModel?: string,
  now = Date.now(),
): UsageLimits | null {
  if (!quota) return null;

  const isClaude = /claude/i.test(currentModel || '');
  // Prioritize the relevant channel based on active model, falling back to the other
  const activeGroup = isClaude
    ? (quota.claude ?? quota.gemini)
    : (quota.gemini ?? quota.claude);

  if (!activeGroup) {
    return null;
  }

  const windows: UsageLimitWindow[] = [];

  // 1. 5-hour window
  const fiveHour = activeGroup.fiveHour;
  if (fiveHour && (fiveHour.usedPercentage != null || fiveHour.percentage != null)) {
    const utilization =
      fiveHour.usedPercentage ??
      (fiveHour.percentage != null ? Math.max(0, 100 - fiveHour.percentage) : null);

    let resetsAt: number | null = null;
    if (fiveHour.resetTime) {
      const parsed = Date.parse(fiveHour.resetTime);
      if (Number.isFinite(parsed)) resetsAt = parsed;
    } else if (typeof fiveHour.resetsInMinutes === 'number') {
      resetsAt = now + fiveHour.resetsInMinutes * 60_000;
    } else if (typeof fiveHour.resetInSeconds === 'number') {
      resetsAt = now + fiveHour.resetInSeconds * 1_000;
    }

    windows.push({
      id: 'five_hour',
      label: '5h',
      status: synthesizeWindowStatus(utilization),
      utilization,
      resetsAt,
    });
  }

  // 2. 7-day (weekly) window
  const weekly = activeGroup.weekly;
  if (weekly && (weekly.usedPercentage != null || weekly.percentage != null)) {
    const utilization =
      weekly.usedPercentage ??
      (weekly.percentage != null ? Math.max(0, 100 - weekly.percentage) : null);

    let resetsAt: number | null = null;
    if (weekly.resetTime) {
      const parsed = Date.parse(weekly.resetTime);
      if (Number.isFinite(parsed)) resetsAt = parsed;
    } else if (typeof weekly.resetsInMinutes === 'number') {
      resetsAt = now + weekly.resetsInMinutes * 60_000;
    } else if (typeof weekly.resetInSeconds === 'number') {
      resetsAt = now + weekly.resetInSeconds * 1_000;
    }

    windows.push({
      id: 'seven_day',
      label: '7d',
      status: synthesizeWindowStatus(utilization),
      utilization,
      resetsAt,
    });
  }

  if (windows.length === 0) {
    return null;
  }

  return {
    capturedAt: quota.updatedAt || now,
    windows,
  };
}
