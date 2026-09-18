import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseQuotaWindow,
  parseQuotaGroup,
  parseStatusLineQuota,
  parseStatusLinePayload,
  AgyQuotaStore,
} from './statusLine';

describe('parseQuotaWindow', () => {
  it('parses fractional remainingFraction and derives percentage & usedPercentage', () => {
    const window = parseQuotaWindow({
      remaining_fraction: 0.85,
      reset_time: '2026-08-25T15:00:00Z',
    }, new Date('2026-08-25T12:00:00Z').getTime());

    expect(window).toBeDefined();
    expect(window?.remainingFraction).toBe(0.85);
    expect(window?.percentage).toBe(85);
    expect(window?.usedPercentage).toBe(15);
    expect(window?.resetsInMinutes).toBe(180);
    expect(window?.resetsInFormatted).toBe('3h 00m');
  });

  it('parses direct percentage and computes remainingFraction', () => {
    const window = parseQuotaWindow({
      percentage: 72,
      reset_in_seconds: 3600,
    });

    expect(window).toBeDefined();
    expect(window?.percentage).toBe(72);
    expect(window?.remainingFraction).toBe(0.72);
    expect(window?.usedPercentage).toBe(28);
    expect(window?.resetsInMinutes).toBe(60);
    expect(window?.resetsInFormatted).toBe('1h 00m');
  });

  it('parses direct number value', () => {
    const windowFraction = parseQuotaWindow(0.9);
    expect(windowFraction?.percentage).toBe(90);
    expect(windowFraction?.remainingFraction).toBe(0.9);
    expect(windowFraction?.usedPercentage).toBe(10);

    const windowPct = parseQuotaWindow(45);
    expect(windowPct?.percentage).toBe(45);
    expect(windowPct?.remainingFraction).toBe(0.45);
    expect(windowPct?.usedPercentage).toBe(55);
  });
});

describe('parseQuotaGroup', () => {
  it('parses fiveHour and weekly windows from group object', () => {
    const group = parseQuotaGroup('Gemini', {
      five_hour: {
        remaining_fraction: 0.95,
        resets_in_minutes: 90,
      },
      weekly: {
        percentage: 80,
      },
    });

    expect(group).toBeDefined();
    expect(group?.name).toBe('Gemini');
    expect(group?.fiveHour?.percentage).toBe(95);
    expect(group?.fiveHour?.resetsInFormatted).toBe('1h 30m');
    expect(group?.weekly?.percentage).toBe(80);
    expect(group?.weekly?.usedPercentage).toBe(20);
  });

  it('handles short keys 5h and 7d', () => {
    const group = parseQuotaGroup('Claude / GPT', {
      '5h': 0.6,
      '7d': 0.75,
    });

    expect(group).toBeDefined();
    expect(group?.fiveHour?.percentage).toBe(60);
    expect(group?.weekly?.percentage).toBe(75);
  });
});

describe('parseStatusLineQuota', () => {
  it('parses standard dual-channel quota with Gemini and Claude/GPT', () => {
    const rawQuota = {
      gemini: {
        five_hour: {
          remaining_fraction: 0.9,
          resets_in_minutes: 120,
        },
        weekly: {
          percentage: 85,
        },
      },
      claude: {
        five_hour: {
          remaining_fraction: 0.5,
          resets_in_minutes: 45,
        },
        weekly: {
          percentage: 60,
        },
      },
    };

    const quota = parseStatusLineQuota(rawQuota);
    expect(quota).toBeDefined();
    expect(quota?.gemini?.name).toBe('Gemini');
    expect(quota?.gemini?.fiveHour?.percentage).toBe(90);
    expect(quota?.gemini?.weekly?.percentage).toBe(85);

    expect(quota?.claude?.name).toBe('Claude / GPT');
    expect(quota?.claude?.fiveHour?.percentage).toBe(50);
    expect(quota?.claude?.weekly?.percentage).toBe(60);
  });

  it('handles flat top-level five_hour and weekly fallback', () => {
    const rawQuota = {
      five_hour: {
        percentage: 88,
      },
      weekly: {
        percentage: 92,
      },
    };

    const quota = parseStatusLineQuota(rawQuota);
    expect(quota).toBeDefined();
    expect(quota?.gemini?.fiveHour?.percentage).toBe(88);
    expect(quota?.gemini?.weekly?.percentage).toBe(92);
  });
});

