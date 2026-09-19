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
| `packages/happy-cli/src/agent/acp/runAcp.ts` | Generic ACP runner; owns the dsh-specific behaviors (flavor mapping, local auto-approve, thought-level switching) |
| `packages/happy-cli/src/agent/acp/acpAgentConfig.ts` | `KNOWN_ACP_AGENTS.dsh` mapping for `happy acp dsh` |

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
arrays), so they cannot be hardcoded. Consequences:

- Pre-spawn, the app's model picker shows only the ambient "Default model"
  row (`getDshModelModes`).
- Once the session starts, `config_options_update` fills `metadata.models`
  from the ACP options and the picker switches to the live catalog
  (`sessionConfigMetadata.ts`), same as Gemini/OpenCode.
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
- **Binary discovery.** dsh is resolved from `HAPPY_DSH_PATH` or PATH; a
  source checkout run via `pnpm dsh` needs `HAPPY_DSH_PATH` pointing at a
  wrapper script.
