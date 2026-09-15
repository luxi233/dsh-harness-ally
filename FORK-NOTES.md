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
| `lib/cli-own-models.js`, `lib/harness.js`, `lib/codex-app-server.js`, `lib/index.js` (fork.9) | "CLI 配置" providers `claude-code` / `codex`: selecting one skips the DSH model bridge and managed config dir so the subprocess runs on the user's own settings (`~/.claude/settings.json`, `~/.codex/config.toml` — CCSwitch-written configs apply). Claude lists `sonnet`/`opus`/`haiku` aliases + the configured model; Codex lists the account catalog via a one-shot `codex app-server` `model/list` handshake with reasoning-effort metadata. The `cli-config` entry means "follow the CLI's own configured model"; real ids are forwarded as `--model` / thread `model` |

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
