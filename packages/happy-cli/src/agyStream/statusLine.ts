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

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

export interface AgyContextWindowInfo {
  conversationId?: string;
  sessionId?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  usedPercentage?: number;
  remainingPercentage?: number;
  currentUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
}

export interface AgyStatusLineQuota {
  gemini?: AgyQuotaGroup;
  claude?: AgyQuotaGroup;
  models?: ModelQuotaInfo[];
  contextWindow?: AgyContextWindowInfo;
  accountName?: string;
  email?: string;
  planTier?: string;
  raw?: Record<string, unknown>;
  updatedAt: number;
}

export interface AgyStatusLinePayload {
  cwd?: string;
  conversation_id?: string | null;
  model?: string | { id?: string; displayName?: string; [key: string]: unknown };
  quota?: Record<string, unknown>;
  rate_limits?: Record<string, unknown>;
  context_window?: Record<string, unknown>;
  plan_tier?: string;
  email?: string;
  [key: string]: unknown;
}

/**
 * Parses a quota window object (e.g. five_hour, weekly, gemini-5h, 3p-5h).
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

  let resetTime: string | undefined =
    rawWindow.reset_time ||
    rawWindow.resetTime;

  // Handle resets_at unix timestamp (seconds or ms)
  const resetsAtRaw = rawWindow.resets_at || rawWindow.resetsAt;
  if (typeof resetsAtRaw === 'number' && resetsAtRaw > 0) {
    const epochMs = resetsAtRaw < 1e11 ? resetsAtRaw * 1000 : resetsAtRaw;
    if (!resetTime) {
      try {
        resetTime = new Date(epochMs).toISOString();
      } catch {
        // ignore
      }
    }
  }

  let resetInSeconds: number | undefined = undefined;
  let resetsInMinutes: number | undefined = undefined;

  // 1. 优先使用绝对时间戳（resetTime 或 resets_at），结合当前 now 动态计算真实剩余时间
  if (resetTime) {
    try {
      const target = new Date(resetTime).getTime();
      if (!isNaN(target)) {
        const diffMs = target - now;
        if (diffMs <= 0) {
          resetInSeconds = 0;
          resetsInMinutes = 0;
        } else {
          resetInSeconds = Math.round(diffMs / 1000);
          resetsInMinutes = Math.max(0, Math.round(diffMs / 60000));
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 若无绝对时间戳或解析失败，降级使用相对秒数/分钟数
  if (resetsInMinutes === undefined) {
    if (typeof rawWindow.resets_in_minutes === 'number') {
      resetsInMinutes = Math.max(0, rawWindow.resets_in_minutes);
      resetInSeconds = resetsInMinutes * 60;
    } else if (typeof rawWindow.resetsInMinutes === 'number') {
      resetsInMinutes = Math.max(0, rawWindow.resets_inMinutes);
      resetInSeconds = resetsInMinutes * 60;
    } else {
      const rawSec =
        typeof rawWindow.reset_in_seconds === 'number'
          ? rawWindow.reset_in_seconds
          : typeof rawWindow.resetInSeconds === 'number'
          ? rawWindow.resetInSeconds
          : undefined;
      if (rawSec !== undefined) {
        resetInSeconds = Math.max(0, rawSec);
        resetsInMinutes = Math.max(0, Math.round(resetInSeconds / 60));
      }
    }
  }

  let resetsInFormatted: string | undefined = rawWindow.resets_in_formatted || rawWindow.resetsInFormatted;
  if (resetsInMinutes !== undefined) {
    if (resetsInMinutes <= 0) {
      resetsInFormatted = 'Now';
    } else if (!resetsInFormatted || resetTime) {
      // 当存在 resetTime 时，必须以动态计算的倒计时为准，防止静态快照的旧格式化字符串（如 1h 06m）污染
      resetsInFormatted = formatCountdown(resetsInMinutes);
    }
  }

  if (percentage === undefined && remainingFraction === undefined && usedPercentage === undefined) {
    return undefined;
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
 * Parses the raw `quota` object or full payload from Agy statusLine into structured AgyStatusLineQuota.
 */
