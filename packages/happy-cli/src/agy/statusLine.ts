/**
 * Antigravity (agy) StatusLine Hook Parser & Quota Store
 *
 * Agy resident processes stream standard agent dialogue over `stream-json`, while
 * publishing real-time quota data via the `statusLine` hook mechanism:
 *
 * Agy Resident Process
 *     ├── stream-json   --> Agent Conversation (turns, tool calls, thinking, deltas)
 *     └── statusLine    --> Quota JSON
 *                           ├── Gemini (5h %, Weekly %)
 *                           └── Claude/GPT (5h %, Weekly %)
 *
 * This module parses statusLine payloads and maintains a hot in-memory `AgyQuotaStore`
 * so Happy Agy Adapter prioritizes real-time `statusLine.quota` over guessing or injecting
 * usage into stream-json.
 */

export interface ModelQuotaInfo {
  modelId: string;
  label: string;
  remainingFraction?: number; // 0.0 ~ 1.0 (1.0 = 100% remaining)
  usedPercentage?: number;    // 0 ~ 100
  resetTime?: string;         // ISO timestamp
  resetsInMinutes?: number;
  resetsInFormatted?: string;
  maxTokens?: number;
  isRecommended?: boolean;
}

export interface AgyUsageStatus {
  accountName?: string;
  email?: string;
  planName?: string;
  teamsTier?: string;
  userTierName?: string;
  availableCredits?: Array<{ creditType: string; minimumCreditAmountForUsage?: string }>;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
  models: ModelQuotaInfo[];
  groups?: Record<string, AgyQuotaGroup>;
  statusLineQuota?: AgyStatusLineQuota;
  fiveHourWindow?: {
    usedPercentage?: number;
    remainingPercentage?: number;
    resetsAt?: number;
    resetsInFormatted?: string;
  };
  sevenDayWindow?: {
    usedPercentage?: number;
    remainingPercentage?: number;
    resetsAt?: number;
    resetsInFormatted?: string;
  };
  source: 'statusline-hook' | 'language-server' | 'cloudcode-api' | 'none';
  error?: string;
}

/**
 * Format remaining minutes into human-readable countdown string.
 * e.g. 75 -> "1h 15m", 42 -> "42m", 0 -> "Now"
 */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return 'Now';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  return `${m}m`;
}

/**
 * Calculate minutes remaining until an ISO timestamp.
 */
export function getMinutesUntil(resetTimeStr?: string, now: number = Date.now()): number | undefined {
  if (!resetTimeStr) return undefined;
  try {
    const target = new Date(resetTimeStr).getTime();
    if (isNaN(target)) return undefined;
    const diffMs = target - now;
    return Math.max(0, Math.round(diffMs / 60000));
  } catch {
    return undefined;
  }
}

export interface AgyQuotaWindow {
  /** Remaining percentage (0 ~ 100) */
  percentage?: number;
  /** Remaining fraction (0.0 ~ 1.0) */
  remainingFraction?: number;
  /** Used percentage (0 ~ 100) */
  usedPercentage?: number;
  /** ISO timestamp for quota reset */
  resetTime?: string;
  /** Seconds remaining until reset */
  resetInSeconds?: number;
  /** Minutes remaining until reset */
  resetsInMinutes?: number;
  /** Human-readable formatted countdown (e.g. "3h 45m", "Now") */
  resetsInFormatted?: string;
}

export interface AgyQuotaGroup {
  name: string;
  fiveHour?: AgyQuotaWindow;
  weekly?: AgyQuotaWindow;
}

export interface AgyStatusLineQuota {
  gemini?: AgyQuotaGroup;
  claude?: AgyQuotaGroup;
  models?: ModelQuotaInfo[];
  raw?: Record<string, unknown>;
  updatedAt: number;
}

