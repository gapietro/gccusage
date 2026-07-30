# Powerline Thin Separator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the boundary between two powerline segments visible even when both resolve to the same background color, by drawing the already-configured-but-never-read `separatorThin` glyph instead of the invisible wide one.

**Architecture:** Split `src/render/powerline.ts` into a styling pass (`layoutPowerline`, which resolves each segment and separator to concrete `{text, fg, bg}` pieces) and a painting pass (`renderPowerlineSegments`, which maps those pieces through chalk). The separator choice lives in the styling pass: wide glyph in the previous segment's `bg` when backgrounds differ, thin glyph in the previous segment's `fg` when they match. Exporting the styling pass lets the defaults sweep test assert against the renderer's real color model instead of a copy of it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, chalk v5, tsdown bundler.

**Spec:** `docs/superpowers/specs/2026-07-30-powerline-thin-separator-design.md`
**Issue:** [#36](https://github.com/gapietro/gccusage/issues/36)

## Global Constraints

- **`dist/index.js` is gitignored but force-tracked.** `gccusage setup` points `statusLine.command` at it, so any commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`. A src-only commit leaves `git pull` upgraders running the old code.
- **Imports use `.js` specifiers** even for TypeScript sources (`from "./themes.js"`). The project is `"type": "module"`.
- **No widget files change.** `compact-countdown` keeps `#b8860b`/`#a01822`; `vim-mode` INSERT keeps `#e5a50a`; `session-cost`, `context-percent` and `today-spend` keep the shared `#a67c00`/`#c01c28` pair. Retiring those shades and centralizing the alert palette are explicitly out of scope (spec, "Out of scope").
- **The non-powerline render path is not touched.** `renderLine`'s `else` branch has a separate, pre-existing spacing defect; issue #36 is scoped to `renderPowerlineSegments`.
- **`renderPowerlineSegments` keeps its exact current signature and return type**, so `src/render/renderer.ts` needs no edit.
- **Test commands:** `npm test` (full suite), `npx vitest run src/__tests__/<file>` (single file), `npm run typecheck`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/render/powerline.ts` | Modify (rewrite, 45 lines) | Resolve widget outputs + theme into colored pieces (`layoutPowerline`), then paint them (`renderPowerlineSegments`) |
| `src/__tests__/renderer.test.ts` | Modify (append a `describe`) | Unit-level proof of the separator decision table |
| `src/__tests__/defaults.test.ts` | Modify (lines 41–172) | Sweep the shipped defaults across every threshold dimension and assert no piece is invisible |
| `README.md` | Modify (after line 87) | Document `separatorThin` now that it does something |

---

## Task 1: Thin separator in the renderer

**Files:**
- Modify: `src/render/powerline.ts` (full rewrite of the 45-line file)
- Modify: `src/__tests__/renderer.test.ts` (append a new `describe` block at end of file)
- Modify: `README.md` (insert a subsection after the "Change theme" block, currently ending line 87)

**Interfaces:**
- Consumes: `WidgetOutput` (`src/widgets/base.js` — `{ text: string; fg?: string; bg?: string }`), `getTheme` (`src/render/themes.js`), `PowerlineOptions` (already exported from `powerline.ts` — `{ theme: string; separator: string; separatorThin: string }`).
- Produces:
  - `export interface PowerlinePiece { text: string; fg: string; bg?: string }` — `bg` is absent only on the closing separator.
  - `export function layoutPowerline(outputs: WidgetOutput[], options: PowerlineOptions): PowerlinePiece[]` — returns segment and separator pieces in render order, all colors resolved against the theme. Task 2 depends on this exact name and shape.
  - `export function renderPowerlineSegments(outputs: WidgetOutput[], options: PowerlineOptions): string` — unchanged signature.

---

- [ ] **Step 1: Write the failing tests**

Append to the end of `src/__tests__/renderer.test.ts`:

```ts
describe("layoutPowerline", () => {
  const OPTIONS = { theme: "default", separator: "▶", separatorThin: "│" };

  it("draws the wide separator in the previous bg when backgrounds differ", () => {
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "#26a269" },
        { text: "b", fg: "#ffffff", bg: "#0d7377" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "▶", fg: "#26a269", bg: "#0d7377" });
  });

  it("draws the thin separator in the previous fg when backgrounds match", () => {
    // session-cost and context-percent both amber: the wide glyph would be
    // painted #a67c00 on #a67c00 and vanish. This is issue #36.
    const pieces = layoutPowerline(
      [
        { text: "$14.21", fg: "#ffffff", bg: "#a67c00" },
        { text: "70%", fg: "#ffffff", bg: "#a67c00" },
      ],
      OPTIONS,
    );
    expect(pieces[1]).toEqual({ text: "│", fg: "#ffffff", bg: "#a67c00" });
  });

  it("compares backgrounds case-insensitively", () => {
    // A hand-written settings.json may use uppercase hex for the same color.
    const pieces = layoutPowerline(
      [
        { text: "a", fg: "#ffffff", bg: "#A67C00" },
        { text: "b", fg: "#ffffff", bg: "#a67c00" },
      ],
      OPTIONS,
    );
    expect(pieces[1]!.text).toBe("│");
  });

  it("emits no inner separator for a single segment", () => {
    const pieces = layoutPowerline([{ text: "solo", fg: "#ffffff", bg: "#1a5fb4" }], OPTIONS);
    expect(pieces).toEqual([
      { text: " solo ", fg: "#ffffff", bg: "#1a5fb4" },
      { text: "▶", fg: "#1a5fb4" },
    ]);
  });

  it("returns nothing for no outputs", () => {
    expect(layoutPowerline([], OPTIONS)).toEqual([]);
  });

  it("falls back to the theme palette when a widget sets no colors", () => {
    const pieces = layoutPowerline([{ text: "a" }, { text: "b" }], OPTIONS);
    expect(pieces[0]).toEqual({ text: " a ", fg: "#ffffff", bg: "#5f5faf" });
    expect(pieces[2]).toEqual({ text: " b ", fg: "#ffffff", bg: "#444444" });
  });
});
```

Add the import at the top of the file, below the existing `import { renderStatusline } from "../render/renderer.js";` on line 2:

```ts
import { layoutPowerline } from "../render/powerline.js";
```

Notes for the implementer:
- `#5f5faf` and `#444444` are `THEMES.default.segments[0].bg` and `[1].bg` (`src/render/themes.ts:15-16`). The theme cycles with `i % 4`.
- Piece indices interleave: `[segment0, separator, segment1, closing]`. So `pieces[1]` is the inner separator and `pieces[2]` is the second segment.
- Segment text is padded to `" a "` — that padding already exists in the current renderer and must be preserved.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/renderer.test.ts`

Expected: FAIL. Vitest reports `No "layoutPowerline" export is defined on the "../render/powerline.js" mock` or a TypeScript/import resolution error — `layoutPowerline` does not exist yet. The pre-existing `renderStatusline` tests in the same file will also fail to load, which is expected at this step.

- [ ] **Step 3: Rewrite `src/render/powerline.ts`**

Replace the entire file contents with:

```ts
import chalk from "chalk";
import type { WidgetOutput } from "../widgets/base.js";
import { getTheme } from "./themes.js";

