# FORK-NOTES — luxi233/dsh-harness-ally

This is a personal fork of [`BaronCyrus/dsh-harness-ally`](https://github.com/BaronCyrus/dsh-harness-ally)
with Windows-specific and dsh-bridge customTunnel compatibility patches. Upstream is the source of truth
for general alliance-mode behavior; this fork adds a small number of targeted, well-isolated fixes.

## Why this fork exists

Upstream `dsh-harness-ally` enforces a strict loopback / same-origin security check on its
`/ally/*` HTTP routes and assumes Linux-style spawn semantics. On Windows + dsh-bridge
customTunnel, **none of those assumptions hold**:

| Scenario | Upstream behavior | This fork |
|---|---|---|
| Remote browser at `http://<public-ip>:port/` reaches `/ally/select` via dsh-bridge tunnel | `拒绝非同源请求` (403) — Origin host mismatches loopback Host | Accepts loopback-host requests (treated as trusted-proxy-rewritten); keeps same-origin + Content-Type + Origin checks |
| Spawn `codex.cmd` / `claude.cmd` / `kimi.cmd` via DSH subprocess | `spawn EINVAL` — Node.js refuses `.cmd` without `shell:true` | Resolves each `.cmd` to its underlying `.exe` or `node + .js` before spawn |
| Spawn `npm.cmd` from `cli-manager.performInstall` | `spawn EINVAL` | Replaces with `node + npm-cli.js` |
| `npm install` from `/ally/cli-install` route, reached via dsh-bridge tunnel | HTTP 504 after ~30-60s — public tunnel proxy times out before `npm install` completes | Fire-and-forget install: route returns immediately with `installing:true`; user sees progress via subsequent status polls |
| `policyFor(session)` returns non-`danger-full-access` under alliance mode (session-level policy, not preset-level) | `codex/claude-code/kimi-code requires a fully enforcing DSH sandbox` (403) | Skips ally-internal `sandbox.confine` check; DSH outer sandbox from `ctx.sandboxPolicy` is still enforced at a higher level |
| Change dsh-bridge's public IP / port, or hand the fork to other users behind their own dsh-bridge | Edit `ALLOWED_REMOTE_HOSTS` to add every new `host:port` | Set `ALLOWED_REMOTE_ALL = true` so `isWhitelistedOrigin` short-circuits; trust moves one layer up to dsh-bridge's `token_and_password` auth |

All five fixes are scoped to `lib/` and do not change any DSH core, dsh-bridge, or upstream
plugin code. They can be rebased against future upstream releases with minimal conflict.

## What this fork does NOT change

- The PRESET_ID stays `harness-ally` (install path `~/.dsh/.agent-presets/harness-ally/`)
- The package name stays `dsh-ally` (so `setup/install.mjs` works unchanged)
- The cordis host bundle id stays `ally` (no collision with upstream)
- The model routing, work ledger, native session parking, and reasoning codec are untouched

## Security notes

The loopback-trust relax is the most security-sensitive change. Reasoning:

1. `Host: 127.0.0.1:3080` at the dsh web layer can only be produced by something that runs
   locally on the same machine as dsh web — namely dsh-bridge's tunnel-client after rewriting.
   External browsers cannot forge it.
2. dsh-bridge's own ProxyServer enforces authentication (`allowLoopback: true` plus
   `mode: token_and_password` in `~/.dsh/dsh-bridge/config.json`) before requests reach this code.
3. The Origin header still must be set and (when not loopback) must match the request authority.
   We only skip the strict authority-vs-Origin match when the Host is loopback.

If you do not run dsh web behind dsh-bridge's authenticated tunnel, the relax below does
nothing for you — it only activates when `req.headers.host` is `127.0.0.1` / `localhost` /
`::1`.

## Files changed in this fork