export interface AgyStatusLinePayload {
  cwd?: string;
  conversation_id?: string | null;
  model?: string | { id?: string; displayName?: string; [key: string]: unknown };
  quota?: Record<string, unknown>;
  context_window?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parses a quota window object (e.g. five_hour, weekly).
 */
export function parseQuotaWindow(rawWindow: any, now = Date.now()): AgyQuotaWindow | undefined {
  if (!rawWindow || typeof rawWindow !== 'object') {
    if (typeof rawWindow === 'number') {
      // Direct percentage or fraction number
      const pct = rawWindow <= 1.0 ? Math.round(rawWindow * 100) : Math.round(rawWindow);
      const frac = rawWindow <= 1.0 ? rawWindow : rawWindow / 100;
      return {
        percentage: pct,
        remainingFraction: frac,
        usedPercentage: Math.max(0, 100 - pct),
      };
    }
    return undefined;
  }

  let remainingFraction: number | undefined = undefined;
  let percentage: number | undefined = undefined;
  let usedPercentage: number | undefined = undefined;

  if (typeof rawWindow.remaining_fraction === 'number') {
    const frac: number = rawWindow.remaining_fraction;
    remainingFraction = frac;
    percentage = Math.round(frac * 100);
    usedPercentage = Math.max(0, 100 - percentage);
  } else if (typeof rawWindow.remainingFraction === 'number') {
    const frac: number = rawWindow.remainingFraction;
    remainingFraction = frac;
    percentage = Math.round(frac * 100);
    usedPercentage = Math.max(0, 100 - percentage);
  } else if (typeof rawWindow.percentage === 'number') {
    const pct: number = rawWindow.percentage;
    percentage = Math.round(pct);
    remainingFraction = percentage / 100;
    usedPercentage = Math.max(0, 100 - percentage);
  } else if (typeof rawWindow.remaining_percentage === 'number') {
    const pct: number = rawWindow.remaining_percentage;
    percentage = Math.round(pct);
    remainingFraction = percentage / 100;
    usedPercentage = Math.max(0, 100 - percentage);
  } else if (typeof rawWindow.used_percentage === 'number') {
    const usedPct: number = rawWindow.used_percentage;
    usedPercentage = Math.round(usedPct);
    percentage = Math.max(0, 100 - usedPercentage);
    remainingFraction = percentage / 100;
  } else if (typeof rawWindow.usedPercentage === 'number') {
    const usedPct: number = rawWindow.usedPercentage;
    usedPercentage = Math.round(usedPct);
    percentage = Math.max(0, 100 - usedPercentage);
    remainingFraction = percentage / 100;
  }

  const resetTime: string | undefined =
    rawWindow.reset_time ||
    rawWindow.resetTime ||
    rawWindow.resets_at ||
    rawWindow.resetsAt;

  let resetInSeconds: number | undefined =
    typeof rawWindow.reset_in_seconds === 'number'
      ? rawWindow.reset_in_seconds
      : typeof rawWindow.resetInSeconds === 'number'
      ? rawWindow.resetInSeconds
      : undefined;

  let resetsInMinutes: number | undefined =
    typeof rawWindow.resets_in_minutes === 'number'
      ? rawWindow.resets_in_minutes
      : typeof rawWindow.resetsInMinutes === 'number'
      ? rawWindow.resetsInMinutes
      : undefined;

  if (resetsInMinutes === undefined && resetInSeconds !== undefined) {
    resetsInMinutes = Math.max(0, Math.round(resetInSeconds / 60));
  } else if (resetsInMinutes === undefined && resetTime) {
    resetsInMinutes = getMinutesUntil(resetTime, now);
  }

  let resetsInFormatted: string | undefined = rawWindow.resets_in_formatted || rawWindow.resetsInFormatted;
  if (!resetsInFormatted && resetsInMinutes !== undefined) {
    resetsInFormatted = formatCountdown(resetsInMinutes);
  }

  return {
    percentage,
    remainingFraction,
    usedPercentage,
    resetTime,
    resetInSeconds,
    resetsInMinutes,
    resetsInFormatted,
  };
}

/**
 * Parses a quota category/group (e.g. Gemini, Claude/GPT).
 */
export function parseQuotaGroup(name: string, rawGroup: any, now = Date.now()): AgyQuotaGroup | undefined {
  if (!rawGroup || typeof rawGroup !== 'object') {
    return undefined;
  }

  const fiveHourRaw =
    rawGroup.five_hour ??
    rawGroup['5h'] ??
    rawGroup.fiveHour ??
    rawGroup.five_hours ??
    rawGroup.fiveHourWindow;

  const weeklyRaw =
    rawGroup.weekly ??
    rawGroup['7d'] ??
    rawGroup.weeklyWindow ??
    rawGroup.seven_day ??
    rawGroup.sevenDay;

  const fiveHour = parseQuotaWindow(fiveHourRaw, now);
  const weekly = parseQuotaWindow(weeklyRaw, now);

  if (!fiveHour && !weekly) {
    return undefined;
  }

  return {
    name,
    fiveHour,
    weekly,
  };
}

/**
 * Parses the raw `quota` object from Agy statusLine payload into structured AgyStatusLineQuota.
 */
export function parseStatusLineQuota(rawQuota: any, now = Date.now()): AgyStatusLineQuota | null {
  if (!rawQuota || typeof rawQuota !== 'object') {
    return null;
  }

  const geminiRaw = rawQuota.gemini ?? rawQuota.Gemini ?? rawQuota.google;
  const claudeRaw =
    rawQuota.claude ??
    rawQuota.Claude ??
    rawQuota['claude/gpt'] ??
    rawQuota.claude_gpt ??
    rawQuota.gpt ??
    rawQuota.GPT ??
    rawQuota.anthropic;

  const gemini = parseQuotaGroup('Gemini', geminiRaw, now);
  const claude = parseQuotaGroup('Claude / GPT', claudeRaw, now);

  // If models list or map is directly present inside quota
  const models: ModelQuotaInfo[] = [];
  const rawModels = rawQuota.models;
  if (Array.isArray(rawModels)) {
    for (const m of rawModels) {
      if (!m) continue;
      const modelId = m.modelId || m.model_id || m.id || m.label || 'unknown';
      const label = m.label || m.displayName || m.modelId || modelId;
      const window = parseQuotaWindow(m.quotaInfo || m.quota || m, now);
      models.push({
        modelId,
        label,
        remainingFraction: window?.remainingFraction,
        usedPercentage: window?.usedPercentage,
        resetTime: window?.resetTime,
        resetsInMinutes: window?.resetsInMinutes,
        resetsInFormatted: window?.resetsInFormatted,
        isRecommended: m.isRecommended ?? m.recommended,
      });
    }
  }

  if (!gemini && !claude && models.length === 0) {
    // Check if flat top-level five_hour or weekly is present
    const topFiveHour = parseQuotaWindow(rawQuota.five_hour ?? rawQuota['5h'] ?? rawQuota.fiveHour, now);
    const topWeekly = parseQuotaWindow(rawQuota.weekly ?? rawQuota['7d'] ?? rawQuota.weeklyWindow, now);
    if (topFiveHour || topWeekly) {
      return {
        gemini: {
          name: 'Gemini',
          fiveHour: topFiveHour,
          weekly: topWeekly,
        },
        raw: rawQuota,
        updatedAt: now,
      };
    }
    return null;
  }

  return {
    gemini,
    claude,
    models: models.length > 0 ? models : undefined,
    raw: rawQuota,
    updatedAt: now,
  };
}

/**
 * Parses complete Agy statusLine JSON payload.
 */
export function parseStatusLinePayload(
  raw: string | Record<string, unknown>,
  now = Date.now(),
): { payload: AgyStatusLinePayload; quota: AgyStatusLineQuota | null } | null {
  let payload: AgyStatusLinePayload;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) {
      return null;
    }
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return null;
    }
  } else if (raw && typeof raw === 'object') {
    payload = raw as AgyStatusLinePayload;
  } else {
    return null;
  }

  const quota = payload.quota ? parseStatusLineQuota(payload.quota, now) : null;
  return {
    payload,
    quota,
  };
}