describe('parseStatusLinePayload', () => {
  it('parses complete JSON payload string from statusLine hook', () => {
    const jsonStr = JSON.stringify({
      cwd: '/workspace/project',
      model: {
        id: 'gemini-3.7-flash',
        displayName: 'Gemini 3.7 Flash',
      },
      quota: {
        gemini: {
          '5h': 0.95,
          weekly: 0.85,
        },
        claude: {
          '5h': 0.7,
          weekly: 0.5,
        },
      },
    });

    const parsed = parseStatusLinePayload(jsonStr);
    expect(parsed).toBeDefined();
    expect(parsed?.payload.cwd).toBe('/workspace/project');
    expect(parsed?.quota?.gemini?.fiveHour?.percentage).toBe(95);
    expect(parsed?.quota?.claude?.fiveHour?.percentage).toBe(70);
  });
});

describe('AgyQuotaStore', () => {
  beforeEach(() => {
    AgyQuotaStore.resetInstance();
  });

  it('stores and notifies listeners when new statusLine payload arrives', () => {
    const store = AgyQuotaStore.getInstance();
    expect(store.hasQuota(false)).toBe(false);

    let notifiedCount = 0;
    const unsubscribe = store.subscribe((quota) => {
      notifiedCount++;
      expect(quota.gemini?.fiveHour?.percentage).toBe(90);
    });

    const updated = store.update({
      quota: {
        gemini: {
          five_hour: { percentage: 90 },
          weekly: { percentage: 80 },
        },
        claude: {
          five_hour: { percentage: 40 },
          weekly: { percentage: 60 },
        },
      },
    });

    expect(updated).toBe(true);
    expect(store.hasQuota()).toBe(true);
    expect(notifiedCount).toBe(1);

    const usageStatus = store.toUsageStatus();
    expect(usageStatus).toBeDefined();
    expect(usageStatus?.source).toBe('statusline-hook');
    expect(usageStatus?.groups?.gemini?.fiveHour?.percentage).toBe(90);
    expect(usageStatus?.groups?.claude?.fiveHour?.percentage).toBe(40);
    expect(usageStatus?.models.length).toBeGreaterThan(0);

    unsubscribe();
  });

  it('parses native Agy statusline state with 3p-5h, 3p-weekly, gemini-5h, gemini-weekly', () => {
    const rawState = {
      model: { id: 'Gemini 3.7 Flash (High)', display_name: 'Gemini 3.7 Flash (High)' },
      quota: {
        '3p-5h': { remaining_fraction: 1, reset_time: '2026-08-25T04:57:40Z', reset_in_seconds: 16468 },
        '3p-weekly': { remaining_fraction: 1, reset_time: '2026-08-31T23:57:40Z', reset_in_seconds: 603268 },
        'gemini-5h': { remaining_fraction: 0.99, reset_time: '2026-08-25T04:39:11Z', reset_in_seconds: 15359 },
        'gemini-weekly': { remaining_fraction: 0.48, reset_time: '2026-08-29T12:32:04Z', reset_in_seconds: 389332 },
      },
      plan_tier: 'Google AI Pro',
      email: 'testuser@example.com',
    };

    const quota = parseStatusLineQuota(rawState);
    expect(quota).toBeDefined();
    expect(quota?.gemini?.name).toBe('Gemini');
    expect(quota?.gemini?.fiveHour?.percentage).toBe(99);
    expect(quota?.gemini?.weekly?.percentage).toBe(48);

    expect(quota?.claude?.name).toBe('Claude / GPT');
    expect(quota?.claude?.fiveHour?.percentage).toBe(100);
    expect(quota?.claude?.weekly?.percentage).toBe(100);

    expect(quota?.email).toBe('testuser@example.com');
    expect(quota?.planTier).toBe('Google AI Pro');
  });
});
