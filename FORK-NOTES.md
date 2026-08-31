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
| `lib/index.js` | `trustedRead` accepts loopback authority unconditionally; `trustedMutation` no longer requires `sec-fetch-site === 'same-origin'`; debug log to `%TEMP%\dsh-ally-debug.log`; opt-in `ALLOWED_REMOTE_HOSTS` whitelist for direct public-host access |
| `lib/cli-manager.js` | `performInstall` swaps `npm.cmd` → `node + npm-cli.js` on Windows; `install()` synchronously marks `installs` Map so concurrent `status()` reflects `installing:true` |
| `lib/codex-app-server.js` | Skip `sandbox.confine` enforcement check; `appServerArgv` resolves `.cmd` to `node + codex.js` on Windows |
| `lib/harness.js` | Same two patches as `codex-app-server.js`, applied to the generic Claude/Kimi spawn path; uses a hardcoded `RESOLVED_NATIVE` map (`claude.cmd` → `claude.exe`, `codex.cmd` → `codex.js`, `kimi.cmd` → `kimi.js`) |
| `lib/kimi-acp.js` | Same two patches as `codex-app-server.js`, applied to Kimi's dedicated `startKimiAcpRun` |
| `package.json` | Bumped to `0.12.1-fork.1`; description documents the fork purpose |

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
