# dsh Harness (DeepSeek Harness)

Feature document for the Happy CLI / Happy App integration with
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
through its ACP profile.

## Goal

Let a Happy session drive dsh as its agent backend, selectable from the Happy
iOS app like Claude Code, Codex, Gemini, or agy. dsh is spawned through its
standard Agent Client Protocol profile (`dsh --profile acp`), so the generic
ACP runner carries the whole session — no harness-specific protocol layer is
needed.

## Core Entry Points

| File | Role |
|---|---|
| `packages/happy-cli/src/dsh/constants.ts` | `DSH_BIN`, `DSH_ACP_ARGS`, `findDshBin()` (env override + PATH probe), `resolveDshBin()` |
| `packages/happy-cli/src/dsh/runDsh.ts` | Thin wrapper: `runAcp({ agentName: 'dsh', command: resolveDshBin(), args: DSH_ACP_ARGS })` |
| `packages/happy-cli/src/dsh/discoverModels.ts` | Pre-spawn catalog probe: throwaway ACP session → flattened `model` config option |
| `packages/happy-cli/src/agent/acp/runAcp.ts` | Generic ACP runner; owns the dsh-specific behaviors (flavor mapping, local auto-approve, thought-level switching) |
| `packages/happy-cli/src/agent/acp/acpAgentConfig.ts` | `KNOWN_ACP_AGENTS.dsh` mapping for `happy acp dsh` |
| `packages/happy-app/sources/sync/dshModelCatalog.ts` | Reads the published `dshModels` catalog from machine metadata (per machine, or the liveliest one) |

## Architecture

```
Happy iOS/Web client
   │  (encrypted WebSocket; user messages carry meta.model /
   │   meta.permissionMode / meta.effort)
   ▼
runAcp.ts  session.onUserMessage
   │  ├─ permissionHandler.setAutoApprove(permissionMode === 'bypassPermissions')
   │  ├─ switchModelIfRequested(meta.model)            ← 'model' config option
   │  ├─ switchThoughtLevelIfRequested(meta.effort)    ← 'reasoning_effort' config option
   │  └─ messageQueue.push(text)
   ▼
AcpBackend (official @agentclientprotocol/sdk over stdio)
   spawn: dsh --profile acp
   ▼
dsh child process ──ACP JSON-RPC──▶ AgentMessage events
```

## How dsh Maps onto the ACP Runner

dsh's ACP profile is close to the generic ACP shape, with three gaps the
runner fills:

1. **Flavor mapping** — `resolveSessionFlavor('dsh')` tags session metadata
   with flavor `dsh` so the app renders the right name, avatar badge, and
   mode lists.
2. **No mode selector** — dsh has no ACP `mode` config option, so the app's
   permission modes cannot be applied by switching modes. Instead
   `GenericAcpPermissionHandler` gained local auto-approval: when the app's
   message meta carries `permissionMode: 'bypassPermissions'`, the runner
   answers dsh's `session/request_permission` calls itself with
   `approved`; every other mode still forwards each request to the app.
3. **Reasoning effort** — dsh advertises a `thought_level`-category select
   (`id: 'reasoning_effort'`) whose option values are provider effort names
   and whose provider default is the empty-string value. The runner's
   `extractConfigSelector` accepts the `thought_level` category (with
   id/name heuristics for providers that omit categories) and
   `switchThoughtLevelIfRequested` maps `meta.effort` onto it; `null` maps
   back to the provider default.

## Model Catalog

dsh reports its model list as ACP session config options in the `model`
category; the option values are opaque provider/model route strings (JSON
arrays), so they cannot be hardcoded. The catalog reaches the app twice:

1. **Pre-spawn (machine metadata).** The daemon probes the catalog once per
   lifetime — when dsh availability is first seen, re-armed if dsh goes away
   and comes back — by spawning `dsh --profile acp`, running `initialize` +
   `session/new` with no prompt, and reading the response's `configOptions`
   (`dsh/discoverModels.ts`). The flattened catalog is published as machine
   metadata `dshModels` (`{ options: [{code, value, description}],
   currentCode, detectedAt }`) next to `cliAvailability`, via the keep-alive
   path in `apiMachine.ts`. The app reads it (`sync/dshModelCatalog.ts`) so
   the new-session picker, the Home dock composer, and Settings → Agents →
   DeepSeek offer the real list before any session starts, with the ambient
   "Default model" row first (`getDshModelModes`). The default-model setting
   (`agentDefaultOverrides.dsh.modelMode`) carries the option's `code`.
2. **Live (session metadata).** Once the session starts,
   `config_options_update` fills `metadata.models` from the ACP options and
   the picker switches to the live catalog (`sessionConfigMetadata.ts`), same
   as Gemini/OpenCode.

Consequences:

- A catalog published by one machine is only offered for sessions that
  machine spawns; Settings falls back to the liveliest machine that probed
  one, and hides the dsh Model field until some machine publishes a catalog.
- Switching models mid-session goes through `setSessionConfigOption('model',
  value)` only when the requested value matches an advertised option.

## Permissions

dsh sends `session/request_permission` for sensitive tool calls (under its
workspace-write preset). Options are `allow-once` / `reject`; the runner
answers `allow-once` on approve and falls back to `cancel` on deny, which dsh
treats as rejected. `bypassPermissions` never reaches dsh — it is enforced
client-side in the runner (see above).

## Availability Reporting

The CLI daemon reports `cliAvailability.dsh` by probing for the executable
(`HAPPY_DSH_PATH` env override, then `command -v dsh` / `where dsh`). Like
agy, dsh stays hidden from the app's harness picker until a machine reports
it available (`EXPLICIT_REPORT_HARNESSES` in `harnessCatalog.ts`,
`machineChoiceAgentVisible` in `machineChoices.ts`).

## v1 Limitations

- **No session resume.** `AcpBackend` has no session/load, so daemon-level
  resume refuses with an "unsupported flavor" error, consistent with the
  Gemini/OpenCode ACP flavors. Offline reconnect within a live runner still
  works via `setupOfflineReconnection`.
- **No reasoning-effort picker.** The wire path (`meta.effort` →
  `reasoning_effort`) is implemented and tested, but the app has no UI that
  reads `metadata.thoughtLevels` yet; reasoning stays at the dsh provider
  default.
- **Catalog staleness.** The probed catalog refreshes only when the daemon
  restarts or dsh availability flips (install/uninstall). Providers added
  while the daemon runs appear once the session starts reporting its own
  config options, but the pre-spawn list keeps the older probe until then.
  A failed probe is not retried within the same daemon run.
- **Binary discovery.** dsh is resolved from `HAPPY_DSH_PATH` or PATH; a
  source checkout run via `pnpm dsh` needs `HAPPY_DSH_PATH` pointing at a
  wrapper script.