// Force truecolor output — chalk disables colors when stdout is a pipe,
// but statusline output is rendered by Claude Code which supports ANSI.
chalk.level = 3;

export interface PowerlineOptions {
  theme: string;
  separator: string;
  separatorThin: string;
}

/** A styled run of text. `bg` is absent only for the closing separator. */
export interface PowerlinePiece {
  text: string;
  fg: string;
  bg?: string;
}

function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve widget outputs and the theme into the exact pieces the statusline is
 * painted from. Exported so tests can assert on the real color model rather
 * than re-deriving theme indexing, which would drift out of sync.
 */
export function layoutPowerline(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): PowerlinePiece[] {
  const theme = getTheme(options.theme);
  const pieces: PowerlinePiece[] = [];
  let prev: { fg: string; bg: string } | null = null;

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i]!;
    const style = theme.segments[i % theme.segments.length]!;
    const fg = output.fg ?? style.fg;
    const bg = output.bg ?? style.bg;

    // The wide separator is painted in the previous segment's bg over this
    // segment's bg, so when those match it is invisible and the two segments
    // read as one block. Widgets pick their bg from thresholds at render time,
    // so this is reachable in the shipped defaults — session-cost and
    // context-percent are adjacent and share an alert palette. Fall back to
    // the thin separator, drawn in the previous segment's fg. See issue #36.
    if (prev !== null) {
      pieces.push(
        sameColor(prev.bg, bg)
          ? { text: options.separatorThin, fg: prev.fg, bg }
          : { text: options.separator, fg: prev.bg, bg },
      );
    }

    pieces.push({ text: ` ${output.text} `, fg, bg });
    prev = { fg, bg };
  }

  // Closing separator: painted on the terminal's own background.
  if (prev !== null) {
    pieces.push({ text: options.separator, fg: prev.bg });
  }

  return pieces;
}

