# Adaptive segment shrinking — design

Issue: [#70](https://github.com/gapietro/gccusage/issues/70)
Date: 2026-08-01

## Problem

Line 2 of the default layout has no upper bound on its rendered width. Two of
its segments are sized by strings the user does not control from config:

- `project` renders `basename(workspace.project_dir)` — as long as the
  directory name
- `git-branch` renders the branch name — as long as the branch name

Measured against the real captured payloads while fixing #67, with the git
widgets genuinely executing:

| segment | cost, incl. separator + padding |
| --- | --- |
| project | 20 |
| git-branch | 29 |
| git-changes | 5 |
| lines-changed | 11 |
| today-spend | 14 |
| vim-mode | 9 |
| **line 2 total** | **88** |

Line 1 measures 70–72 across all three fixtures and is not at risk. 29 of those
88 columns are a single branch name. A longer branch or repo directory pushes
line 2 arbitrarily wide, and `truncateAnsi` cuts it mid-word.

#67 made the terminal width real, so the bar is now measured against the actual
terminal. That fixed the measurement, not the growth: no fixed
`compact.threshold` can guarantee a line fits when the line's width is
unbounded.

## What this is not

**#70 as filed proposed implementing the declared-but-dead `maxWidth` config
field.** That is not what this design does, and the difference is deliberate.

A fixed per-widget cap trims characters even when the terminal had room —
`gccusage` becomes `gccus…` on a 200-column display for no reason. The
requirement settled during design is that a segment shortens **only when the
line would otherwise not fit**.

Consequences:

- **No new config field.** `maxWidth` stays unreclaimed and undocumented.
- **`custom-command`'s abuse of `maxWidth` as a cache TTL
  (`src/widgets/custom-command.ts:22`) is untouched and out of scope.** It is a
  real wart — an undocumented field meaning something unrelated to its name —
  but it is not this issue's wart. It should be filed separately rather than
  smuggled into this change.

`maxWidth` is documented nowhere user-facing: `README.md`'s widget options table
lists only `type`, `fg`, `bg`, `label`, and `priority`. That is why reclaiming
it would have been cheap — and also why not reclaiming it costs nothing.

## Approaches considered

**A. The widget declares shrinkability.** Chosen. `WidgetOutput` gains
`shrinkable?: boolean`; `project` and `git-branch` set it. The knowledge lives
with the widget that has it, and extending to `cwd` later is one flag.

**B. A central allowlist of widget types in the renderer.** One place to read,
but it is action-at-a-distance: adding a shrinkable widget means editing a list
in a file you are not otherwise touching, with nothing linking the two.

**C. Widgets return `{prefix, value}` so the renderer elides only the value.**
Most precise — it could never eat a label or icon. But it reshapes the `Widget`
interface for the sake of two widgets. YAGNI.

### Why a boolean is sufficient

In both shrinkable widgets the growing part is already the **suffix**:
`project` renders `label + name`, `git-branch` renders `icon + label + branch`.
Right-trimming the whole text therefore cannot eat a label or icon. This
assumption is what the flag carries, and it must be re-checked before setting
`shrinkable` on any widget whose variable part is not last.

## Design

### The shrink pass

New pure module:

```
src/render/shrink.ts
  shrinkOutputs(outputs: WidgetOutput[], overflow: number): WidgetOutput[]
```

It knows nothing about terminals or rendering — only "remove `overflow` columns
from these outputs". `renderLine` measures the line's natural width with the
existing `measureLine`, and when that exceeds the available width, passes the
difference in and renders the returned outputs instead.

Algorithm: repeatedly take the **widest** shrinkable segment and trim it, until
the overflow is absorbed or every shrinkable segment sits at its floor.
Widest-first keeps segments even rather than destroying one while another stays
long. A trimmed segment ends in `…`, which costs one of its columns.

### The floor

A single module constant. A branch trimmed below roughly 8 visible characters
no longer distinguishes one branch from another, so the columns stop buying
anything. Not configurable: there is no evidence anyone needs to tune it, and a
knob would need documenting, validating, and testing.

### Two details that bite otherwise

- **Slice by code points, not code units.** `String.prototype.slice` splits a
  surrogate pair mid-character, so a branch name containing an emoji or any
  astral-plane character would produce a broken glyph. Iterate code points.
- **`visibleLength` counts code units**, so wide/CJK glyphs already mis-measure
  everywhere in this codebase. That is pre-existing and explicitly not fixed
  here; the shrink code must simply not make it worse.

### Unknown width means no shrinking

This falls out of the existing design and must stay that way. `measureLine`
measures by calling `renderLine` with `terminalWidth: undefined`; if shrink
fired at unknown width, the measurement would be of an already-shrunk line and
`renderCompact` would misfit. Same rule as truncation and flex padding: unknown
means leave the output alone.

### Mode independence

Powerline adds 3 columns per segment and plain adds 0, but that overhead is
constant under trimming — removing one character of text removes exactly one
column of line in both modes. The overflow arithmetic therefore needs no
per-mode branch.

### Degradation

- Every shrinkable segment at its floor and the line still too wide →
  `truncateAnsi` cuts it exactly as today. No new failure mode.
- No shrinkable segments on the line → behaviour byte-identical to current.

### Deliberate non-goal: compact mode

`renderCompact` is unchanged. It drops segments by priority, which is its job;
a long branch there still pushes out low-priority widgets. Adding shrink to
both paths doubles the interaction surface for a mode that is already a
degraded fallback.

## Testing

This branch's predecessor shipped four tests that asserted nothing (see the
`vacuous-tests` note). Each test below is verified by breaking what it guards.

1. **`shrinkOutputs` unit tests** — pure function: no shrink at zero overflow;
   widest-first ordering; floor respected; the `…` accounted for in the
   resulting width; code-point slicing on an emoji-bearing name; and the
   exhausted case returning everything at floor rather than looping forever.
2. **Renderer integration** — a long branch on a terminal wide enough for a
   shrunk line renders **shrunk, not truncated**: the branch segment ends in
   `…` while the line itself was never cut by `truncateAnsi`.
3. **The natural-width invariant test, extended** — `renderLine` at unknown
   width must neither pad, truncate, **nor shrink**. `measureLine` rests on
   this and it now has a third way to break.
4. **`default-layout-width.test.ts`, extended** — the existing throwaway-repo
   harness gets a deliberately long branch name; line 2 must fit
   `SUPPORTED_WIDTH` where today it truncates at 88.
5. **Mutation check** — disable the shrink pass and confirm 2 and 4 fail.

Test 5 is the one that matters most. A shrink pass is exactly the kind of
feature whose tests pass because `truncateAnsi` cleaned up afterwards and the
width assertion was satisfied either way — that was finding #2 of the #67 final
review, and it will reappear here unless the tests assert **content**, not
width.

## Build requirement

`dist/index.js` is gitignored but force-tracked, and `gccusage setup` points
`statusLine.command` at it. Any commit touching `src/` must run `npm run build`
and stage the bundle in that same commit, or upgraders who `git pull` keep
running the old code.

## Out of scope

- Reclaiming `maxWidth`, and `custom-command`'s use of it as a cache TTL — file
  separately.
- Shrinking in compact mode.
- Fixing `visibleLength` for wide/CJK glyphs.
- The remaining open issues (#69, #68, #64, #63, #62, #61, #60, #58, #46).