export function parseStatusLineQuota(rawQuotaOrPayload: any, now = Date.now()): AgyStatusLineQuota | null {
  if (!rawQuotaOrPayload || typeof rawQuotaOrPayload !== 'object') {
    return null;
  }

  const rawQuota = rawQuotaOrPayload.quota || rawQuotaOrPayload.rate_limits || rawQuotaOrPayload;
  const rateLimits = rawQuotaOrPayload.rate_limits;

  // 1. Native Agy statusline keys: gemini-5h, gemini-weekly, 3p-5h, 3p-weekly
  const gemini5h = parseQuotaWindow(
    rawQuota['gemini-5h'] ??
      rawQuota['gemini_5h'] ??
      rawQuota.gemini?.five_hour ??
      rawQuota.gemini?.['5h'] ??
      rawQuota.gemini?.fiveHour ??
      rateLimits?.five_hour,
    now,
  );

  const geminiWeekly = parseQuotaWindow(
    rawQuota['gemini-weekly'] ??
      rawQuota['gemini_weekly'] ??
      rawQuota.gemini?.weekly ??
      rawQuota.gemini?.['7d'] ??
      rawQuota.gemini?.weeklyWindow ??
      rateLimits?.seven_day,
    now,
  );

  const claude5h = parseQuotaWindow(
    rawQuota['3p-5h'] ??
      rawQuota['3p_5h'] ??
      rawQuota['claude-5h'] ??
      rawQuota['claude_5h'] ??
      rawQuota.claude?.five_hour ??
      rawQuota.claude?.['5h'] ??
      rawQuota['claude/gpt']?.five_hour ??
      rawQuota.gpt?.five_hour,
    now,
  );

  const claudeWeekly = parseQuotaWindow(
    rawQuota['3p-weekly'] ??
      rawQuota['3p_weekly'] ??
      rawQuota['claude-weekly'] ??
      rawQuota['claude_weekly'] ??
      rawQuota.claude?.weekly ??
      rawQuota.claude?.['7d'] ??
      rawQuota['claude/gpt']?.weekly ??
      rawQuota.gpt?.weekly,
    now,
  );

  let gemini: AgyQuotaGroup | undefined = undefined;
  if (gemini5h || geminiWeekly) {
    gemini = {
      name: 'Gemini',
      fiveHour: gemini5h,
      weekly: geminiWeekly,
    };
  }

  let claude: AgyQuotaGroup | undefined = undefined;
  if (claude5h || claudeWeekly) {
    claude = {
      name: 'Claude / GPT',
      fiveHour: claude5h,
      weekly: claudeWeekly,
    };
  }

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

  const email = rawQuotaOrPayload.email || rawQuota.email;
  const planTier = rawQuotaOrPayload.plan_tier || rawQuotaOrPayload.planTier || rawQuota.plan_tier || rawQuota.planTier;

  // 3. Context window usage (e.g. from agy statusline payload)
  let contextWindow: AgyContextWindowInfo | undefined;
  const rawCw = rawQuotaOrPayload.context_window || rawQuota.context_window;
  if (rawCw && typeof rawCw === 'object') {
    const pickCount = (keys: string[]) => {
      for (const k of keys) {
        const v = rawCw[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          return Math.trunc(v);
        }
      }
      return undefined;
    };
    const totalInput = pickCount(['total_input_tokens', 'totalInputTokens', 'input_tokens', 'inputTokens']);
    const totalOutput = pickCount(['total_output_tokens', 'totalOutputTokens', 'output_tokens', 'outputTokens']);
    const windowSize = pickCount(['context_window_size', 'contextWindowSize', 'max_tokens', 'maxTokens', 'total_tokens']);
    const usedPct = typeof rawCw.used_percentage === 'number'
      ? rawCw.used_percentage
      : (typeof rawCw.usedPercentage === 'number' ? rawCw.usedPercentage : undefined);
    const remPct = typeof rawCw.remaining_percentage === 'number'
      ? rawCw.remaining_percentage
      : (typeof rawCw.remainingPercentage === 'number' ? rawCw.remainingPercentage : undefined);

    let currentUsage: AgyContextWindowInfo['currentUsage'] = undefined;
    if (rawCw.current_usage && typeof rawCw.current_usage === 'object') {
      const cu = rawCw.current_usage as Record<string, unknown>;
      const pickCu = (keys: string[]) => {
        for (const k of keys) {
          const v = cu[k];
          if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v);
        }
        return undefined;
      };
      currentUsage = {
        inputTokens: pickCu(['input_tokens', 'inputTokens']),
        outputTokens: pickCu(['output_tokens', 'outputTokens']),
        cacheCreationInputTokens: pickCu(['cache_creation_input_tokens', 'cacheCreationInputTokens']),
        cacheReadInputTokens: pickCu(['cache_read_input_tokens', 'cacheReadInputTokens']),
      };
    }

    const conversationId =
      (typeof rawCw.conversation_id === 'string' ? rawCw.conversation_id : undefined) ||
      (typeof rawCw.conversationId === 'string' ? rawCw.conversationId : undefined) ||
      (typeof rawQuotaOrPayload.conversation_id === 'string' ? rawQuotaOrPayload.conversation_id : undefined) ||
      (typeof rawQuotaOrPayload.conversationId === 'string' ? rawQuotaOrPayload.conversationId : undefined);
    const sessionId =
      (typeof rawCw.session_id === 'string' ? rawCw.session_id : undefined) ||
      (typeof rawCw.sessionId === 'string' ? rawCw.sessionId : undefined) ||
      (typeof rawQuotaOrPayload.session_id === 'string' ? rawQuotaOrPayload.session_id : undefined) ||
      (typeof rawQuotaOrPayload.sessionId === 'string' ? rawQuotaOrPayload.sessionId : undefined);

    if (totalInput !== undefined || totalOutput !== undefined || windowSize !== undefined || usedPct !== undefined) {
      contextWindow = {
        conversationId,
        sessionId,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        contextWindowSize: windowSize,
        usedPercentage: usedPct,
        remainingPercentage: remPct,
        currentUsage,
      };
    }
  }

  if (!gemini && !claude && models.length === 0) {
    const topFiveHour = parseQuotaWindow(rawQuota.five_hour ?? rawQuota['5h'] ?? rawQuota.fiveHour, now);
    const topWeekly = parseQuotaWindow(rawQuota.weekly ?? rawQuota['7d'] ?? rawQuota.weeklyWindow, now);
    if (topFiveHour || topWeekly || contextWindow) {
      return {
        gemini: topFiveHour || topWeekly ? {
          name: 'Gemini',
          fiveHour: topFiveHour,
          weekly: topWeekly,
        } : undefined,
        contextWindow,
        email,
        planTier,
        raw: rawQuotaOrPayload,
        updatedAt: now,
      };
    }
    return null;
  }

  return {
    gemini,
    claude,
    models: models.length > 0 ? models : undefined,
    contextWindow,
    email,
    planTier,
    raw: rawQuotaOrPayload,
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

  const quota = parseStatusLineQuota(payload, now);
  return {
    payload,
    quota,
  };
}

