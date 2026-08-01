# Adaptive Segment Shrinking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop line 2 of the default bar truncating mid-word when a project or branch name is long, by shortening only those segments and only when the line would otherwise not fit.

**Architecture:** `WidgetOutput` gains an optional `shrinkable` flag that `project` and `git-branch` set. A pure `shrinkOutputs(outputs, overflow)` trims the widest shrinkable segment first, down to a floor, ending each trimmed segment in `…`. `renderLine` measures the natural width, and when it exceeds the terminal width, renders the shrunk outputs instead. `truncateAnsi` stays as the unchanged backstop.

**Tech Stack:** TypeScript, tsdown (bundler), vitest, valibot.

Spec: `docs/superpowers/specs/2026-08-01-segment-shrink-design.md`
Issue: [#70](https://github.com/gapietro/gccusage/issues/70)

## Global Constraints

- **Every commit that touches `src/` must run `npm run build` and stage the bundle**: `git add -f dist/index.js`. `dist/` is gitignored but force-tracked, and `gccusage setup` points `statusLine.command` at it, so a src-only commit leaves everyone who `git pull`s running the old code. A commit touching only `src/__tests__/` produces no bundle change — verify with `npm run build && git status --porcelain` rather than assuming.
- `npm test` and `npm run typecheck` must pass at the end of every task.
- **No new config field.** `maxWidth` is not reclaimed, and `src/widgets/custom-command.ts:22` (which uses `maxWidth` as a cache TTL) must not be touched. That wart is real but belongs to its own issue.
- **Unknown terminal width means no shrinking**, exactly as it already means no padding and no truncation.
- `vitest.config.ts` pins `include` to `src/**/__tests__/**/*.test.ts` and `scripts/**/__tests__/**/*.test.ts`. A test file outside those roots silently never runs.
- package.json is `"type": "module"` — `__dirname` does not exist.
- Do not change `renderCompact`. Compact mode drops by priority; shrinking there is an explicit non-goal.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

### Task 1: The pure shrink pass

**Files:**
- Create: `src/render/shrink.ts`
- Create: `src/__tests__/shrink.test.ts`

**Interfaces:**
- Consumes: `WidgetOutput` from `src/widgets/base.js` (currently `{text, fg?, bg?}` — Task 2 adds `shrinkable?: boolean`; this task declares that field's use but Task 2 owns adding it to the interface, so add it there first if typechecking complains)
- Produces:
  - `shrinkOutputs(outputs: WidgetOutput[], overflow: number): WidgetOutput[]`
  - `MIN_SHRUNK_TEXT: number` (exported for tests)

**Note on ordering:** this task needs `WidgetOutput.shrinkable` to exist for `npm run typecheck` to pass. Add the field to `src/widgets/base.ts` here (the two-line interface change shown in Task 2 Step 1); Task 2 then only has to set it on the two widgets.

- [ ] **Step 1: Add the `shrinkable` field so this module can compile**

In `src/widgets/base.ts`, extend the interface:

```ts
export interface WidgetOutput {
  text: string;
  fg?: string;
  bg?: string;
  /**
   * May this segment's text be trimmed from the right when the line would not
   * otherwise fit? Only set it on widgets whose variable-length part is the
   * SUFFIX of `text`: `project` renders `label + name` and `git-branch` renders
   * `icon + label + branch`, so right-trimming cannot eat a label or icon.
   * Re-check that before setting it on any new widget.
   */
  shrinkable?: boolean;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/__tests__/shrink.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shrinkOutputs, MIN_SHRUNK_TEXT } from "../render/shrink.js";
import { visibleLength } from "../utils/terminal.js";
import type { WidgetOutput } from "../widgets/base.js";

function shrinkable(text: string): WidgetOutput {
  return { text, shrinkable: true };
}

describe("shrinkOutputs", () => {
  it("returns the outputs untouched when there is no overflow", () => {
    const outputs = [shrinkable("feature/some-branch"), { text: "Today: $2.10" }];
    expect(shrinkOutputs(outputs, 0)).toEqual(outputs);
    expect(shrinkOutputs(outputs, -5)).toEqual(outputs);
  });

  it("never trims a segment that is not marked shrinkable", () => {
    const outputs = [{ text: "Today: $2.10" }, { text: "In: 122" }];
    expect(shrinkOutputs(outputs, 10)).toEqual(outputs);
  });

  it("removes exactly the requested overflow", () => {
    const outputs = [shrinkable("feature/a-fairly-long-branch-name")];
    const before = visibleLength(outputs[0]!.text);
    const after = shrinkOutputs(outputs, 7);
    expect(before - visibleLength(after[0]!.text)).toBe(7);
  });

  it("ends a trimmed segment in an ellipsis, counted in its width", () => {
    const after = shrinkOutputs([shrinkable("abcdefghijklmnop")], 4);
    expect(after[0]!.text).toBe("abcdefghijk…");
    expect(visibleLength(after[0]!.text)).toBe(12);
  });

  it("trims the widest segment first rather than the first one", () => {
    const outputs = [shrinkable("short-name"), shrinkable("a-much-longer-branch-name")];
    const after = shrinkOutputs(outputs, 3);
    expect(after[0]!.text).toBe("short-name");
    expect(visibleLength(after[1]!.text)).toBe(visibleLength(outputs[1]!.text) - 3);
  });

  it("levels the two widest segments before trimming either below the other", () => {
    // 20 and 10 wide; removing 8 should come off the wider one, taking it down
    // toward its neighbour rather than annihilating it.
    const outputs = [shrinkable("x".repeat(20)), shrinkable("y".repeat(10))];
    const after = shrinkOutputs(outputs, 8);
    const widths = after.map((o) => visibleLength(o.text));
    expect(widths[0]! + widths[1]!).toBe(22);
    expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(2);
  });

  it("never trims a segment below the floor", () => {
    const outputs = [shrinkable("abcdefghijklmnop")];
    const after = shrinkOutputs(outputs, 1000);
    expect(visibleLength(after[0]!.text)).toBe(MIN_SHRUNK_TEXT);
  });

  it("stops when every shrinkable segment is at the floor instead of looping", () => {
    const outputs = [shrinkable("abcdefghijklmnop"), shrinkable("qrstuvwxyz")];
    const after = shrinkOutputs(outputs, 10_000);
    expect(after.map((o) => visibleLength(o.text))).toEqual([
      MIN_SHRUNK_TEXT,
      MIN_SHRUNK_TEXT,
    ]);
  });

  it("slices by code points so an astral character is never split", () => {
    // Each rocket is one code point but TWO UTF-16 code units, and
    // visibleLength counts code units — so 20 rockets measure as 40 columns.
    // The overflow must exceed 20 to force an actual trim; a smaller one
    // leaves the text untouched and the test proves nothing.
    const after = shrinkOutputs([shrinkable("\u{1F680}".repeat(20))], 25);

    // Trimming really happened.
    expect(after[0]!.text).not.toBe("\u{1F680}".repeat(20));
    // No lone surrogate anywhere, and every retained char is a whole rocket.
    expect(after[0]!.text).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(
      Array.from(after[0]!.text).every((c) => c === "\u{1F680}" || c === "…"),
    ).toBe(true);
  });

  it("does not mutate the outputs it was given", () => {
    const outputs = [shrinkable("a-much-longer-branch-name")];
    const original = outputs[0]!.text;
    shrinkOutputs(outputs, 6);
    expect(outputs[0]!.text).toBe(original);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/shrink.test.ts`
Expected: FAIL — "Failed to resolve import ../render/shrink.js".

- [ ] **Step 4: Implement the module**

Create `src/render/shrink.ts`:

```ts
import type { WidgetOutput } from "../widgets/base.js";
import { visibleLength } from "../utils/terminal.js";

/**
 * Fewest visible columns a shrunk segment may keep, ellipsis included.
 *
 * Below roughly this width a branch name stops distinguishing one branch from
 * another, so the columns buy nothing. Deliberately not configurable: a knob
 * would need documenting, validating and testing, and nothing yet suggests
 * anyone wants to tune it.
 */
export const MIN_SHRUNK_TEXT = 8;

const ELLIPSIS = "…";

/**
 * `text` reduced to exactly `width` visible columns, ending in an ellipsis.
 *
 * Slices by code point: `String.prototype.slice` would cut a surrogate pair in
 * half, so a branch name containing an emoji would render as a broken glyph.
 */
function trimTo(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  // Drop whole code points until the result FITS BY THE SAME MEASURE the
  // caller uses. Comparing code-point count against a visibleLength budget
  // would return `text` unchanged for astral characters (which are one code
  // point but two code units), and the caller's loop would then spin forever
  // making no progress.
  let chars = Array.from(text);
  while (chars.length > 0 && visibleLength(chars.join("") + ELLIPSIS) > width) {
    chars = chars.slice(0, -1);
  }
  return chars.join("") + ELLIPSIS;
}

/**
 * The same outputs with `overflow` visible columns removed from segments that
 * allow it, or as many as the floor permits.
 *
 * Trims the widest shrinkable segment first, which levels segments rather than
 * destroying one while another stays long. Callers pass the amount a line
 * exceeds the terminal by; this module knows nothing about terminals or
 * rendering. Never mutates its argument.
 */
export function shrinkOutputs(
  outputs: WidgetOutput[],
  overflow: number,
): WidgetOutput[] {
  if (overflow <= 0) return outputs;

  const result = outputs.map((output) => ({ ...output }));
  let remaining = overflow;

  while (remaining > 0) {
    let widest = -1;
    let widestWidth = 0;
    for (let i = 0; i < result.length; i++) {
      const output = result[i]!;
      if (!output.shrinkable) continue;
      const width = visibleLength(output.text);
      if (width > MIN_SHRUNK_TEXT && width > widestWidth) {
        widest = i;
        widestWidth = width;
      }
    }
    // Every shrinkable segment sits at the floor; the caller's truncation is
    // the backstop from here.
    if (widest === -1) break;

    // Take this segment down toward the next-widest rather than all the way in
    // one go, so a single long segment cannot be annihilated while a nearly-as-
    // long neighbour is left untouched.
    const runnerUp = Math.max(
      MIN_SHRUNK_TEXT,
      ...result
        .filter((o, i) => o.shrinkable && i !== widest)
        .map((o) => visibleLength(o.text)),
    );
    const target = Math.max(MIN_SHRUNK_TEXT, runnerUp, widestWidth - remaining);
    // `widestWidth > MIN_SHRUNK_TEXT` and `remaining >= 1`, so `target` is
    // always strictly less than `widestWidth` — the loop cannot spin.
    const capped = Math.min(target, widestWidth - 1);

    const trimmed = trimTo(result[widest]!.text, capped);
    remaining -= widestWidth - visibleLength(trimmed);
    result[widest] = { ...result[widest]!, text: trimmed };
  }

  return result;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/shrink.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Run the full suite and typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS. Nothing consumes `shrinkOutputs` yet, so no existing behaviour changes.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/render/shrink.ts src/widgets/base.ts src/__tests__/shrink.test.ts
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Add a pure segment-shrinking pass (#70)

Trims the widest shrinkable segment first, down to a floor, ending each
trimmed segment in an ellipsis. Slices by code point so an emoji in a
branch name is never split mid-character. Nothing calls it yet.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shrink when the line would not fit

**Files:**
- Modify: `src/widgets/project.ts`
- Modify: `src/widgets/git-branch.ts`
- Modify: `src/render/renderer.ts` (`renderLine`)
- Modify: `src/__tests__/renderer.test.ts` (the `describe` at line 669)

**Interfaces:**
- Consumes: `shrinkOutputs(outputs: WidgetOutput[], overflow: number): WidgetOutput[]` from `src/render/shrink.js`; `WidgetOutput.shrinkable?: boolean` from `src/widgets/base.js`
- Produces: no new exports; `renderLine`'s behaviour changes for callers with a known width

**THE RECURSION HAZARD — read before writing any code.** `renderLine` will call `measureLine` to learn the natural width, and `measureLine` is implemented by calling `renderLine` with `terminalWidth: undefined`. The guard that stops this recursing forever is that the shrink block only runs when `context.terminalWidth !== undefined`. Write the width check FIRST, and put the `measureLine` call inside it. If you call `measureLine` unconditionally, the suite will hang rather than fail.

- [ ] **Step 1: Mark the two widgets shrinkable**

In `src/widgets/project.ts`, change the returned output:

```ts
    return { text, fg: config.fg, bg: config.bg, shrinkable: true };
```

In `src/widgets/git-branch.ts`, change the returned output:

```ts
    return { text, fg: config.fg, bg: config.bg, shrinkable: true };
```

Both are safe because the variable-length part is the suffix in each: `project` builds `label + name`, `git-branch` builds `icon + label + branch`.

- [ ] **Step 2: Write the failing tests**

Append to `src/__tests__/renderer.test.ts`:

```ts
describe("long segments shrink to fit instead of truncating the line", () => {
  const LONG_BRANCH = "feature/an-extremely-long-branch-name-goes-here";

  function settingsWith(powerlineOn: boolean): Settings {
    return makeSettings({
      lines: [
        {
          widgets: [
            { type: "custom-text", text: "Today: $2.10" },
            { type: "custom-text", text: LONG_BRANCH },
          ],
          flex: "left",
        },
      ],
      powerline: {
        enabled: powerlineOn,
        theme: "default",
        separator: "▶",
        separatorThin: "│",
      },
      compact: { mode: "never", threshold: 80 },
    });
  }

  // custom-text is not shrinkable, so drive the shrink path through the real
  // widgets instead: a context whose project_dir and cwd produce long names.
  function longNameContext(width: number | undefined): RenderContext {
    return makeContext({
      terminalWidth: width,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        workspace: { project_dir: "/tmp/an-extremely-long-project-directory-name" },
      },
    });
  }

  const projectSettings = makeSettings({
    lines: [
      {
        widgets: [
          { type: "project" },
          { type: "custom-text", text: "Today: $2.10" },
        ],
        flex: "left",
      },
    ],
    powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
    compact: { mode: "never", threshold: 80 },
  });

  it("shrinks the project segment rather than cutting the line", () => {
    const natural = visibleLength(
      renderStatusline(longNameContext(undefined), projectSettings),
    );
    const budget = natural - 6;

    const line = stripAnsi(renderStatusline(longNameContext(budget), projectSettings));

    // The line fits...
    expect(visibleLength(line)).toBeLessThanOrEqual(budget);
    // ...the unshrinkable segment survived intact...
    expect(line).toContain("Today: $2.10");
    // ...and the shrunk segment carries the ellipsis, not the line's tail.
    expect(line).toContain("…");
    expect(line.trimEnd().endsWith("…")).toBe(false);
  });

  it("leaves everything alone when the line already fits", () => {
    const natural = visibleLength(
      renderStatusline(longNameContext(undefined), projectSettings),
    );
    const roomy = stripAnsi(renderStatusline(longNameContext(natural + 20), projectSettings));

    expect(roomy).toContain("an-extremely-long-project-directory-name");
    expect(roomy).not.toContain("…");
  });

  it("falls back to truncation when shrinking to the floor is not enough", () => {
    const line = stripAnsi(renderStatusline(longNameContext(14), projectSettings));
    expect(visibleLength(line)).toBeLessThanOrEqual(14);
  });
});
```

Then extend the existing `describe("renderLine at unknown terminal width neither pads nor truncates")` block at `src/__tests__/renderer.test.ts:669` with a third case:

```ts
  it("does not shrink either — measureLine depends on this", () => {
    const context = makeContext({
      terminalWidth: undefined,
      stdin: {
        model: "claude-sonnet-4-20250514",
        cost: { total_cost_usd: 2.45 },
        workspace: { project_dir: "/tmp/an-extremely-long-project-directory-name" },
      },
    });
    const settings = makeSettings({
      lines: [{ widgets: [{ type: "project" }], flex: "left" }],
      powerline: { enabled: true, theme: "default", separator: "▶", separatorThin: "│" },
      compact: { mode: "never", threshold: 80 },
    });

    const line = stripAnsi(renderStatusline(context, settings));
    expect(line).toContain("an-extremely-long-project-directory-name");
    expect(line).not.toContain("…");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: FAIL. "shrinks the project segment rather than cutting the line" fails because the line is truncated at its tail rather than shrunk — the assertion that the line does not end in `…` is the one that catches it.

- [ ] **Step 4: Wire the shrink pass into `renderLine`**

In `src/render/renderer.ts`, add the import:

```ts
import { shrinkOutputs } from "./shrink.js";
```

Then change the top of `renderLine`:

```ts
function renderLine(
  outputs: WidgetOutput[],
  settings: Settings,
  context: RenderContext,
  flex: FlexMode,
): string {
  const powerline = settings.powerline;
  const isPowerline = powerline?.enabled ?? false;

  // Shrink over-long segments before laying out, so a long branch name costs
  // its own tail rather than the tail of the whole line.
  //
  // The width check MUST come before the measureLine call: measureLine renders
  // through this same function with terminalWidth undefined, so an
  // unconditional call here would recurse forever. Unknown width means "leave
  // the output alone", the same rule applyFlex and truncateAnsi follow — which
  // is exactly what makes measureLine's result a true natural width.
  let laidOut = outputs;
  if (context.terminalWidth !== undefined) {
    const natural = measureLine(outputs, settings, context);
    if (natural > context.terminalWidth) {
      laidOut = shrinkOutputs(outputs, natural - context.terminalWidth);
    }
  }

  let line: string;
  if (isPowerline && powerline) {
    const nonSeparator = laidOut.filter(
      (o) => o.text !== " | " && o.text.trim() !== "|",
    );
    line = renderPowerlineSegments(nonSeparator, {
      theme: powerline.theme ?? "default",
      separator: powerline.separator ?? "\uE0B0",
      separatorThin: powerline.separatorThin ?? "\u2502",
    });
  } else {
    const segments = laidOut.map((o) => colorize(o.text, o.fg, o.bg));
    line = applyFlex(segments, context.terminalWidth, flex);
  }

  return truncateAnsi(line, context.terminalWidth);
}
```

Note both branches now read `laidOut`, not `outputs`. Leave `renderCompact` untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: PASS.

If the run HANGS instead of failing, the width guard is in the wrong place — `measureLine` is recursing. Move the `measureLine` call inside the `context.terminalWidth !== undefined` check.

- [ ] **Step 6: Verify the tests detect the shrink pass disappearing**

Temporarily replace the shrink block body with `laidOut = outputs;` so no shrinking happens, and rerun.

Run: `npx vitest run src/__tests__/renderer.test.ts`
Expected: FAIL on "shrinks the project segment rather than cutting the line".

Then restore the real block, confirm `git diff src/render/renderer.ts` shows only the intended change, and rerun to PASS. Report the observed failure output — a shrink test that stays green with shrinking disabled is worthless, and this suite has shipped exactly that mistake before.

- [ ] **Step 7: Run the full suite and typechecker**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
npm run build
git add src/render/renderer.ts src/widgets/project.ts src/widgets/git-branch.ts src/__tests__/renderer.test.ts
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Shrink long project and branch segments to fit the line (#70)

renderLine now measures the natural width and, when it exceeds the
terminal, trims the widest shrinkable segment instead of letting
truncateAnsi cut the line's tail. project and git-branch opt in; their
variable-length part is the suffix, so right-trimming cannot eat a label.

Unknown width still shrinks nothing, which is also what stops measureLine
recursing through renderLine.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Pin the default bar against a long branch, and document the behaviour

**Files:**
- Modify: `src/__tests__/default-layout-width.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

- [ ] **Step 1: Read the existing harness before changing it**

Open `src/__tests__/default-layout-width.test.ts` and read `makeDeterministicGitRepo`. It builds a throwaway git repo with a fixed branch name so `git-branch` and `git-changes` genuinely execute rather than silently returning `null` — that silent-null case is why an earlier version of this test measured four of six segments and reported the layout as fitting. It also neutralises the developer's global git config, including `core.excludesFile` and `GIT_CONFIG_COUNT`.

Do not restructure it. You are adding one case.

- [ ] **Step 2: Add the long-branch case**

Add a test that builds the repo with a deliberately long branch name and asserts the default two-line layout fits `SUPPORTED_WIDTH` — where before this work it would have truncated. Use the existing helper's branch-name parameter if it has one; if the branch name is hardcoded, thread a parameter through it rather than duplicating the helper.

```ts
  it("fits a long branch name by shrinking rather than truncating", () => {
    const repo = makeDeterministicGitRepo("feature/an-extremely-long-branch-name-here");
    try {
      const context = { /* same construction the busiest-bar test uses, with repo.dir as cwd */ };
      const line2 = stripAnsi(renderStatusline(context, DEFAULT_SETTINGS)).split("\n")[1] ?? "";

      // Fits...
      expect(visibleLength(line2)).toBeLessThanOrEqual(SUPPORTED_WIDTH);
      // ...every segment still present...
      expect(line2).toContain("Today:");
      // ...and the loss was taken inside a segment, not off the line's end.
      expect(line2).toContain("…");
      expect(line2.trimEnd().endsWith("…")).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
```

Match the surrounding file's actual construction of the context and its cleanup convention — the block above shows the assertions, which are the part that matters; the setup must follow whatever the neighbouring tests already do.

- [ ] **Step 3: Run it and verify it fails without the feature**

Run: `npx vitest run src/__tests__/default-layout-width.test.ts`
Expected: PASS with the shrink pass in place.

Then stash the shrink block in `renderLine` (replace its body with `laidOut = outputs;`), rebuild is not needed for vitest, and rerun.
Expected: FAIL — the line ends in `…` from `truncateAnsi`.
Restore afterwards and confirm `git diff src/render/renderer.ts` is empty.

- [ ] **Step 4: Document the behaviour in the README**

The shrink pass takes no configuration, so there is nothing to add to the widget options table. Add a short paragraph to the compact-mode section explaining what a user will observe, since the `…` inside a segment is otherwise unexplained:

```markdown
Before collapsing, long project and branch names are shortened with an
ellipsis so the rest of the line survives — and only when the line would not
otherwise fit. On a wide terminal nothing is shortened.
```

Verify each sentence against `renderLine` and `shrinkOutputs` before committing it. The README has already shipped one claim the code did not support (issue #67); do not add a second.

- [ ] **Step 5: Full verification**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS, and `git status --porcelain` clean after the build.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/__tests__/default-layout-width.test.ts README.md
git add -f dist/index.js
git commit -m "$(cat <<'EOF'
Pin the default bar against a long branch name (#70)

The busiest realistic line 2 measured 88 columns with a 26-character
branch; it now fits by shrinking the branch segment rather than losing the
line's tail. README explains the ellipsis a user will see.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `WidgetOutput.shrinkable?: boolean`, suffix assumption documented | 1 (field), 2 (set on widgets) |
| `shrinkOutputs(outputs, overflow)` pure module | 1 |
| Widest-first trimming | 1 |
| Floor constant, not configurable | 1 |
| Ellipsis counted in the trimmed width | 1 |
| Code-point slicing | 1 |
| Terminates when all shrinkable segments are at floor | 1 |
| `project` and `git-branch` opt in | 2 |
| `renderLine` measures then shrinks | 2 |
| Unknown width shrinks nothing | 2 (invariant test extension) |
| Mode independence (powerline and plain) | 1 (pure, mode-free), 2 (integration) |
| `truncateAnsi` unchanged as backstop | 2 |
| `renderCompact` untouched | Global constraint |
| No new config field; `custom-command` untouched | Global constraint |
| Default-layout regression with a long branch | 3 |
| Mutation check that shrink disappearing fails a test | 2 Step 6, 3 Step 3 |
| Build + stage `dist/index.js` | Global constraint, every task |

**Type consistency:** `shrinkOutputs(outputs: WidgetOutput[], overflow: number): WidgetOutput[]`, `MIN_SHRUNK_TEXT: number`, `WidgetOutput.shrinkable?: boolean`. `renderLine`'s signature is unchanged; only its body reads `laidOut` instead of `outputs`.

**Known risk called out in-plan:** the `renderLine`/`measureLine` mutual recursion. Task 2 flags it before the code, and Task 2 Step 5 tells the implementer that a hang — not a failure — is the symptom.