/**
 * Agy Quota Store (Singleton & Instance)
 *
 * Holds the latest live quota state received from Agy statusLine hooks.
 */
export class AgyQuotaStore {
  private static instance: AgyQuotaStore | null = null;
  private currentQuota: AgyStatusLineQuota | null = null;
  private readonly listeners = new Set<(quota: AgyStatusLineQuota) => void>();

  static getInstance(): AgyQuotaStore {
    if (!AgyQuotaStore.instance) {
      AgyQuotaStore.instance = new AgyQuotaStore();
    }
    return AgyQuotaStore.instance;
  }

  static resetInstance(): void {
    if (AgyQuotaStore.instance) {
      AgyQuotaStore.instance.clear();
      AgyQuotaStore.instance = null;
    }
  }

  getQuota(): AgyStatusLineQuota | null {
    return this.currentQuota;
  }

  hasQuota(): boolean {
    return this.currentQuota !== null;
  }

  clear(): void {
    this.currentQuota = null;
    this.listeners.clear();
  }

  update(payloadOrRaw: string | Record<string, unknown>, now = Date.now()): boolean {
    const parsed = parseStatusLinePayload(payloadOrRaw, now);
    if (parsed?.quota) {
      this.currentQuota = parsed.quota;
      for (const listener of this.listeners) {
        try {
          listener(parsed.quota);
        } catch {
          // ignore listener errors
        }
      }
      return true;
    }
    return false;
  }