/**
 * Agy Quota Store (Singleton & Instance)
 *
 * Holds the latest live quota state received from Agy statusLine hooks and files.
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
  /**
   * Check whether current quota is fresh (updated within maxAgeMs, default 5 minutes).
   */
  isFresh(maxAgeMs = 5 * 60 * 1000, now = Date.now()): boolean {
    if (!this.currentQuota) return false;
    return now - this.currentQuota.updatedAt < maxAgeMs;
  }

  getQuota(loadFromDisk = true, maxAgeMs?: number, now = Date.now()): AgyStatusLineQuota | null {
    if (this.currentQuota) {
      if (maxAgeMs !== undefined && !this.isFresh(maxAgeMs, now)) {
        if (loadFromDisk) {
          this.loadFromFile(undefined, now, maxAgeMs);
          if (this.currentQuota && this.isFresh(maxAgeMs, now)) {
            return this.currentQuota;
          }
        }
        return null;
      }
      return this.currentQuota;
    }

    if (loadFromDisk) {
      this.loadFromFile(undefined, now, maxAgeMs ?? 24 * 3600 * 1000);
    }
    return this.currentQuota;
  }

  hasQuota(loadFromDisk = true, maxAgeMs?: number): boolean {
    return this.getQuota(loadFromDisk, maxAgeMs) !== null;
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

  /**
   * Attempts to load quota state from local statusline files.
   * By default maxAgeMs is 5 minutes to avoid stale cache hijacking fresh RPCs.
   */
  loadFromFile(customPath?: string, now = Date.now(), maxAgeMs = 5 * 60 * 1000): boolean {
    const candidatePaths = customPath !== undefined
      ? (customPath ? [customPath] : [])
      : [
          path.join(os.homedir(), '.gemini/antigravity-cli/statusline-state.json'),
          path.join(os.homedir(), '.config/gemini/statusline-state.json'),
          path.join(os.homedir(), '.happy/agy-statusline.json'),
        ];

    for (const filePath of candidatePaths) {
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          // Only load if updated within maxAgeMs
          if (now - stats.mtimeMs < maxAgeMs) {
            const raw = fs.readFileSync(filePath, 'utf8').trim();
            if (raw.startsWith('{')) {
              const parsed = parseStatusLinePayload(raw, now);
              if (parsed?.quota) {
                parsed.quota.updatedAt = stats.mtimeMs;
                const isChanged = JSON.stringify(this.currentQuota) !== JSON.stringify(parsed.quota);
                this.currentQuota = parsed.quota;
                if (isChanged) {
                  for (const listener of this.listeners) {
                    try {
                      listener(parsed.quota);
                    } catch {
                      // ignore listener errors
                    }
                  }
                }
                return true;
              }
            }
          }
        } catch {
          // ignore read error
        }
      }
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
  toUsageStatus(loadFromDisk = true, maxAgeMs?: number, now = Date.now()): AgyUsageStatus | null {
    const quota = this.getQuota(loadFromDisk, maxAgeMs, now);
    if (!quota) {
      return null;
    }

    const models: ModelQuotaInfo[] = [];

    if (quota.models && quota.models.length > 0) {
      models.push(...quota.models);
    } else {
      if (quota.gemini?.fiveHour) {
        models.push({
          modelId: 'gemini-5h-window',
          label: 'Gemini (5h Window)',
          remainingFraction: quota.gemini.fiveHour.remainingFraction,
          usedPercentage: quota.gemini.fiveHour.usedPercentage,
          resetTime: quota.gemini.fiveHour.resetTime,
          resetsInMinutes: quota.gemini.fiveHour.resetsInMinutes,
          resetsInFormatted: quota.gemini.fiveHour.resetsInFormatted,
        });
      }
      if (quota.gemini?.weekly) {
        models.push({
          modelId: 'gemini-weekly-window',
          label: 'Gemini (Weekly Window)',
          remainingFraction: quota.gemini.weekly.remainingFraction,
          usedPercentage: quota.gemini.weekly.usedPercentage,
          resetTime: quota.gemini.weekly.resetTime,
          resetsInMinutes: quota.gemini.weekly.resetsInMinutes,
          resetsInFormatted: quota.gemini.weekly.resetsInFormatted,
        });
      }
      if (quota.claude?.fiveHour) {
        models.push({
          modelId: 'claude-5h-window',
          label: 'Claude / GPT (5h Window)',
          remainingFraction: quota.claude.fiveHour.remainingFraction,
          usedPercentage: quota.claude.fiveHour.usedPercentage,
          resetTime: quota.claude.fiveHour.resetTime,
          resetsInMinutes: quota.claude.fiveHour.resetsInMinutes,
          resetsInFormatted: quota.claude.fiveHour.resetsInFormatted,
        });
      }
      if (quota.claude?.weekly) {
        models.push({
          modelId: 'claude-weekly-window',
          label: 'Claude / GPT (Weekly Window)',
          remainingFraction: quota.claude.weekly.remainingFraction,
          usedPercentage: quota.claude.weekly.usedPercentage,
          resetTime: quota.claude.weekly.resetTime,
          resetsInMinutes: quota.claude.weekly.resetsInMinutes,
          resetsInFormatted: quota.claude.weekly.resetsInFormatted,
        });
      }
    }

    const groups: Record<string, AgyQuotaGroup> = {};
    if (quota.gemini) {
      groups.gemini = quota.gemini;
    }
    if (quota.claude) {
      groups.claude = quota.claude;
    }

    return {
      email: quota.email,
      planName: quota.planTier || 'Google AI Pro',
      userTierName: quota.planTier || 'Google AI Pro',
      models,
      groups,
      statusLineQuota: quota,
      fiveHourWindow: quota.gemini?.fiveHour
        ? {
            remainingPercentage: quota.gemini.fiveHour.percentage,
            usedPercentage: quota.gemini.fiveHour.usedPercentage,
            resetsInFormatted: quota.gemini.fiveHour.resetsInFormatted,
          }
        : undefined,
      sevenDayWindow: quota.gemini?.weekly
        ? {
            remainingPercentage: quota.gemini.weekly.percentage,
            usedPercentage: quota.gemini.weekly.usedPercentage,
            resetsInFormatted: quota.gemini.weekly.resetsInFormatted,
          }
        : undefined,
      source: 'statusline-hook',
    };
  }
}
