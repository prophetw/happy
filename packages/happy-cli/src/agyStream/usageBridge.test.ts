import { describe, it, expect } from 'vitest';
import {
  resolveAgyModelContextWindow,
  buildAgyUsageEnvelope,
  buildUsageEnvelopeFromContextWindow,
  buildAgyUsageLimits,
} from './usageBridge';
import type { AgyStatusLineQuota } from './statusLine';

describe('resolveAgyModelContextWindow', () => {
  it('defaults to 1,000,000 for undefined or gemini models', () => {
    expect(resolveAgyModelContextWindow(undefined)).toBe(1_000_000);
    expect(resolveAgyModelContextWindow('Gemini 3.8 Flash (High)')).toBe(1_000_000);
    expect(resolveAgyModelContextWindow('gemini-3.7-flash')).toBe(1_000_000);
  });

  it('returns 200,000 for Claude models', () => {
    expect(resolveAgyModelContextWindow('Claude Sonnet 4.6 (Thinking)')).toBe(200_000);
    expect(resolveAgyModelContextWindow('claude-opus-4.6')).toBe(200_000);
  });

  it('returns 128,000 for GPT / OSS models', () => {
    expect(resolveAgyModelContextWindow('GPT-OSS 120B (Medium)')).toBe(128_000);
  });
});

describe('buildAgyUsageEnvelope', () => {
  it('returns null if no token information is present', () => {
    expect(buildAgyUsageEnvelope({})).toBeNull();
    expect(buildAgyUsageEnvelope({ irrelevant: 'value' })).toBeNull();
  });

  it('builds a usage-only service envelope from token-count payload', () => {
    const envelope = buildAgyUsageEnvelope(
      {
        input_tokens: 1500,
        output_tokens: 300,
        cache_read_tokens: 200,
      },
      'Gemini 3.8 Flash (High)',
    );

    expect(envelope).toBeDefined();
    expect(envelope?.role).toBe('agent');
    expect(envelope?.ev).toEqual({ t: 'service', text: '' });
    expect(envelope?.turn).toBeUndefined(); // Usage-only service envelopes omit turn so mobile does not create a chat bubble
    expect(envelope?.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 300,
      cache_read_input_tokens: 200,
      context_window: 1_000_000,
    });
  });

  it('respects explicit context_window in message', () => {
    const envelope = buildAgyUsageEnvelope({
      input_tokens: 500,
      output_tokens: 50,
      context_window: 500_000,
    });

    expect(envelope?.usage?.context_window).toBe(500_000);
  });

  it('handles camelCase and alternative token names from stream-json', () => {
    const envelope = buildAgyUsageEnvelope(
      {
        inputTokens: 1200,
        outputTokens: 40,
        cachedContentTokenCount: 150,
        totalTokens: 1240,
      },
      'Claude Sonnet 4.6 (Thinking)',
    );

    expect(envelope?.usage).toMatchObject({
      input_tokens: 1050,
      output_tokens: 40,
      cache_read_input_tokens: 150,
      context_window: 200_000,
    });
  });
});

describe('buildUsageEnvelopeFromContextWindow', () => {
  it('builds a service envelope from statusline contextWindow', () => {
    const envelope = buildUsageEnvelopeFromContextWindow(
      {
        totalInputTokens: 94926,
        totalOutputTokens: 29652,
        contextWindowSize: 1048576,
      },
      'Gemini 3.8 Flash (High)',
    );

    expect(envelope).toBeDefined();
    expect(envelope?.usage).toEqual({
      input_tokens: 94926,
      output_tokens: 29652,
      context_window: 1048576,
    });
  });

  it('returns null if no tokens or context window size available', () => {
    expect(buildUsageEnvelopeFromContextWindow({})).toBeNull();
  });
});

describe('buildAgyUsageLimits', () => {
  const mockQuota: AgyStatusLineQuota = {
    updatedAt: 1700000000000,
    gemini: {
      name: 'Gemini',
      fiveHour: {
        usedPercentage: 90,
        resetTime: '2026-10-01T12:00:00Z',
      },
      weekly: {
        usedPercentage: 45,
        resetsInMinutes: 360,
      },
    },
    claude: {
      name: 'Claude',
      fiveHour: {
        usedPercentage: 20,
      },
      weekly: {
        usedPercentage: 70,
      },
    },
  };

  it('returns null when quota is null or has no windows', () => {
    expect(buildAgyUsageLimits(null)).toBeNull();
    expect(buildAgyUsageLimits({ updatedAt: 123 } as any)).toBeNull();
  });

  it('extracts gemini rate limit windows for gemini model', () => {
    const limits = buildAgyUsageLimits(mockQuota, 'Gemini 3.8 Flash (High)', 1700000000000);
    expect(limits).toBeDefined();
    expect(limits?.windows).toHaveLength(2);

    const fiveHour = limits?.windows.find((w) => w.id === 'five_hour');
    expect(fiveHour).toMatchObject({
      id: 'five_hour',
      label: '5h',
      utilization: 90,
      status: 'allowed_warning',
    });
    expect(fiveHour?.resetsAt).toBe(Date.parse('2026-10-01T12:00:00Z'));

    const weekly = limits?.windows.find((w) => w.id === 'seven_day');
    expect(weekly).toMatchObject({
      id: 'seven_day',
      label: '7d',
      utilization: 45,
      status: 'allowed',
      resetsAt: 1700000000000 + 360 * 60_000,
    });
  });

  it('extracts claude rate limit windows for claude model', () => {
    const limits = buildAgyUsageLimits(mockQuota, 'Claude Sonnet 4.6 (Thinking)');
    expect(limits).toBeDefined();
    const fiveHour = limits?.windows.find((w) => w.id === 'five_hour');
    expect(fiveHour?.utilization).toBe(20);
    expect(fiveHour?.status).toBe('allowed');

    const weekly = limits?.windows.find((w) => w.id === 'seven_day');
    expect(weekly?.utilization).toBe(70);
  });
});
