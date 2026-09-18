# agy Dual-Engine Architecture

Happy ships two interchangeable backends for the Antigravity (agy) agent flavor.
`happy agy` dispatches to one of them at session start; both share the same
Happy session protocol, app UI, and resume plumbing.

| Engine | Directory | Default | Process model |
|--------|-----------|---------|---------------|
| `stream-json` | `packages/happy-cli/src/agy/` | **yes** | One persistent `agy --output-format stream-json` process per session; NDJSON events mapped to Happy envelopes |
| `sdk` | `packages/happy-cli/src/agy/` (`AgySdkBackend`) | no | Python SDK bridge (`bridge/server.py`); only when a Gemini API key is configured |
| `legacy` | `packages/happy-cli/src/agyLegacy/` | no | One `agy --print` process per turn; conversation id recovered from agy's on-disk cache |

The stream-json engine is a strict superset of legacy: it adds structured tool
call/result events, permission prompts, live model switching, skills, title and
statusline/quota channels, and precise `agyConversationId` bookkeeping. Legacy
is kept frozen as an escape hatch.

## Engine selection

Resolution order (first valid value wins):

1. `--engine <legacy|stream-json|sdk>` flag (daemon spawns can pass it through)
2. `HAPPY_AGY_ENGINE` environment variable
3. `agyEngine` field in `~/.happy/settings.json`
4. Default: `stream-json`

`cli` is accepted as an alias for `stream-json` (the original
`HAPPY_AGY_ENGINE` vocabulary was `sdk|cli`). Invalid values fall through to
the next level. See `src/agy/engine.ts` + `engine.test.ts`.

Backend auto-detection: with no explicit selection, `createAgyBackend` upgrades
the session to the SDK bridge when `GEMINI_API_KEY` is set. An explicit
`stream-json` selection pins the CLI engine (`forceEngine: 'cli'`) so the
presence of an API key cannot silently change behavior; `--engine sdk` pins
the bridge.

Legacy ignores spawn overrides that do not exist in its world
(`--model`, `--permission-mode`, `--resume`, `--dangerously-skip-permissions`)
and logs a warning instead of failing.

## Model & effort contract

The app picker sends the model as a display name plus an independent effort
level in message meta (`meta.model`, `meta.effort`; `null` effort = reset).

- `resolveAgyModelSelection(model, effort, models?)`
  (`src/agy/discoverModels.ts`) combines them: `'Gemini 3.8 Flash' + 'high'`
  → `'Gemini 3.8 Flash (High)'`. Names already carrying a variant suffix and
  non-Gemini models pass through unchanged, so a suffix always wins.
- The stream-json engine keeps `selectedModel`/`selectedEffort` state across
  turns, mirroring the legacy contract, and restarts the persistent process
  via `backend.setModel()` only when the resolved name changes.
- Default model: `'Gemini 3.8 Flash (High)'` (matches the app default).
  Note the legacy engine's bare-CLI default resolves to
  `'Gemini 3.8 Flash (Medium)'` — the one intentional behavior difference.

## Resume

`--resume <agyConversationId>` and app-side resume land on the **stream-json
engine** (`runStreamJsonAgy` passes the conversation id through to the backend
and persists new ids into session metadata). The daemon also re-fetches agy
session records that predate `agyConversationId` bookkeeping. Legacy sessions
keep using the `AGY_CONVERSATIONS_CACHE` heuristic.

## Operations

- Roll back a broken stream-json session:
  `HAPPY_AGY_ENGINE=legacy happy agy` (or `"agyEngine": "legacy"` in
  `~/.happy/settings.json` for a persistent switch).
- Force the SDK bridge: `--engine sdk` (requires the
  `google-antigravity` Python package and `GEMINI_API_KEY`).

## Feature docs

- [agy Stream-JSON Backend](agy-stream-json-backend.md) — event mapping, backend factory, process lifecycle
- [agy Permission Handling](agy-permission-handling.md) — auto-approve rules, RPC approve/deny flow
- [agy Session Resume](agy-resume.md) — reconnect env vars, conversation id persistence
- [agy Skills](agy-skills.md) — `/skills` discovery and formatting
- [agy Usage](agy-usage.md) — `/usage` quota report
- [agy StatusLine & Quota](agy-statusline-quota.md) — statusline hook and quota cache channel
