/**
 * DeepSeek Harness (dsh) Constants
 *
 * Centralized constants for the dsh integration. dsh is spawned through its
 * ACP profile (`dsh --profile acp`), so there are no model slugs or print-mode
 * timeouts here — the ACP session config options carry the model catalog.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Default command name for the dsh binary (looked up on PATH). */
export const DSH_BIN = 'dsh';

/** Arguments that put dsh into ACP (JSON-RPC over stdio) mode. */
export const DSH_ACP_ARGS = ['--profile', 'acp'];

/**
 * Find the installed dsh executable.
 *
 * dsh ships as an npm package (`@deepseek-ai/dsh`) but is also commonly run
 * from a source checkout (`pnpm dsh`), so a bare `command -v` misses real
 * installs more often than the other harnesses. Resolution order:
 *   1. `HAPPY_DSH_PATH` env override — an explicit path to the binary/entry.
 *   2. `dsh` already resolvable on PATH (then spawn the bare name).
 */
export function findDshBin(): string | undefined {
  const override = process.env.HAPPY_DSH_PATH;
  if (override && existsSync(override)) {
    return override;
  }

  // Already on PATH? Then the bare name is enough (and respects PATH ordering).
  try {
    const probe = process.platform === 'win32'
      ? `where ${DSH_BIN}`
      : `command -v ${DSH_BIN}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return DSH_BIN;
  } catch {
    // not on PATH
  }

  return undefined;
}

/**
 * Resolve the dsh executable to a spawnable command.
 *
 * Falls back to the bare command name when nothing matches, so the caller still
 * spawns and surfaces a clear ENOENT instead of silently doing nothing.
 */
export function resolveDshBin(): string {
  return findDshBin() ?? DSH_BIN;
}
