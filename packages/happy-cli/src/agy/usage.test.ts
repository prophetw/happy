import { describe, it, expect, vi } from 'vitest';
import {
  formatCountdown,
  getMinutesUntil,
  parseLanguageServerUserStatus,
  formatAgyUsageMarkdown,
  formatAgyUsageTerminal,
  fetchAgyUsage,
  type AgyUsageStatus,
} from './usage';

describe('formatCountdown', () => {
  it('formats minutes into hours and minutes', () => {
    expect(formatCountdown(90)).toBe('1h 30m');
    expect(formatCountdown(45)).toBe('45m');
    expect(formatCountdown(125)).toBe('2h 05m');
    expect(formatCountdown(0)).toBe('Now');
    expect(formatCountdown(-5)).toBe('Now');
  });
});

describe('getMinutesUntil', () => {
  it('calculates remaining minutes until ISO reset time', () => {
    const now = new Date('2026-08-24T12:00:00Z').getTime();
    const resetTime = '2026-08-24T13:30:00Z';
    expect(getMinutesUntil(resetTime, now)).toBe(90);
  });

  it('returns 0 if reset time is in the past', () => {
    const now = new Date('2026-08-24T14:00:00Z').getTime();
    const resetTime = '2026-08-24T13:30:00Z';
    expect(getMinutesUntil(resetTime, now)).toBe(0);
  });

  it('returns undefined for invalid dates', () => {
    expect(getMinutesUntil(undefined)).toBeUndefined();
    expect(getMinutesUntil('invalid-date')).toBeUndefined();
  });
});

describe('parseLanguageServerUserStatus', () => {
  it('parses userStatus and clientModelConfigs properly', () => {
    const mockUserStatus = {
      name: 'Developer',
      email: 'dev@example.com',
      planStatus: {
        planInfo: {
          planName: 'Pro',
          teamsTier: 'TEAMS_TIER_PRO',
        },
        availablePromptCredits: 100,
      },
      userTier: {
        name: 'Google AI Pro',
        availableCredits: [
          { creditType: 'GOOGLE_ONE_AI', minimumCreditAmountForUsage: '50' },
        ],
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 3.7 Flash (High)',
            modelId: 'gemini-3.7-flash-high',
            quotaInfo: {
              remainingFraction: 0.85,
              resetTime: '2026-08-24T20:00:00Z',
            },
            isRecommended: true,
          },
          {
            label: 'Claude Sonnet 4.6 (Thinking)',
            modelId: 'claude-sonnet-4-6',
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: '2026-08-24T20:00:00Z',
            },
          },
        ],
      },
    };

    const status = parseLanguageServerUserStatus(mockUserStatus);

    expect(status.accountName).toBe('Developer');
    expect(status.email).toBe('dev@example.com');
    expect(status.planName).toBe('Pro');
    expect(status.userTierName).toBe('Google AI Pro');
    expect(status.models).toHaveLength(2);

    expect(status.models[0].label).toBe('Gemini 3.7 Flash (High)');
    expect(status.models[0].remainingFraction).toBe(0.85);
    expect(status.models[0].usedPercentage).toBe(15);
    expect(status.models[0].isRecommended).toBe(true);

    expect(status.models[1].label).toBe('Claude Sonnet 4.6 (Thinking)');
    expect(status.models[1].remainingFraction).toBe(0.5);
    expect(status.models[1].usedPercentage).toBe(50);
  });
});

describe('formatAgyUsageMarkdown', () => {
  it('formats quota markdown table with details', () => {
    const status: AgyUsageStatus = {
      accountName: 'Test User',
      email: 'test@example.com',
      planName: 'Google AI Pro',
      userTierName: 'Google AI Pro',
      source: 'language-server',
      models: [
        {
          modelId: 'gemini-3.7-flash-high',
          label: 'Gemini 3.7 Flash (High)',
          remainingFraction: 0.9,
          usedPercentage: 10,
          resetTime: '2026-08-24T20:00:00Z',
          resetsInFormatted: '1h 30m',
        },
        {
          modelId: 'claude-sonnet-4-6',
          label: 'Claude Sonnet 4.6 (Thinking)',
          remainingFraction: 0.3,
          usedPercentage: 70,
          resetTime: '2026-08-24T20:00:00Z',
          resetsInFormatted: '1h 30m',
        },
      ],
    };

    const md = formatAgyUsageMarkdown(status);

    expect(md).toContain('### 📊 Antigravity (`agy`) 额度与用量');
    expect(md).toContain('Test User (`test@example.com`)');
    expect(md).toContain('Gemini 3.7 Flash (High)');
    expect(md).toContain('🟢 **90%**');
    expect(md).toContain('Claude Sonnet 4.6 (Thinking)');
    expect(md).toContain('🔴 **30%**');
    expect(md).toContain('5 小时滚动额度');
  });

  it('renders fallback error message when source is none', () => {
    const status: AgyUsageStatus = {
      source: 'none',
      models: [],
      error: 'Not logged in',
    };

    const md = formatAgyUsageMarkdown(status);
    expect(md).toContain('### ⚠️ Antigravity (agy) Quota Unavailable');
    expect(md).toContain('Not logged in');
  });
});

describe('formatAgyUsageTerminal', () => {
  it('formats terminal output with model remaining percentages', () => {
    const status: AgyUsageStatus = {
      email: 'test@example.com',
      planName: 'Pro',
      source: 'language-server',
      models: [
        {
          modelId: 'gemini-3.7-flash-high',
          label: 'Gemini 3.7 Flash (High)',
          remainingFraction: 0.9,
          resetsInFormatted: '1h 30m',
        },
      ],
    };

    const term = formatAgyUsageTerminal(status);
    expect(term).toContain('Antigravity (agy) Quota & Usage');
    expect(term).toContain('test@example.com');
    expect(term).toContain('Gemini 3.7 Flash (High)');
    expect(term).toContain('90% remaining');
  });
});

describe('fetchAgyUsage', () => {
  it('falls back to error status if no language server or token', async () => {
    const status = await fetchAgyUsage({
      tokenPath: '/non-existent/path',
      execSyncFn: () => {
        throw new Error('No process');
      },
    });

    expect(status.source).toBe('none');
    expect(status.models).toEqual([]);
  });
});
