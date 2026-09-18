/**
 * agy Entry Point — Engine Dispatcher
 *
 * `happy agy` always lands here. The selected engine (see ./engine.ts)
 * decides which session loop runs:
 *
 *   legacy      → src/agyLegacy: per-turn `agy --print` processes. Spawn
 *                 overrides (--model/--permission-mode/--resume) do not
 *                 exist there and are reported, not applied.
 *   stream-json → this directory's persistent NDJSON engine (default).
 *                 Without an explicit engine selection the backend
 *                 factory still auto-detects: a configured Gemini API key
 *                 upgrades the session to the Python SDK bridge.
 *   sdk         → the Python SDK bridge, forced.
 */

import { logger } from '@/ui/logger';
import { readSettings } from '@/persistence';
import { runLegacyAgy } from '@/agyLegacy/runAgy';
import { parseAgyEngine, resolveAgyEngine } from './engine';
import { runStreamJsonAgy, type RunStreamJsonAgyOptions } from './runStreamJsonAgy';

export type RunAgyOptions = RunStreamJsonAgyOptions;

export async function runAgy(opts: RunAgyOptions): Promise<void> {
  const settings = await readSettings();
  const envValue = process.env.HAPPY_AGY_ENGINE;
  const engine = resolveAgyEngine(opts.engine, envValue, settings.agyEngine);

  if (engine === 'legacy') {
    const ignored = [
      opts.model ? '--model' : null,
      opts.permissionMode ? '--permission-mode' : null,
      opts.resumeConversationId ? '--resume' : null,
      opts.dangerouslySkipPermissions ? '--dangerously-skip-permissions' : null,
    ].filter(Boolean);
    if (ignored.length > 0) {
      logger.warn(`agy legacy engine ignores spawn override(s): ${ignored.join(', ')}`);
    }
    return runLegacyAgy({
      credentials: opts.credentials,
      startedBy: opts.startedBy,
      verbose: opts.verbose,
    });
  }

  // An explicit 'stream-json' selection (any level) pins the CLI engine;
  // the bare default leaves forceEngine unset so the factory can
  // auto-detect the SDK bridge when an API key is configured. 'sdk'
  // always forces the bridge.
  const hasSelection = Boolean(
    parseAgyEngine(opts.engine) ?? parseAgyEngine(envValue) ?? parseAgyEngine(settings.agyEngine),
  );
  const forceEngine = engine === 'sdk' ? 'sdk' : hasSelection ? 'cli' : opts.forceEngine;
  return runStreamJsonAgy({ ...opts, forceEngine });
}
