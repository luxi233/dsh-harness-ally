# Agent Note: Compaction summarization routes to the executing Harness

Status: implemented

## Problem

DSH's `dsh-compaction-basic` compacts a session in two stages: measure surface pressure at each `agent/pre-step` boundary (default threshold `contextWindow × 0.8`, read from `resolveModelInfo(...).context`), then summarize the selected span through a direct `ctx.llm.stream()` call marked `purpose: 'compaction'` targeting the session's latest routed provider/model.

For alliance sessions routed to third-party Harnesses both stages were broken. The adapters reported no `context` so pressure checks threw `no context capacity` and skipped compaction forever (fixed in the contextWindow commit alongside this note). Even with capacity known, the summarization stream carried `purpose` and therefore bypassed `runtime.route`, fell through to the provider adapter's `stream()`, and hit the deliberate "switch your Harness" guard — every automatic compaction and manual `/compact` failed at the summarization step.

## Decision

`runtime.route` intercepts `purpose === 'compaction'` before the generic `options.purpose` bypass and dispatches it through `routeCompaction`:

- the summarization target is chosen by `pickCompactionTarget`: the routed provider/model is used when its context window exceeds the estimated replayed-span size plus `maxTokens`; otherwise the newest `request/context` entry in session history whose window fits is preferred (a `codex` model summarizes with Codex even when the selected Harness is Devin), and when nothing fits the candidate with the largest known window wins;
- execution follows provenance: a provider bound in `OWN_PROVIDER_HARNESSES` dispatches to that Harness, an unbound provider/model pair dispatches to the Harness that previously ran it (from the dispatch ledger), and a never-dispatched native provider mutates `options.provider`/`options.model` in place and falls through to `next()` so DSH's own adapter serves the call (cordis `waterfall` `next()` cannot take replacement arguments);
- `next()` is also used when the session is not an alliance session, the resolved Harness is `dsh`, the agent is gone, or the prompt renders empty;
- the request omits `incrementalPrompt`, `promptSignature`, `turn`, and `conversation`, so `gateway.start` bypasses `nativeSessions` and every summarization spawns a detached `session/new` — the compaction instruction never enters the live CLI thread and the DSH dispatch ledger stays untouched;
- the prompt is `createConversationView(options.messages).messages.join('\n\n')`, which keeps the plugin-sourced `COMPACTION_INSTRUCTION` message and resolves the last human message's image refs into `images`;
- only the final text is emitted as a single text block; `run.stream` is drained without forwarding deltas because the summarizer consumes a finished summary, not intermediate output;
- usage follows the same rule as foreground dispatch: reported usage wins, otherwise `estimateUsage` prices the prompt.

The reverse index is the `Note:` comment above `routeCompaction` in `lib/runtime.js`.

## Alternatives considered

- Configuring `summarizationProvider`/`summarizationModel` in `BasicCompactionConfig` to a first-party LLM: rejected as the default because it forces every user to hold a second provider credential and summarizes third-party history with a different model than the one that produced it. It remains a valid per-target override when the routed model's own window is too small to hold the replayed span.
- Resuming the live native session for summarization: rejected because the summarization exchange would be recorded inside the CLI thread that the next foreground turn continues from.
- Reusing the foreground dispatch path with dispatch recording: rejected because compaction is auxiliary work — recording it would corrupt watermarks and the work-ledger bookkeeping.

## Consequences

Automatic pressure compaction now works end-to-end for providers whose adapters report `contextWindow` (Devin, Claude Code), and manual `/compact` works on every third-party Harness session. Codex and Kimi sessions still skip the pressure check because their catalogs expose no context window; overflow recovery still requires the provider error to surface `CONTEXT_WINDOW_EXCEEDED`, which external CLI errors do not produce.

A summarization prompt near the target window no longer overflows by construction: when the routed model cannot hold the replayed span, summarization migrates to the newest history model that can (usually the larger-window model that produced the history — even across Harnesses), or the largest known window when nothing fits. A span exceeding every model ever used in the session still fails compaction and the turn continues uncompacted, logging a warning as before.
