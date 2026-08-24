/**
 * Antigravity (agy) Usage and Quota Fetcher
 *
 * Queries quota and rate limits for Antigravity (agy):
 * 1. Primary: Probes local running Antigravity Language Server (LanguageServerService/GetUserStatus)
 * 2. Fallback: Calls Google Cloud Code API (https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels)
 *
 * Surfaces 5-hour rolling window quota, weekly quota/tier, per-model remaining fractions,
 * and reset countdowns.
 */

import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';

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
  source: 'language-server' | 'cloudcode-api' | 'none';
  error?: string;
}

export interface FetchAgyUsageOptions {
  tokenPath?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  execSyncFn?: typeof execSync;
  execFileSyncFn?: typeof execFileSync;
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

/**
 * Extract OAuth access token from local Antigravity credentials file.
 */
export function getStoredAgyOAuthToken(customPath?: string): string | null {
  const tokenPaths = customPath !== undefined
    ? (customPath ? [customPath] : [])
    : [
        path.join(os.homedir(), '.gemini/antigravity-cli/antigravity-oauth-token'),
        path.join(os.homedir(), '.config/gemini/antigravity-oauth-token'),
      ];

  for (const tokenPath of tokenPaths) {
    if (fs.existsSync(tokenPath)) {
      try {
        const raw = fs.readFileSync(tokenPath, 'utf8').trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
        if (parsed.token?.access_token) return parsed.token.access_token;
        if (parsed.access_token) return parsed.access_token;
        if (parsed.token && typeof parsed.token === 'string') return parsed.token;
      } catch {
        // Ignore read/parse error
      }
    }
  }
  return null;
}

/**
 * Discover running Language Server processes, parse listening port & CSRF token,
 * and fetch GetUserStatus.
 */
export function fetchFromLanguageServer(
  opts: FetchAgyUsageOptions = {},
): AgyUsageStatus | null {
  const log = opts.log ?? (() => {});
  const execSyncFn = opts.execSyncFn ?? execSync;
  const execFileSyncFn = opts.execFileSyncFn ?? execFileSync;
  const timeoutMs = opts.timeoutMs ?? 3000;

  try {
    let psOutput = '';
    try {
      psOutput = execSyncFn('ps aux', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }

    const lines = psOutput
      .split('\n')
      .filter((l) => l.includes('language_server') && l.includes('csrf_token'));

    for (const line of lines) {
      const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
      const csrfMatch = line.match(/--csrf_token\s+([^\s]+)/);
      if (!pidMatch || !csrfMatch) continue;

      const pid = pidMatch[1];
      const csrfToken = csrfMatch[1];

      // Find listening TCP ports for this PID
      let portMatches: string[] = [];
      try {
        const lsofOutput = execSyncFn(`lsof -Pan -p ${pid} -i -sTCP:LISTEN`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        portMatches = [...lsofOutput.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map((m) => m[1]);
      } catch {
        // If lsof fails, try extracting --extension_server_port from command line
        const extPortMatch = line.match(/--extension_server_port\s+(\d+)/);
        if (extPortMatch) {
          portMatches = [extPortMatch[1]];
        }
      }

      for (const port of portMatches) {
        try {
          const res = execFileSyncFn(
            'curl',
            [
              '-s',
              '--max-time',
              String(Math.max(1, Math.round(timeoutMs / 1000))),
              '-X',
              'POST',
              `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
              '-H',
              'Content-Type: application/json',
              '-H',
              `X-Codeium-Csrf-Token: ${csrfToken}`,
              '-d',
              JSON.stringify({
                metadata: {
                  ideName: 'antigravity',
                  extensionName: 'antigravity',
                  locale: 'en',
                },
              }),
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          );

          if (!res || !res.trim().startsWith('{')) continue;
          const json = JSON.parse(res);
          if (json?.userStatus) {
            log(`Successfully fetched user status from language server on port ${port}`);
            return parseLanguageServerUserStatus(json.userStatus);
          }
        } catch {
          // Continue trying next port
        }
      }
    }
  } catch (error) {
    log(`Language server lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return null;
}

/**
 * Parse GetUserStatus userStatus object into AgyUsageStatus.
 */
export function parseLanguageServerUserStatus(userStatus: any): AgyUsageStatus {
  const accountName = userStatus.name;
  const email = userStatus.email;
  const planName = userStatus.planStatus?.planInfo?.planName || userStatus.userTier?.name || 'Standard';
  const teamsTier = userStatus.planStatus?.planInfo?.teamsTier;
  const userTierName = userStatus.userTier?.name;
  const availableCredits = userStatus.userTier?.availableCredits;
  const availablePromptCredits = userStatus.planStatus?.availablePromptCredits;
  const availableFlowCredits = userStatus.planStatus?.availableFlowCredits;

  const rawConfigs =
    userStatus.cascadeModelConfigData?.clientModelConfigs ||
    userStatus.clientModelConfigs ||
    [];

  const models: ModelQuotaInfo[] = [];
  const now = Date.now();

  for (const m of rawConfigs) {
    if (!m) continue;
    const modelId = m.modelId || m.label;
    const label = m.label || m.modelId || 'Unknown Model';
    const remainingFraction = m.quotaInfo?.remainingFraction;
    const resetTime = m.quotaInfo?.resetTime;
    const minutes = getMinutesUntil(resetTime, now);

    models.push({
      modelId,
      label,
      remainingFraction,
      usedPercentage:
        typeof remainingFraction === 'number'
          ? Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)))
          : undefined,
      resetTime,
      resetsInMinutes: minutes,
      resetsInFormatted: minutes !== undefined ? formatCountdown(minutes) : undefined,
      isRecommended: m.isRecommended,
    });
  }

  return {
    accountName,
    email,
    planName,
    teamsTier,
    userTierName,
    availableCredits,
    availablePromptCredits,
    availableFlowCredits,
    models,
    source: 'language-server',
  };
}

/**
 * Fetch available models & quota from cloudcode-pa.googleapis.com.
 */
export function fetchFromCloudCodeApi(
  accessToken: string,
  opts: FetchAgyUsageOptions = {},
): AgyUsageStatus | null {
  const log = opts.log ?? (() => {});
  const execFileSyncFn = opts.execFileSyncFn ?? execFileSync;
  const timeoutMs = opts.timeoutMs ?? 5000;

  try {
    const raw = execFileSyncFn(
      'curl',
      [
        '-s',
        '--max-time',
        String(Math.max(1, Math.round(timeoutMs / 1000))),
        '-X',
        'POST',
        'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
        '-H',
        `Authorization: Bearer ${accessToken}`,
        '-H',
        'Content-Type: application/json',
        '-H',
        'User-Agent: AntigravityCLI/1.0',
        '-d',
        '{}',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );

    if (!raw || !raw.trim().startsWith('{')) return null;
    const parsed = JSON.parse(raw);
    if (parsed.error) {
      log(`CloudCode API returned error: ${JSON.stringify(parsed.error)}`);
      return null;
    }

    const models: ModelQuotaInfo[] = [];
    const now = Date.now();

    if (parsed.models && typeof parsed.models === 'object') {
      for (const [modelId, details] of Object.entries(parsed.models as Record<string, any>)) {
        const remainingFraction = details.quotaInfo?.remainingFraction;
        const resetTime = details.quotaInfo?.resetTime;
        const minutes = getMinutesUntil(resetTime, now);

        models.push({
          modelId,
          label: modelId,
          remainingFraction,
          usedPercentage:
            typeof remainingFraction === 'number'
              ? Math.max(0, Math.min(100, Math.round((1 - remainingFraction) * 100)))
              : undefined,
          resetTime,
          resetsInMinutes: minutes,
          resetsInFormatted: minutes !== undefined ? formatCountdown(minutes) : undefined,
          maxTokens: details.maxTokens,
          isRecommended: details.recommended,
        });
      }
    }

    return {
      planName: 'Google AI Pro',
      models,
      source: 'cloudcode-api',
    };
  } catch (error) {
    log(`CloudCode API request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Fetch Antigravity (agy) quota and usage status.
 * Combines language server probe and cloudcode API fallback.
 */
export async function fetchAgyUsage(opts: FetchAgyUsageOptions = {}): Promise<AgyUsageStatus> {
  const log = opts.log ?? (() => {});

  // 1. Try local language server
  const lsStatus = fetchFromLanguageServer(opts);
  if (lsStatus && lsStatus.models.length > 0) {
    return lsStatus;
  }

  // 2. Try Google Cloud Code API with stored token
  const token = getStoredAgyOAuthToken(opts.tokenPath);
  if (token) {
    const apiStatus = fetchFromCloudCodeApi(token, opts);
    if (apiStatus && apiStatus.models.length > 0) {
      return apiStatus;
    }
  }

  log('Could not retrieve agy usage from language server or CloudCode API');
  return {
    source: 'none',
    models: [],
    error: 'Antigravity language server is not running and no active OAuth token was found.',
  };
}

/**
 * Format AgyUsageStatus into a Markdown report for Happy chat/app.
 */
export function formatAgyUsageMarkdown(status: AgyUsageStatus): string {
  if (status.source === 'none' || status.models.length === 0) {
    return `### ⚠️ Antigravity (agy) Quota Unavailable\n\n${status.error || 'Unable to retrieve current usage quota. Ensure Antigravity CLI or IDE is logged in.'}`;
  }

  const lines: string[] = [];
  lines.push('### 📊 Antigravity (`agy`) 额度与用量');
  lines.push('');

  const details: string[] = [];
  if (status.accountName || status.email) {
    const acct = [status.accountName, status.email ? `(\`${status.email}\`)` : ''].filter(Boolean).join(' ');
    details.push(`- **账户**: ${acct}`);
  }
  if (status.userTierName || status.planName) {
    details.push(`- **套餐**: **${status.userTierName || status.planName}**`);
  }
  if (status.availableCredits && status.availableCredits.length > 0) {
    const creditsStr = status.availableCredits.map((c) => c.creditType).join(', ');
    details.push(`- **可用额度/积分**: ${creditsStr}`);
  }
  if (details.length > 0) {
    lines.push(...details);
    lines.push('');
  }

  lines.push('#### ⏳ 5 小时滚动额度 (5-Hour Rolling Quota)');
  lines.push('');
  lines.push('| 模型 (Model) | 剩余额度 | 已用比例 | 重置倒计时 (Reset In) |');
  lines.push('|:---|:---:|:---:|:---|');

  // Group or sort models for clean presentation
  const sortedModels = [...status.models].sort((a, b) => {
    const getScore = (m: ModelQuotaInfo) => {
      const name = m.label.toLowerCase();
      if (name.includes('3.7 flash (high)')) return 1;
      if (name.includes('3.7 flash')) return 2;
      if (name.includes('sonnet')) return 3;
      if (name.includes('opus')) return 4;
      if (name.includes('3.1 pro')) return 5;
      if (name.includes('3.6 flash')) return 6;
      if (name.includes('3.5 flash')) return 7;
      return 10;
    };
    return getScore(a) - getScore(b);
  });

  for (const m of sortedModels) {
    const icon = m.label.toLowerCase().includes('claude')
      ? '🔮'
      : m.label.toLowerCase().includes('pro')
      ? '🧠'
      : m.label.toLowerCase().includes('gpt')
      ? '🌐'
      : '⚡';

    let remStr = '未知';
    let usedStr = '未知';
    if (typeof m.remainingFraction === 'number') {
      const remPct = Math.round(m.remainingFraction * 100);
      remStr = remPct >= 80 ? `🟢 **${remPct}%**` : remPct >= 40 ? `🟡 **${remPct}%**` : `🔴 **${remPct}%**`;
      usedStr = `${100 - remPct}%`;
    }

    let resetStr = '-';
    if (m.resetsInFormatted) {
      resetStr = `↻ ${m.resetsInFormatted}`;
      if (m.resetTime) {
        try {
          const timePart = new Date(m.resetTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
          resetStr += ` (${timePart})`;
        } catch {
          // ignore
        }
      }
    }

    lines.push(`| ${icon} **${m.label}** | ${remStr} | ${usedStr} | ${resetStr} |`);
  }

  lines.push('');
  lines.push('> 💡 **提示**：Flash 与 Pro 模型各自拥有独立的 5 小时滚动额度池。当单模型额度用尽时，将在显示的时间自动刷新重置。');

  return lines.join('\n');
}

/**
 * Format AgyUsageStatus for CLI terminal display.
 */
export function formatAgyUsageTerminal(status: AgyUsageStatus): string {
  if (status.source === 'none' || status.models.length === 0) {
    return chalk.yellow(`⚠️ Antigravity (agy) quota unavailable: ${status.error || 'Check login status'}`);
  }

  const lines: string[] = [];
  lines.push(chalk.bold.cyan('📊 Antigravity (agy) Quota & Usage'));
  if (status.email) {
    lines.push(chalk.dim(`Account: ${status.email} | Plan: ${status.userTierName || status.planName || 'Standard'}`));
  }
  lines.push('');
  lines.push(chalk.bold('5-Hour Window Model Quotas:'));

  for (const m of status.models) {
    const remPct = typeof m.remainingFraction === 'number' ? Math.round(m.remainingFraction * 100) : 0;
    const color = remPct >= 80 ? chalk.green : remPct >= 40 ? chalk.yellow : chalk.red;
    const reset = m.resetsInFormatted ? chalk.dim(`(resets in ${m.resetsInFormatted})`) : '';
    lines.push(`  ${m.label.padEnd(32)} ${color(`${remPct}% remaining`.padEnd(16))} ${reset}`);
  }

  return lines.join('\n');
}
