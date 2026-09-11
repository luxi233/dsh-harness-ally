# Agent Note: Harness selector spacing and alignment

Status: implemented

## Problem

The Harness Alliance popover was visually too dense and inconsistent: option rows could read as one connected stack, selected rows shifted by a transform, and the icon/check columns did not have explicit stable tracks. The fix belongs to the `harness-ally` client plugin, not the DSH Web shell.

## Decision

The selector keeps its existing DOM and behavior and uses a plugin-local grid layout:

- the popover uses a bounded width and an explicit gap from the trigger;
- the option list uses a single-column grid with a fixed row gap;
- every option uses a fixed 56px row and three stable columns for icon, label, and check/install affordance;
- icons are reduced to 24px and centered in their 32px track;
- unselected rows stay transparent, while hover/selected rows get the subtle surface and border;
- no `transform` is used for selection, so rows do not shift or overlap.

The reverse index is the `Note:` comment immediately above `.ally-engine-popover` in `lib/client.js`.

## Alternatives considered

- Editing DSH Web global styles: rejected because this is plugin-owned UI and global changes would affect unrelated DSH surfaces.
- Adding descriptions to each Harness: rejected because the existing visibility test intentionally keeps the selector labels-only.
- Using per-row margins: rejected in favor of a parent grid gap, which gives consistent spacing for both buttons and unavailable `div` rows.

## Consequences

The selector has a slightly taller, calmer layout and a predictable alignment at narrow viewport widths. The existing selector DOM, selection behavior, install flow, and Harness labels remain unchanged. The popover still depends on the plugin's injected CSS and requires the DSH client module to reload after source changes.