export function renderPowerlineSegments(
  outputs: WidgetOutput[],
  options: PowerlineOptions,
): string {
  return layoutPowerline(outputs, options)
    .map((piece) =>
      piece.bg
        ? chalk.hex(piece.fg).bgHex(piece.bg)(piece.text)
        : chalk.hex(piece.fg)(piece.text),
    )
    .join("");
}
```

Note: the old file imported `type SegmentStyle` from `./themes.js` and never used it. The rewrite drops that import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS — all six new `layoutPowerline` cases plus every pre-existing `renderStatusline` case. The pre-existing tests passing is the proof that splitting styling from painting produced byte-identical output for the non-colliding case.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both PASS. `src/__tests__/defaults.test.ts` still passes here because its sweep pins `sessionCostUsd` below `sessionWarn` — Task 2 removes that pin.

- [ ] **Step 6: Verify against the real binary**

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json
echo '{"session_id":"x","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":14.21},"context_window":{"used_percentage":70,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v
```

Expected: a `|` (the `│` thin separator) appears between `$14.21` and `[=======---] 70%`, both still on the amber `48;2;166;124;0` background. Before this change the two ran together with no visible boundary.

Sanity-check the non-colliding case too:

```bash
echo '{"session_id":"x","model":{"id":"claude-opus-4-6"},"cost":{"total_cost_usd":2.10},"context_window":{"used_percentage":30,"context_window_size":200000}}' \
  | node dist/index.js | head -1 | cat -v
```

Expected: `▶` between every segment, unchanged from before.

- [ ] **Step 7: Document `separatorThin` in the README**

It currently appears only in a troubleshooting example, with no explanation of when it is used — because until now it never was. Insert this after the "Available themes" line (currently `README.md:87`), before `### Custom layout`:

```markdown
### Separators

```json
{
  "powerline": { "separator": "▶", "separatorThin": "│" }
}
```

`separator` is drawn between segments of different colors. When two neighbouring
segments resolve to the same background — which happens when, say, session cost
and context usage both cross their warning thresholds at once — the wide glyph
would be invisible, so `separatorThin` is drawn in the previous segment's text
color instead.
```

- [ ] **Step 8: Commit**

