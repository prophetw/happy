/**
 * Agy Model Discovery
 *
 * Dynamically queries `agy models` to discover available models supported by the
 * local Antigravity CLI installation, and transforms them into Happy Session metadata
 * models format:
 *   [
 *     { code: 'Gemini 3.8 Flash (High)', value: 'Gemini 3.8 Flash (High)', description: null },
 *     ...
 *   ]
 *
 * If `agy models` fails or is unavailable, falls back to the static AGY_MODELS list.
 */

import { execFile } from 'node:child_process';
import { AGY_GEMINI_3_8_FLASH_MODEL, AGY_MODELS, isRetiredAgyModel, normalizeAgyEffort, resolveAgyBin } from './constants';

export { isRetiredAgyModel } from './constants';

export interface DiscoveredModel {
  code: string;
  value: string;
  slug?: string;
  description?: string | null;
}

/**
 * Parse output from `agy models`.
 * Handles tab-separated (`<slug>\t<Display Name>`) and space-aligned formats,
 * strips ANSI escape codes and spinner text, and ignores headers/help text.
 */
export function parseAgyModelsOutput(output: string): DiscoveredModel[] {
  if (!output || typeof output !== 'string') {
    return [];
  }

  // Strip ANSI escape codes
  const cleaned = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const lines = cleaned.split('\n');
  const models: DiscoveredModel[] = [];
  const seenCodes = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip spinner / loading / header / help lines
    if (
      line.startsWith('Fetching') ||
      line.startsWith('Available') ||
      line.startsWith('Usage:') ||
      line.startsWith('Flags:') ||
      /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)
    ) {
      continue;
    }

    // Try splitting by tab first
    if (line.includes('\t')) {
      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const slug = parts[0];
        const displayName = parts[1];
        if (!isRetiredAgyModel(displayName) && !isRetiredAgyModel(slug)) {
          if (!seenCodes.has(displayName)) {
            seenCodes.add(displayName);
            models.push({
              code: displayName,
              value: displayName,
              slug,
              description: null,
            });
          }
        }
        continue;
      } else if (parts.length === 1) {
        const name = parts[0];
        if (!isRetiredAgyModel(name) && !seenCodes.has(name)) {
          seenCodes.add(name);
          models.push({
            code: name,
            value: name,
            description: null,
          });
        }
        continue;
      }
    }

    // Try splitting by 2 or more spaces (column alignment)
    const multiSpaceMatch = line.match(/^(\S+)\s{2,}(.+)$/);
    if (multiSpaceMatch) {
      const slug = multiSpaceMatch[1].trim();
      const displayName = multiSpaceMatch[2].trim();
      if (!isRetiredAgyModel(displayName) && !isRetiredAgyModel(slug)) {
        if (!seenCodes.has(displayName)) {
          seenCodes.add(displayName);
          models.push({
            code: displayName,
            value: displayName,
            slug,
            description: null,
          });
        }
      }
      continue;
    }

    // Fallback: single line display name
    if (!isRetiredAgyModel(line) && !seenCodes.has(line)) {
      seenCodes.add(line);
      models.push({
        code: line,
        value: line,
        description: null,
      });
    }
  }

  return models;
}

/**
 * Generate a canonical slug for a model display name.
 * e.g. "Gemini 3.8 Flash (High)" -> "gemini-3.8-flash-high"
 */
export function slugifyModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[()]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-');
}

/**
 * Normalize a model name or slug for fuzzy matching by stripping all punctuation and whitespace.
 * e.g. "Gemini 3.8 Flash (High)" -> "gemini38flashhigh"
 *      "gemini-3.8-flash-high"   -> "gemini38flashhigh"
 *      "gemini-3-8-flash-high"   -> "gemini38flashhigh"
 */
