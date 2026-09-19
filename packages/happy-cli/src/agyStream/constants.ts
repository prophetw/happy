/**
 * Agy (Antigravity CLI) Constants
 *
 * Centralized constants for the agy integration: the binary name, the available
 * model display names (from `agy models`), the default model, and the print-mode
 * timeout. agy is a plain-text streaming CLI, so there are no env-var-based API
 * keys or MCP wiring like the Gemini ACP integration.
 */

import os from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Default command name for the agy binary (looked up on PATH). */
export const AGY_BIN = 'agy';

/**
 * Find the installed agy executable.
 *
 * agy installs to `~/.local/bin`, which is frequently absent from a daemon's
 * PATH (launchd, or `happy daemon start` from a non-login shell), so spawning
 * the bare name fails with ENOENT even though agy is installed. Resolution order:
 *   1. `HAPPY_AGY_PATH` env override — an explicit absolute path to the binary.
 *   2. `agy` already resolvable on PATH (then spawn the bare name).
 *   3. `~/.local/bin/agy` — the Antigravity CLI installer's default location.
 *
 */
export function findAgyBin(): string | undefined {
  const override = process.env.HAPPY_AGY_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  // Already on PATH? Then the bare name is enough (and respects PATH ordering).
  try {
    const probe = process.platform === 'win32'
      ? `where ${AGY_BIN}`
      : `command -v ${AGY_BIN}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return AGY_BIN;
  } catch {
    // not on PATH — fall through to the known install location
  }

  const localBin = join(os.homedir(), '.local', 'bin', AGY_BIN);
  if (existsSync(localBin)) {
    return localBin;
  }

  return undefined;
}

/**
 * Resolve the agy executable to a spawnable command.
 *
 * Falls back to the bare command name when nothing matches, so the caller still
 * spawns and surfaces a clear ENOENT instead of silently doing nothing.
 */
export function resolveAgyBin(): string {
  return findAgyBin() ?? AGY_BIN;
}

/**
 * Model display names accepted by `agy --model`, as printed by `agy models`.
 * agy expects the full display string, not a slug.
 * Older models (Gemini 3.1, 3.5, 3.6) are retired to keep the selection clean.
 */
export const AGY_MODELS = [
  'Gemini 3.8 Flash (High)',
  'Gemini 3.8 Flash (Medium)',
  'Gemini 3.8 Flash (Low)',
  'Gemini 3.7 Flash (High)',
  'Gemini 3.7 Flash (Medium)',
  'Gemini 3.7 Flash (Low)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)',
  'GPT-OSS 120B (Medium)',
] as const;

/**
 * Retired agy models that are filtered from discovery and pickers to keep menus concise.
 */
export const RETIRED_AGY_MODELS: ReadonlySet<string> = new Set([
  'Gemini 3.6 Flash (High)',
  'Gemini 3.6 Flash (Medium)',
  'Gemini 3.6 Flash (Low)',
  'Gemini 3.5 Flash (High)',
  'Gemini 3.5 Flash (Medium)',
  'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.1 Pro (Low)',
]);

export function isRetiredAgyModel(name: string): boolean {
  if (RETIRED_AGY_MODELS.has(name)) return true;
  return /gemini\s*3\.[156]/i.test(name) || /gemini-3\.[156]/i.test(name);
}

/**
 * Base name of the Gemini 3.8 Flash family in `agy models`. agy's catalog only
 * lists the effort-suffixed variants; Happy's app picker sends this base name
 * together with an effort level, which resolveAgyModelSelection combines.
 */
export const AGY_GEMINI_3_8_FLASH_MODEL = 'Gemini 3.8 Flash';

export const AGY_EFFORTS = ['low', 'medium', 'high'] as const;
export type AgyEffort = typeof AGY_EFFORTS[number];

/**
 * Default agy model. A Gemini model on purpose: this backend exists as a fallback
 * for when Claude Code is rate-limited, so we should not default onto a Claude model.
 */
export const DEFAULT_AGY_MODEL = 'Gemini 3.8 Flash (High)';
export const DEFAULT_AGY_EFFORT: AgyEffort = 'high';

/**
 * Validate an effort level coming off the wire (message meta). Unknown values
 * and null/undefined (reset) fall back to the default effort.
 */
export function normalizeAgyEffort(effort: string | null | undefined): AgyEffort {
  return AGY_EFFORTS.includes(effort as AgyEffort)
    ? effort as AgyEffort
    : DEFAULT_AGY_EFFORT;
}

/** Timeout passed to `agy --print-timeout` for a single turn (default 60 minutes). */
export const AGY_PRINT_TIMEOUT = '60m';

/**
 * Path to agy's per-workspace conversation cache. agy records the most recent
 * conversation id for each cwd here; print mode does not echo the id, so this is
 * how we recover it for `--conversation`-based resume.
 */
export const AGY_CONVERSATIONS_CACHE = join(
  os.homedir(),
  '.gemini',
  'antigravity-cli',
  'cache',
  'last_conversations.json',
);