```bash
npm run build
git add src/render/powerline.ts src/__tests__/renderer.test.ts README.md
git add -f dist/index.js
git commit -m "Draw the thin separator between same-background segments (#36)

The wide powerline glyph is painted in the previous segment's bg over the
incoming segment's bg, so when those match the seam is invisible and the two
segments read as one block. Reachable in the shipped defaults whenever
session-cost and context-percent warn at the same time — both draw amber
#a67c00 from the shared alert palette.

Split powerline.ts into a styling pass (layoutPowerline, which resolves
outputs and theme into concrete pieces) and a painting pass. The styling pass
falls back to separatorThin, drawn in the previous segment's fg, when
backgrounds match. separatorThin has been in the config schema and defaults
since the beginning and was never read; this is the job it was added for.

Widget colors are unchanged: two widgets warning at once *should* both be
amber, and re-shading one side would not protect user-authored color configs.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Sweep every threshold dimension

**Files:**
- Modify: `src/__tests__/defaults.test.ts` (the `DEFAULT_SETTINGS rendered adjacency` describe block, lines 41–172)

**Interfaces:**
- Consumes: `layoutPowerline` and `PowerlinePiece` from Task 1 (`src/render/powerline.js`), `DEFAULT_SETTINGS` (`src/config/defaults.js`), `getWidget` (`src/widgets/registry.js`).
- Produces: nothing consumed by later tasks.

**Why the existing assertion has to go:** the block currently asserts *"no two adjacent rendered segments share a `bg`"*. After Task 1 that is wrong — sharing a `bg` is legal and is exactly what happens when two widgets warn simultaneously. The invariant it was reaching for is one level down: every piece the renderer emits must be visible against its own background. That single predicate covers separators (a seam you can see) **and** segment text (readable content), and it catches a case the old one could not — a widget whose `fg` equals its own `bg` renders invisible text and would have passed.

---

- [ ] **Step 1: Add the missing sweep dimension**

In `src/__tests__/defaults.test.ts`, add the import below the existing ones at the top of the file:

```ts
import { layoutPowerline } from "../render/powerline.js";
```

Then replace the sweep constants (currently lines 50–58) with:

```ts
  const USAGE_SWEEP = [10, 50, 65, 70, 75, 80, 83.5, 90, 95];
  const WINDOW_SIZE = 200_000;

  // Every widget in the default layout that recolors itself from a threshold
  // gets its own axis. Pinning any one of them hides collisions that only
  // appear in specific combinations — that blind spot is what issue #36 was
  // filed about. sessionWarn 5 / sessionDanger 15, dailyWarn 10 /
  // dailyDanger 25, and vim-mode picks a color per mode.
  const SESSION_SWEEP = [2.5, 8, 20];
  const TODAY_SWEEP = [3, 12, 30];
  const VIM_SWEEP = ["NORMAL", "INSERT"];

  interface SweepPoint {
    used: number;
    session: number;
    today: number;
    vim: string;
  }
```

- [ ] **Step 2: Expand the cross product**

Replace `sweepPoints` (currently lines 66–76) with:

```ts
  function sweepPoints(): SweepPoint[] {
    const points: SweepPoint[] = [];
    for (const used of USAGE_SWEEP) {
      for (const session of SESSION_SWEEP) {
        for (const today of TODAY_SWEEP) {
          for (const vim of VIM_SWEEP) {
            points.push({ used, session, today, vim });
          }
        }
      }
    }
    return points;
  }
```

That is 9 × 3 × 3 × 2 = 162 points.

- [ ] **Step 3: Un-pin `sessionCostUsd`**

In `makeSweepContext`, replace this block (currently lines 102–109):

```ts
      // sessionCostUsd is deliberately held below sessionWarn. session-cost and
      // context-percent are adjacent on line 1 and share the same alert palette
      // (#a67c00 / #c01c28), so they collide once both cross their thresholds.
      // That collision predates the compact-countdown work — those two were
      // already neighbours — and is tracked separately in issue #36. Varying
      // this dimension here would fail the suite on a pre-existing defect
      // rather than on anything this layout changed.
      sessionCostUsd: 2.5,
```

with:

```ts
      sessionCostUsd: point.session,
