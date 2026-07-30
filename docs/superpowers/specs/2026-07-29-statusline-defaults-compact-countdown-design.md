# Statusline defaults: surface compact-countdown, retire two low-signal segments

**Date:** 2026-07-29
**Status:** Approved, ready for implementation planning

## Problem

The shipped `DEFAULT_SETTINGS` layout spends two of its eleven segments on
information that does not drive a decision, and omits the one number that does.

- `cache-hit-rate` sits at 96–99% in practice (96% in a live capture). It costs a
  segment to report that nothing changed.
- `api-latency` renders `cost.total_api_duration_ms`, which is *cumulative* API
  time for the session, not a latency. It reads as `API: 9m 55s`, which looks
  like a stall. It also holds priority 6, so under 80 columns the compact fitter
  keeps it *ahead of* `burn-rate` (7) and `git-changes` (9).
- `compact-countdown` (added in #22) answers "how much runway before auto-compact
  fires" — the only figure on the bar that changes what the user does in the next
  30 seconds. `context-percent` shows position, not runway: `82%` does not tell
  you the threshold is 83.5%. The widget is registered and documented but appears
  in no layout, so it never renders.

Eight of the 25 registered widgets are absent from the default layout
(`compact-countdown`, `session-timer`, `token-breakdown`, `turn-counter`,
`block-timer`, `cwd`, `per-model`, `session-clock`). This spec addresses only
`compact-countdown`; the rest stay available via user config.

## Blocking defect found during design

`compact-countdown` cannot be wired in as written — it is broken for essentially
every real session.

It derives usage from `context_window.total_input_tokens + total_output_tokens`.
Those fields are cumulative across the session, not a measure of current context:

- The repo's own stdin field reference documents them as cumulative.
- `burn-rate` divides them by `cost.total_duration_ms` to produce tok/min, which
  is only meaningful on a cumulative basis.
- `context-percent` had the same fields available and deliberately chose a
  different basis (`remaining_percentage` → `used_percentage` → sum of
  `current_usage`).

Because the widget compares a cumulative total against a threshold derived from
the window size, it trips as soon as cumulative tokens exceed
`windowSize × 0.835` — within the first few turns — and then pins to a red
`Compact imminent!` permanently. Verified against the live values in
`~/.cache/gccusage/statusline-cache.json` (1.00M window, context at 7%):

| Basis | Output |
|---|---|
| Current context (~70k of 1M) | `~765k left` (correct) |
| Cumulative, same moment | `Compact imminent!` (false alarm) |
| Cumulative, 200k window mid-session | `Compact imminent!` (false alarm) |

There are no tests for this widget, and it has never been wired into a layout,
which is consistent with it never having run against a real session.

Shipping the layout change without fixing this would put a permanently-lit false
alarm in every user's status bar. The fix is therefore in scope.

## Design

### 1. Shared context-usage helper

`context-percent` currently inlines a four-way fallback chain for deriving how
full the context is. `compact-countdown` needs exactly the same basis. Extract it:

```ts
// src/utils/context-usage.ts
export interface ContextUsage {
  ratio: number;              // 0..1, fraction of the window consumed
  windowSize: number | null;  // tokens; null when stdin omits context_window_size
}
export function deriveContextUsage(stdin: StatusJson): ContextUsage | null;
```

`windowSize` must be nullable. `context-percent` renders today when
`used_percentage` is present but `context_window_size` is absent — it just omits
the ` (200.0k)` suffix. A non-null `windowSize` would turn that case into a
`null` render, so the "no behavior change" claim would be false.
`compact-countdown` needs a real window size to convert a ratio into tokens, so
it returns `null` when `windowSize` is null.

Fallback order, preserved exactly from the current `context-percent`:

1. `context_window.remaining_percentage` → `ratio = (100 − remaining) / 100`
2. `context_window.used_percentage` → `ratio = used / 100`
3. `context_window.current_usage` summed (input + output + cache creation +
   cache read) over `context_window_size`
4. Legacy: `context_window` as a plain number, with top-level `token_usage`
   summed over it

Returns `null` when no window size is known or no usage basis is available.

`context-percent` is refactored onto the helper with no behavior change. Its two
existing tests in `widgets.test.ts` are the regression net.

Why a shared helper rather than duplicating the chain: the two widgets sit
adjacent on line 1. Deriving both from one function makes them agree by
construction — a disagreement between neighbouring segments would be visible and
would undermine trust in both.

### 2. Rewrite compact-countdown

```
remainingTokens = max(0, windowSize × (AUTOCOMPACT_THRESHOLD − ratio))
```

where `AUTOCOMPACT_THRESHOLD = 1 − 0.165 = 0.835`, keeping the existing buffer
constant unchanged. Returns `null` when `deriveContextUsage` returns `null`.

Display and color behavior are unchanged from the current implementation:

- `~<n>k left` at the configured colors
- amber `#a67c00` when remaining is under 25% of the threshold
- red `#c01c28` when under 10%
- red `Compact imminent!` when at or past the threshold — now a real signal
  rather than a permanent state

### 3. Tests for compact-countdown

New `describe` block in `widgets.test.ts`, using the existing `makeContext`
helper. Written before the rewrite (the long-session case must fail against
current code):

- long session, low current context → a real token figure, not `Compact imminent!`
  (this is the defect above)
- `remaining_percentage` path
- `used_percentage` path
- `current_usage` sum path
- legacy numeric `context_window` + `token_usage` path
- ratio at/past 0.835 → `Compact imminent!`, red
- amber and red threshold boundaries
- no context window → `null`

### 4. Default layout

| | Line 1 | Line 2 |
|---|---|---|
| Before | model, session-cost, context-percent, burn-rate, cache-hit-rate | git-branch, git-changes, lines-changed, today-spend, api-latency, vim-mode |
| After | model, session-cost, context-percent, **compact-countdown**, burn-rate | git-branch, git-changes, lines-changed, today-spend, vim-mode |

`compact-countdown` gets `fg #ffffff`, `bg #1a5fb4`, priority 4 — it must survive
compaction, since runway matters most when space is tight.

Priorities renumbered contiguously (lower = kept first):

| Priority | Widget |
|---|---|
| 1 | model |
| 2 | session-cost |
| 3 | context-percent |
| 4 | compact-countdown |
| 5 | git-branch |
| 6 | today-spend |
| 7 | burn-rate |
| 8 | git-changes |
| 9 | lines-changed |
| (99 default) | vim-mode |

Also fixes an existing cosmetic defect: `git-branch` and `git-changes` are both
`#613583`. `renderPowerlineSegments` draws the separator in `prevBg` over the new
`bg`, so when adjacent segments share a bg the `▶` is invisible and line 2 reads
as one merged purple block. `git-changes` moves to `#7d4fa8`. Verify no other
adjacent pair in the new layout shares a bg: blue, green, teal, blue, grey on
line 1; purple, purple2, teal, green, auto on line 2 — no duplicates adjacent.

`cache-hit-rate` and `api-latency` remain registered and documented, so users can
restore them via `~/.config/gccusage/settings.json`.

### 5. README

The example bar at README lines 6–7 still shows `Cache: 99%` and `API: 9m 55s`.
Update both lines to match the new layout, including a `~28k left` segment. The
widget reference table needs no change — it already lists all 25 widgets,
`compact-countdown` included.

## Test impact

- `loader.test.ts` compares against the `DEFAULT_SETTINGS` constant rather than a
  literal, so it needs no change.
- `pipeline.test.ts` and `statusline.test.ts` pass `DEFAULT_SETTINGS` as input and
  assert on caching identity and cost behavior, not on rendered segment text —
  unaffected.
- `renderer.test.ts` builds its own inline `lines` arrays in every case and never
  imports `DEFAULT_SETTINGS` — unaffected (confirmed).

New guard test: walk every line in `DEFAULT_SETTINGS` and assert that no two
adjacent widgets share a `bg`, and that every `type` resolves via `getWidget`.
The invisible-separator defect was in the shipped defaults for months; this
closes that class of bug rather than just the one instance.

## Out of scope

- The other seven unwired widgets.
- New widgets for stdin fields `StatusJsonSchema` does not currently parse
  (`output_style.name`, `agent.name`, `exceeds_200k_tokens`,
  `workspace.project_dir`, `transcript_path`). `agent.name` is the strongest
  candidate for a follow-up; it needs a schema addition first.
- `powerline.separatorThin` is configured in defaults but never read by
  `renderPowerlineSegments`. Noted, not addressed here.
- Whether the 16.5% auto-compact buffer is still accurate, and whether it differs
  for 1M-context sessions. The constant is carried over unchanged.
