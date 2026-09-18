/**
 * agy Engine Selection
 *
 * Two backends coexist (see docs/features/agy-engines.md):
 *   - stream-json: persistent single-process engine driving agy's
 *     `--input-format stream-json` NDJSON protocol (default).
 *   - legacy: the original per-turn `agy --print` backend (src/agyLegacy).
 *   - sdk: optional Python SDK bridge engine (requires the
 *     google-antigravity package; only when an API key is configured).
 *
 * Resolution order: explicit CLI flag > HAPPY_AGY_ENGINE env >
 * settings.json agyEngine > default ('stream-json'). Invalid values fall
 * through to the next level. 'cli' is accepted as an alias for
 * 'stream-json' for compatibility with the original HAPPY_AGY_ENGINE
 * vocabulary (sdk|cli).
 */

export type AgyEngine = 'legacy' | 'stream-json' | 'sdk';

export const DEFAULT_AGY_ENGINE: AgyEngine = 'stream-json';

export function parseAgyEngine(value: string | undefined | null): AgyEngine | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'legacy') {
    return 'legacy';
  }
  if (normalized === 'stream-json' || normalized === 'cli') {
    return 'stream-json';
  }
  if (normalized === 'sdk') {
    return 'sdk';
  }
  return null;
}

/**
 * Resolve which agy engine to run. Later arguments override earlier ones:
 * an invalid explicit value falls through to the environment, then to the
 * settings file, then to the default.
 */
export function resolveAgyEngine(
  explicit?: string,
  envValue?: string,
  settingsValue?: string,
): AgyEngine {
  return (
    parseAgyEngine(explicit) ??
    parseAgyEngine(envValue) ??
    parseAgyEngine(settingsValue) ??
    DEFAULT_AGY_ENGINE
  );
}