  subscribe(listener: (quota: AgyStatusLineQuota) => void): () => void {
    this.listeners.add(listener);
    if (this.currentQuota) {
      try {
        listener(this.currentQuota);
      } catch {
        // ignore
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Converts the current statusLine quota to standard AgyUsageStatus.
   */
  toUsageStatus(): AgyUsageStatus | null {
    if (!this.currentQuota) {
      return null;
    }

    const models: ModelQuotaInfo[] = [];

    if (this.currentQuota.models && this.currentQuota.models.length > 0) {
      models.push(...this.currentQuota.models);
    } else {
      if (this.currentQuota.gemini?.fiveHour) {
        models.push({
          modelId: 'gemini-5h-window',
          label: 'Gemini (5h Window)',
          remainingFraction: this.currentQuota.gemini.fiveHour.remainingFraction,
          usedPercentage: this.currentQuota.gemini.fiveHour.usedPercentage,
          resetTime: this.currentQuota.gemini.fiveHour.resetTime,
          resetsInMinutes: this.currentQuota.gemini.fiveHour.resetsInMinutes,
          resetsInFormatted: this.currentQuota.gemini.fiveHour.resetsInFormatted,
        });
      }
      if (this.currentQuota.gemini?.weekly) {
        models.push({
          modelId: 'gemini-weekly-window',
          label: 'Gemini (Weekly Window)',
          remainingFraction: this.currentQuota.gemini.weekly.remainingFraction,
          usedPercentage: this.currentQuota.gemini.weekly.usedPercentage,
          resetTime: this.currentQuota.gemini.weekly.resetTime,
          resetsInMinutes: this.currentQuota.gemini.weekly.resetsInMinutes,
          resetsInFormatted: this.currentQuota.gemini.weekly.resetsInFormatted,
        });
      }
      if (this.currentQuota.claude?.fiveHour) {
        models.push({
          modelId: 'claude-5h-window',
          label: 'Claude / GPT (5h Window)',
          remainingFraction: this.currentQuota.claude.fiveHour.remainingFraction,
          usedPercentage: this.currentQuota.claude.fiveHour.usedPercentage,
          resetTime: this.currentQuota.claude.fiveHour.resetTime,
          resetsInMinutes: this.currentQuota.claude.fiveHour.resetsInMinutes,
          resetsInFormatted: this.currentQuota.claude.fiveHour.resetsInFormatted,
        });
      }
      if (this.currentQuota.claude?.weekly) {
        models.push({
          modelId: 'claude-weekly-window',
          label: 'Claude / GPT (Weekly Window)',
          remainingFraction: this.currentQuota.claude.weekly.remainingFraction,
          usedPercentage: this.currentQuota.claude.weekly.usedPercentage,
          resetTime: this.currentQuota.claude.weekly.resetTime,
          resetsInMinutes: this.currentQuota.claude.weekly.resetsInMinutes,
          resetsInFormatted: this.currentQuota.claude.weekly.resetsInFormatted,
        });
      }
    }

    const groups: Record<string, AgyQuotaGroup> = {};
    if (this.currentQuota.gemini) {
      groups.gemini = this.currentQuota.gemini;
    }
    if (this.currentQuota.claude) {
      groups.claude = this.currentQuota.claude;
    }

    return {
      planName: 'Google AI Pro',
      models,
      groups,
      statusLineQuota: this.currentQuota,
      fiveHourWindow: this.currentQuota.gemini?.fiveHour
        ? {
            remainingPercentage: this.currentQuota.gemini.fiveHour.percentage,
            usedPercentage: this.currentQuota.gemini.fiveHour.usedPercentage,
            resetsInFormatted: this.currentQuota.gemini.fiveHour.resetsInFormatted,
          }
        : undefined,
      sevenDayWindow: this.currentQuota.gemini?.weekly
        ? {
            remainingPercentage: this.currentQuota.gemini.weekly.percentage,
            usedPercentage: this.currentQuota.gemini.weekly.usedPercentage,
            resetsInFormatted: this.currentQuota.gemini.weekly.resetsInFormatted,
          }
        : undefined,
      source: 'statusline-hook',
    };
  }
}