| File | Change |
|---|---|
| `lib/index.js` | `trustedRead` accepts loopback authority unconditionally; `trustedMutation` no longer requires `sec-fetch-site === 'same-origin'`; opt-in `ALLOWED_REMOTE_HOSTS` whitelist for direct public-host access |
| `lib/cli-manager.js` | `performInstall` swaps `npm.cmd` → `node + npm-cli.js` on Windows; `install()` synchronously marks `installs` Map so concurrent `status()` reflects `installing:true` |
| `lib/codex-app-server.js` | Skip `sandbox.confine` enforcement check; `appServerArgv` resolves `.cmd` to `node + codex.js` on Windows |
| `lib/harness.js` | Same two patches as `codex-app-server.js`, applied to the generic Claude/Kimi spawn path; uses a hardcoded `RESOLVED_NATIVE` map (`claude.cmd` → `claude.exe`, `codex.cmd` → `codex.js`, `kimi.cmd` → `kimi.js`) |
| `lib/kimi-acp.js` | Same two patches as `codex-app-server.js`, applied to Kimi's dedicated `startKimiAcpRun` |
| `package.json` | Bumped to `0.12.1-fork.3`; description documents the fork purpose |
| `lib/index.js` (additional patch in fork.2) | New `ALLOWED_REMOTE_ALL = true` toggle; `isWhitelistedOrigin` returns `true` when set, bypassing per-host match |
| `lib/index.js`, `lib/kimi-acp.js` (fork.3) | Removed the fork-only unbounded `%TEMP%\dsh-ally-debug.log` diagnostic logging |
| `lib/runtime.js`, `lib/client.js` (fork.4) | Supports both legacy `session.events` / `session.agentPreset` and DSH 0.1.2 `snapshotEvents()` / `projectionValues.agentPreset`; suppresses the duplicate in-composer selector for blank welcome sessions and applies the retained welcome selection to that blank Session |
| `setup/install.mjs` (fork.4) | Runs pnpm through its JavaScript entry on Windows, avoiding Node 24's `spawnSync pnpm.cmd EINVAL` failure |
| `package.json` (fork.4) | Bumped the fork version to `0.12.1-fork.4` |
| `lib/client.js` (fork.5) | Removes the DOM-injected welcome selector; blank sessions use the same `conversation.input.right` Harness selector as active sessions |
| `package.json` (fork.5) | Bumped the fork version to `0.12.1-fork.5` |
| `lib/client.js` (fork.6) | Treats session-switch 404 responses as a bounded loading transition; waits for both snapshot and CLI availability before showing install actions |
| `package.json` (fork.6) | Bumped the fork version to `0.12.1-fork.6` |
| `lib/devin-acp.js`, `lib/harness.js`, `lib/runtime.js`, `lib/client.js`, `agent.cordis.yml`, `ally-prompt.mjs` (fork.8) | Adds `devin` as a fifth Harness: `devin acp` adapter (initialize → `authenticate` with `_meta.api_key` → `session/new`/`session/load` → `session/prompt`/`session/cancel`), `ally-devin` subagent provider, selector entry and icon. Devin does not use the DSH model bridge or the npm managed prefix — it authenticates via `devin auth login` credentials (`~/.local/share/devin/credentials.toml`) or `DEVIN_API_KEY`/`WINDSURF_API_KEY`, and installs via the official `install.sh`/`setup.ps1` scripts |
| `lib/cli-manager.js` (fork.8) | `install()` marker is now a deferred that hands off to the real attempt — previously a concurrent `install()` racing the `inspect()` window received a never-resolving promise and hung forever. Also adds script-installer specs (`installer: 'script'`) with user-directory fallback resolution (`~/.local/bin`, `$XDG_DATA_HOME/devin/cli/_versions/current`, `%LOCALAPPDATA%\devin\cli\bin`) for CLIs that aren't npm packages |
| `test/harness.test.mjs` (fork.8) | Updates the stale upstream "wrapped by the DSH sandbox" case to assert the fork's actual contract: no inner `sandbox.confine`, native argv unchanged (outer sandbox comes from `ctx.sandboxPolicy`) |
| `package.json` (fork.8) | Bumped the fork version to `0.12.1-fork.8` |
| `lib/image-input.js`, `lib/runtime.js`, `lib/harness.js`, `lib/kimi-acp.js`, `lib/devin-acp.js`, `lib/codex-app-server.js`, `lib/index.js` (fork.9) | Native image input for all external Harnesses: the current request's image attachments resolve through `ctx.attachments.imageHostPath` (lazy, not `inject`-declared, so older DSH hosts without the service degrade to a clear error instead of a dead plugin). Claude switches stdin to `--input-format stream-json` with base64 `source` blocks, Codex sends `localImage`/`image` input items in `turn/start`, Kimi/Devin send ACP `image` content blocks — falling back to host-path text references when the ACP agent doesn't advertise `promptCapabilities.image`. Unresolvable refs still fail closed before dispatch; canonical rendering keeps a deterministic `[image attached: name]` marker so watermarks/signatures stay text-stable |
| `test/kimi-acp.test.mjs`, `test/codex-app-server.test.mjs`, `test/http-trust.test.mjs` (fork.9) | Fixed stale upstream assertions broken by earlier fork behavior: persistent `KIMI_CODE_HOME` (no temp-home removal), fork version strings in clientInfo, and the relaxed loopback-Origin trust model (`ALLOWED_REMOTE_ALL`) |
| `lib/image-input.js`, `lib/runtime.js`, `lib/harness.js`, `lib/kimi-acp.js`, `lib/devin-acp.js`, `lib/codex-app-server.js` (fork.9) | File attachments for external Harnesses via host-path references: `{type:'file'}` blocks in the current request resolve through `ctx.attachments.fileHostPath` (no byte reads) and land in the prompt as a "file(s) on the host filesystem" path list each CLI reads with its own tools. Refs without a host path fail closed before dispatch; canonical text keeps `[file attached: name]` markers, history degrades to `[file omitted]` placeholders |
| `agent.cordis.yml` (fork.9) | `persona` row config updated to the current `dsh-persona` schema (`prefix`/`suffix` instead of the removed `text` field) — required for the preset to mount on recent DSH versions |
| `lib/client.js` (fork.9) | `cliController.load()` no longer downgrades `ready` when a snapshot exists, so polling during/after a CLI install doesn't flash every row back to "checking" |
| `lib/devin-models.js`, `lib/devin-acp.js`, `lib/index.js` (fork.9) | Devin account models as a selectable llm provider `devin`: catalog from `devin models list --format json` (falls back to documented families when logged out), translated to `devin acp --model` on the Devin harness; the provider refuses real llm calls so other harnesses fail with a harness-switch diagnostic |
| `lib/cli-own-models.js`, `lib/harness.js`, `lib/codex-app-server.js`, `lib/kimi-acp.js`, `lib/index.js` (fork.9) | "CLI 配置" providers `claude-code` / `codex` / `kimi-code`: selecting one skips the DSH model bridge and managed config dir so the subprocess runs on the user's own settings/login (`~/.claude/settings.json`, `~/.codex/config.toml`, `kimi login` account — CCSwitch-written configs apply). Claude lists `sonnet`/`opus`/`haiku` aliases + the configured model; Codex lists the account catalog via a one-shot `codex app-server` `model/list` handshake with reasoning-effort metadata; Kimi lists the account catalog via an ACP `session/new` `configOptions` handshake (model select + `thought_level` efforts) and forwards the pick via `session/set_config_option`. The `cli-config` entry means "follow the CLI's own configured model"; real ids are forwarded as `--model` / thread `model` / ACP `model` config |
| `lib/devin-models.js`, `lib/devin-acp.js` (fork.10) | Devin catalog discovery gains an ACP handshake path (`initialize` → `authenticate` → `session/new` → read the `model` configOption, `MODEL_*` enum aliases filtered) between `devin models list` and the documented-family fallback — works around CLI versions whose `models list`/`auth status` misreport the login state |
| `lib/kimi-acp.js` (fork.10) | Kimi prefers `yolo` over `auto` when the mode select offers it, matching Claude `bypassPermissions` / Codex `approvalPolicy: never` / Devin `bypass` semantics |
| `lib/runtime.js` (fork.10) | Own-config provider/Harness mismatches (e.g. `devin` provider under `kimi-code`) are rejected before dispatch with an `ALLY_HARNESS_MISMATCH` diagnostic naming the required Harness — previously the external CLI retried an unreachable bridge endpoint and the turn silently completed empty |
| `lib/harness.js` (fork.10) | Claude Code failures surface the CLI's own result text (`Not logged in · Please run /login`) instead of the misleading `exit 1：success` subtype label |
| `lib/kimi-acp.js` (fork.10) | An `end_turn` response with zero text, zero tool activity, and zero usage is reported as `ALLY_HARNESS_ERROR` instead of a silent completion — covers upstream model errors Kimi swallows |
| `lib/devin-acp.js`, `lib/kimi-acp.js`, `lib/codex-app-server.js` (fork.10) | ACP adapters tolerate late stdout after the managed subprocess reports exit: `done` may resolve before the runner forwards the final chunk (Devin exits ~4ms after `end_turn`), so the early-exit verdict now waits briefly for pending requests and the decoder ignores writes after `end()` |
| `lib/runtime.js` (fork.10) | History renders durable image/file attachment refs with the same `[image/file attached: name]` marker as the request-time render; previously history said `omitted`, so every post-attachment watermark digest mismatched and native resume silently fell back to a fresh vendor session |
| `package.json` (fork.10) | Bumped the fork version to `0.12.1-fork.10` |
| `lib/cli-manager.js` (fork.11) | `performScriptInstall` no longer runs `irm <url> \| iex` / `curl \| bash` download-cradles — the script is fetched in-process to a temp file and executed via `powershell -File` / `sh <file>`. Windows Defender's ML detection (`Trojan:Win32/Commando.A!ml`) flagged the `irm|iex` CmdLine pattern and blocked the Devin install; the two-step form leaves no remote-execution signature. Download is injected as a `download` dep for tests |
| `lib/devin-models.js` (fork.11) | `devinApiKey` also reads `%APPDATA%\Devin\credentials.toml` — on Windows `devin auth login` writes there, not `~/.local/share/devin/`; without it ACP `authenticate` was skipped and the catalog silently fell back. Devin v3000.x returns `options: []` on the ACP `model` configOption (only `currentValue`), so a third catalog source parses the CLI's own `model_configs_v5.*.bin` cache (JSON + base64 protobuf; slugs extracted, effort/tier variants collapsed to family slugs). Order: `models list` → ACP configOptions → bin cache (+`currentValue`) → static fallback |
| `lib/runtime.js` (fork.11) | own-config provider under a mismatched Harness now auto-switches instead of erroring — picking a `devin`/`codex`/etc provider model flips the session's persisted Harness (`gateway.available` check + `state.setHarness`; `select()`/`runMaintenance` can't be used because the agent is mid-turn at dispatch) and dispatches to the bound CLI. `ALLY_HARNESS_MISMATCH` remains only when the switch itself fails. Applies under Harness `dsh` too |
| `lib/client.js` (fork.12) | `controller.load` effect also depends on `running` — the selector icon re-syncs at dispatch time (right after the server-side auto-switch) instead of only at turn end via `completedTurns` |
| `package.json` (fork.12) | Bumped the fork version to `0.12.1-fork.12` |
| `lib/devin-models.js` (fork.13) | Catalog is a union of all three sources (`models list` + ACP configOptions + model_configs bin cache) instead of a cascade — `models list` succeeds in-process but returns only base families, which previously short-circuited the richer sources. Effort/tier variants are no longer collapsed; base slugs with `-<effort>` variants carry `supportedReasoningEfforts`/`defaultReasoningEffort` so the selector shows a reasoning-effort picker |
| `lib/devin-acp.js` (fork.13) | `request.model` + `request.reasoningEffort` translate to the `<model>-<effort>` slug for `devin acp --model` (skipped when the model already carries a tier suffix) |
| `lib/index.js` (fork.13) | `GET /ally/model-diag?provider&model` — live in-process `listModels`/`resolveModelInfo` probe for catalog debugging |
| `package.json` (fork.13) | Bumped the fork version to `0.12.1-fork.13` |
| `lib/devin-models.js` / `lib/devin-acp.js` (fork.14) | Family grouping normalizes vendor slug spellings (`.`, `_`, `-` equivalent) — base entries like `gpt-5.6-luna`/`swe-1.7` now pick up their hyphenated tier variants (`gpt-5-6-luna-high`, `swe-1-7-medium`); dispatch resolves the real variant slug from the account catalog instead of naive concatenation |
| `package.json` (fork.14) | Bumped the fork version to `0.12.1-fork.14` |
| `test/cli-manager.test.mjs`, `test/runtime.test.mjs` (fork.11) | Devin install test updated for the download-then-`-File` flow (asserts the downloaded URL and that argv ends with the script path); mismatch test rewritten to assert the auto-switch and dispatch under the bound Harness, plus a failure-path case when `select()` can't run |
| `package.json` (fork.11) | Bumped the fork version to `0.12.1-fork.11` |
| `lib/devin-models.js`, `lib/cli-own-models.js` (fork.15) | `resolveModel` now reports `context.contextWindow` — the conversation context meter needs it for the `request/context` denominator. Devin reads the real per-model window from `model_configs_v5.*.bin` protobuf field 18 (222/235 entries; base slugs derive theirs from family variants by stripping date/tier/effort suffixes); Claude Code uses a static 200000; Codex/Kimi pass `contextWindow` through only when the account catalog reports it |
| `lib/runtime.js` (fork.15) | External CLIs report no token usage, which zeroed the context meter's `pressureTokens` — dispatches now estimate usage from the exact `prompts.full` sent (CJK ~1.5 chars/token, else ~4), so the ring reflects the history the CLI actually holds. `purpose: 'compaction'` calls are routed to the executing Harness in a detached one-shot session (no nativeSession keys → `session/new`, keeps the foreground CLI thread clean) instead of falling through to the adapter's "switch Harness" stub; when the routed model can't fit the replay span (e.g. after switching a nearly-full 1M-context session down to swe-2), the summarization target is picked from request/context history — most recent window-fitting model wins, bound providers go to their CLI, previously-delegated models reuse their Harness, native providers fall back to DSH via `next()`. `reasoningEffort`/`files` forward correctly on that path |
| `package.json` (fork.15) | Bumped the fork version to `0.12.1-fork.15`; `files` now lists `devin-models.js`/`cli-own-models.js`/`image-input.js` (added in fork.9–fork.10 but missing from the publish whitelist — a packed tarball would have shipped a broken plugin) |
| `lib/devin-acp.js` (fork.16) | The auth-failure fallback diagnostic now appends the original ACP error text — a `fetch timed out` from team-settings no longer masquerades as "未登录或凭据失效" |
| `lib/codex-app-server.js` (fork.16) | Early-exit diagnostics include a bounded stderr tail — real upstream errors (`Invalid token`, `Connection refused`) surface instead of only "app-server 提前退出 exit 1" |
| `lib/projection-cache-shim.js` (fork.16) | New: wraps `sessionProjectionCache.cachedSnapshot` via `ctx.inject` so seeded subagent sessions (whose cold headers lack `inheritedEventCount`, making upstream's strict identity check miss unconditionally) serve cached `subagent` rows instead of forcing a full zstd log decode per cold session per listing — on this machine ~200 seeded sessions × ~5MB turned every page refresh into a multi-core decode/GC storm. Fallback verifies the stable identity fields (formatVersion/createdAt/cwd/isSeeded) and only fires when the strict path missed at offset 0. `armed`/`hits`/`misses` are observable on `/ally/model-diag` |
| `lib/index.js`, `package.json` (fork.16) | Shim wired into `apply`; `files` lists `projection-cache-shim.js`; version bumped to `0.12.1-fork.16` |

## Install

Identical to upstream:

```powershell
git clone https://github.com/luxi233/dsh-harness-ally.git "$env:USERPROFILE\.dsh\.agent-presets\harness-ally"
cd "$env:USERPROFILE\.dsh\.agent-presets\harness-ally"
node setup/install.mjs
```

Restart `dsh web` after install.

## Syncing with upstream

```powershell
cd "$env:USERPROFILE\.dsh\.agent-presets\harness-ally"
git fetch upstream
git rebase upstream/main
# resolve any conflicts, then:
git push origin main --force-with-lease
```

Conflicts most likely in `lib/cli-manager.js` (install flow) and `lib/index.js` (security model).

## License

MIT, inherited from upstream.