```

Leave `stdin.cost.total_cost_usd: 2.5` alone — `session-cost` reads `context.sessionCostUsd`, not stdin, and no other widget in the default layout reads that field.

- [ ] **Step 4: Replace the adjacency assertion with a visibility assertion**

Replace `assertNoAdjacentCollision` (currently lines 133–144) with:

```ts
  const POWERLINE_OPTIONS = {
    theme: DEFAULT_SETTINGS.powerline.theme,
    separator: DEFAULT_SETTINGS.powerline.separator,
    separatorThin: DEFAULT_SETTINGS.powerline.separatorThin,
  };

  // The renderer paints separators and segment text from the same resolved
  // {fg, bg} model, so one predicate covers both: a piece whose fg matches its
  // own bg is invisible — an unreadable segment, or a seam that makes two
  // segments read as one block.
  function assertEveryPieceVisible(rendered: Rendered[], point: SweepPoint, mode: string): void {
    const pieces = layoutPowerline(
      rendered.map((r) => r.output),
      POWERLINE_OPTIONS,
    );
    const order = rendered.map((r) => r.type).join(" > ");
    for (const piece of pieces) {
      if (piece.bg === undefined) continue;
      expect(
        piece.fg.toLowerCase(),
        `[${mode}] "${piece.text}" is invisible (fg === bg === ${piece.bg}) at ` +
          `used_percentage=${point.used}, sessionCostUsd=${point.session}, ` +
          `todayCostUsd=${point.today}, vim=${point.vim}. Segments: ${order}`,
      ).not.toBe(piece.bg.toLowerCase());
    }
  }
```

Then update both call sites — line 153 (`"line"` mode) and line 169 (`"compact"` mode) — from `assertNoAdjacentCollision(...)` to `assertEveryPieceVisible(...)`, keeping the same three arguments.

Also update the describe-block comment at lines 42–48 to match the new invariant. Replace it with:

```ts
  // Several widgets (context-percent, compact-countdown, session-cost,
  // today-spend, vim-mode) override bg from thresholds at render time, so a
  // static comparison of configured colors proves nothing. These tests render
  // the real widget outputs across a cross product of every threshold
  // dimension, push them through the renderer's own styling pass, and assert
  // nothing comes out invisible.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/defaults.test.ts`
Expected: PASS, all 162 sweep points, in both `line` and `compact` mode.

- [ ] **Step 6: Prove the widened sweep has teeth**

A test that passes is worthless if it would also pass without the fix. Temporarily break Task 1's fix and confirm this suite catches it.

In `src/render/powerline.ts`, change:

```ts
        sameColor(prev.bg, bg)
```

to:

```ts
        false && sameColor(prev.bg, bg)
```

Run: `npx vitest run src/__tests__/defaults.test.ts`

Expected: **FAIL**, with a message naming the collision — `"▶" is invisible (fg === bg === #a67c00) at used_percentage=70, sessionCostUsd=8, todayCostUsd=3, vim=NORMAL. Segments: model > session-cost > context-percent > compact-countdown > burn-rate`.

This is the defect from issue #36, now surfaced as a named failure. Confirm the failure message appears, then **revert the edit** (`git checkout src/render/powerline.ts`) and re-run to confirm PASS.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/__tests__/defaults.test.ts
git commit -m "Sweep session cost in the defaults adjacency test (#36)

The sweep pinned sessionCostUsd below sessionWarn with a comment pointing at
issue #36, so it varied one threshold dimension while holding the rest still
and never exercised a multi-widget threshold interaction. The suite read as
covering the shipped bar while a known defect shipped.

Session cost joins the cross product (162 points), and the assertion moves
from 'no two adjacent segments share a bg' — which the thin separator makes
wrong, since sharing a bg is now legal — to 'no piece the renderer emits is
invisible against its own background'. That predicate covers separators and
segment text alike, and catches a widget whose fg matches its own bg, which
the old one could not.

Verified the widened sweep fails when the thin-separator branch is disabled.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

Note: this task touches only a test file, so `dist/index.js` is unchanged and needs no re-staging. Confirm with `git status` that `dist/index.js` is not listed as modified before committing.

---

## Task 3: Ship it

**Files:** none modified — this task is branch and PR mechanics.

**Interfaces:**
- Consumes: the two commits from Tasks 1 and 2.
- Produces: a pull request closing issue #36.

---

- [ ] **Step 1: Confirm the working tree is clean and the build is current**

```bash
npm test && npm run typecheck && npm run build && git status --short
```

Expected: tests and typecheck PASS, and `git status --short` prints nothing. If `dist/index.js` shows as modified, the Task 1 commit did not stage a current build — amend it with `git add -f dist/index.js && git commit --amend --no-edit`.

- [ ] **Step 2: Push the branch**