export function normalizeModelKey(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns the fallback static model list formatted as DiscoveredModel items.
 */
export function getStaticAgyModels(): DiscoveredModel[] {
  return AGY_MODELS.map((name) => ({
    code: name,
    value: name,
    slug: slugifyModelName(name),
    description: null,
  }));
}

export type ExecFileFn = typeof execFile;

export interface DiscoverAgyModelsOptions {
  bin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  execFileFn?: ExecFileFn;
}

/**
 * Discover models by running `agy models`.
 * Falls back to static AGY_MODELS on error, timeout, or empty output.
 */
export async function discoverAgyModels(
  opts: DiscoverAgyModelsOptions = {},
): Promise<DiscoveredModel[]> {
  const bin = opts.bin ?? resolveAgyBin();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const log = opts.log ?? (() => {});
  const execFileFn = opts.execFileFn ?? execFile;

  return new Promise<DiscoveredModel[]>((resolve) => {
    try {
      execFileFn(
        bin,
        ['models'],
        {
          timeout: timeoutMs,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            log(`Failed to discover agy models dynamically (${error.message}); falling back to static list`);
            resolve(getStaticAgyModels());
            return;
          }

          const parsed = parseAgyModelsOutput(stdout);
          if (parsed.length > 0) {
            log(`Discovered ${parsed.length} agy models dynamically`);
            resolve(parsed);
          } else {
            log('No models parsed from `agy models`; falling back to static list');
            resolve(getStaticAgyModels());
          }
        },
      );
    } catch (err) {
      log(`Error running agy models: ${err instanceof Error ? err.message : String(err)}`);
      resolve(getStaticAgyModels());
    }
  });
}

/**
 * Resolve a model string (slug or display name) to the canonical display name
 * accepted by `agy --model`.
 */
export function resolveAgyModelName(
  model: string | undefined,
  models?: DiscoveredModel[],
): string | undefined {
  if (!model) return undefined;
  const list = models && models.length > 0 ? models : getStaticAgyModels();

  const trimmed = model.trim();
  const lower = trimmed.toLowerCase();
  const normalized = normalizeModelKey(trimmed);

  // Exact code or value match
  const exact = list.find((m) => m.code === trimmed || m.value === trimmed);
  if (exact) return exact.code;

  // Slug match (e.g. 'gemini-3.8-flash-high' -> 'Gemini 3.8 Flash (High)')
  const slugMatch = list.find((m) => m.slug && m.slug.toLowerCase() === lower);
  if (slugMatch) return slugMatch.code;

  // Case-insensitive match on code or value
  const ciMatch = list.find(
    (m) => m.code.toLowerCase() === lower || m.value.toLowerCase() === lower,
  );
  if (ciMatch) return ciMatch.code;

  // Normalized key match (strips punctuation/spaces: 'gemini-3.8-flash-high' <-> 'Gemini 3.8 Flash (High)')
  const normMatch = list.find(
    (m) =>
      normalizeModelKey(m.code) === normalized ||
      normalizeModelKey(m.value) === normalized ||
      (m.slug && normalizeModelKey(m.slug) === normalized),
  );
  if (normMatch) return normMatch.code;

  return trimmed;
}

/**
 * Resolve Happy's model + effort selection to the display name accepted by
 * `agy --model`. The Gemini 3.8 Flash family is sent by the app as the base
 * name plus an independent effort level; combine them into the suffixed
 * variant agy expects. Names that already carry a variant (including saved
 * legacy display names) and non-Gemini models pass through unchanged, so a
 * suffix always wins over a conflicting effort level.
 */
export function resolveAgyModelSelection(
  model: string | undefined,
  effort: string | null | undefined,
  models?: DiscoveredModel[],
): string | undefined {
  if (!model) return undefined;
  const resolved = resolveAgyModelName(model, models);
  if (!resolved || resolved !== AGY_GEMINI_3_8_FLASH_MODEL) {
    return resolved;
  }
  const normalizedEffort = normalizeAgyEffort(effort);
  const effortLabel = normalizedEffort[0].toUpperCase() + normalizedEffort.slice(1);
  return `${AGY_GEMINI_3_8_FLASH_MODEL} (${effortLabel})`;
}