The branch `fix-36-powerline-thin-separator` was created before Task 1, carrying the spec and this plan; `main` was reset to `origin/main`. Confirm you are on it, then push:

```bash
git rev-parse --abbrev-ref HEAD   # expect: fix-36-powerline-thin-separator
git push -u origin fix-36-powerline-thin-separator
```

- [ ] **Step 3: Open the pull request**

```bash
gh pr create --title "Draw the thin separator between same-background segments (#36)" --body "$(cat <<'EOF'
Closes #36.

## Problem

`renderPowerlineSegments` paints every separator as the wide `▶` in the
**previous** segment's runtime `bg`, over the **incoming** segment's `bg`. When
those match the glyph is the same color as the surface behind it: the seam
disappears and two segments read as one block.

`session-cost` and `context-percent` are adjacent on line 1 of the defaults and
both draw amber `#a67c00` / red `#c01c28` from the shared alert palette, so this
is reachable in ordinary use — cost ≥ $5 with context ≥ 70%.

## Approach

The shared palette is not the defect. Two adjacent widgets both showing amber is
*correct* — both are warning at once. Giving each widget its own shade would
dilute that signal to work around a rendering limitation, and it is whack-a-mole:
every new adjacency needs a new color, and user-authored `settings.json` colors
stay unprotected no matter how many ship.

So the renderer is fixed instead. Powerline's standard answer is the thin
separator, and this codebase already carries it — `powerline.separatorThin` is in
the schema, in the defaults, plumbed through `renderer.ts`, and read by nothing.
This is the job it was added for.

`powerline.ts` splits into a styling pass (`layoutPowerline`, resolving outputs
and theme into concrete `{text, fg, bg}` pieces) and a painting pass.
`renderPowerlineSegments` keeps its signature; `renderer.ts` is untouched.
Background comparison is case-insensitive, so hand-written uppercase hex in a
user config matches too.

## Tests

The sweep in `defaults.test.ts` pinned `sessionCostUsd` below `sessionWarn` with
a comment pointing at this issue — it swept one threshold dimension while holding
the rest still, so no multi-widget interaction was ever exercised. Session cost
now joins the cross product (162 points).

The assertion also moves down a level. "No two adjacent segments share a bg"
becomes wrong under this fix, since sharing a bg is now legal; it is replaced by
"no piece the renderer emits is invisible against its own background", which
covers separators and segment text alike and catches a widget whose `fg` matches
its own `bg`. `layoutPowerline` is exported so the test asserts against the
renderer's real color model rather than a copy that could drift.

Verified the widened sweep fails when the thin-separator branch is disabled.

## Not in scope

- No widget colors change. `compact-countdown` keeps `#b8860b`/`#a01822` and
  `vim-mode` INSERT keeps `#e5a50a` — those shades were collision workarounds and
  are now redundant, but retiring them is visual churn for existing users.
- No shared alert-palette module. The issue's third point stays open: with the
  renderer fixed it is a code-organization preference, not a defect.
- The non-powerline path joins segments with no padding at all, so neighbours run
  together regardless of color. Real, but a different bug.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Verify the PR contents**

Run: `gh pr view --json files -q '.files[].path'`

Expected: `README.md`, `dist/index.js`, `src/__tests__/defaults.test.ts`, `src/__tests__/renderer.test.ts`, `src/render/powerline.ts`, plus the two docs under `docs/superpowers/`. No file under `src/widgets/` may appear. If `dist/index.js` is missing, the bundle was not staged and `git pull` upgraders will keep running the old code — fix before requesting review.

---

## Verification Checklist

- [ ] `npm test` passes, including 162 sweep points in both line and compact mode
- [ ] `npm run typecheck` passes
- [ ] Disabling the thin-separator branch makes `defaults.test.ts` fail with a named collision
- [ ] The reproduce command from issue #36 shows a `│` between the two amber segments
- [ ] A non-colliding render still shows `▶` everywhere, unchanged
- [ ] `dist/index.js` is staged in the same commit as the `src/render/powerline.ts` change
- [ ] No widget file appears in the diff
