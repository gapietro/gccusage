# Project Identifier Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the current project's name on the default statusline, sourced from `workspace.project_dir` rather than `stdin.cwd`.

**Architecture:** Three layers, one per task. The stdin schema learns to keep `workspace.project_dir` (valibot currently strips it silently). A new `project` widget renders `basename(project_dir)` and declines when that field is absent. The default layout gains it as the first segment of line 2. The existing `cwd` widget is not touched.

**Tech Stack:** TypeScript, valibot (stdin/settings schemas), vitest, tsdown (bundler), chalk (truecolor rendering).

**Spec:** `docs/superpowers/specs/2026-07-31-project-identifier-design.md`
**Issues:** [#48](https://github.com/gapietro/gccusage/issues/48) (feature), [#59](https://github.com/gapietro/gccusage/issues/59) (blocker)

## Global Constraints

- **Every commit that touches `src/` must rebuild and stage the bundle.** Run `npm run build` and `git add -f dist/index.js` in the same commit. `dist/` is gitignored but force-tracked; `gccusage setup` points `statusLine.command` at `dist/index.js`, so a src-only commit leaves `git pull` upgraders running the old code.
- **Imports inside `src/` use the `.js` extension**, even when the target file is `.ts` — tsdown rewrites specifiers. (`scripts/` is the opposite; nothing in this plan touches `scripts/`.)
- **Colours in `src/config/defaults.ts` must be a `NAMED_COLORS` key or an anchored `#rgb`/`#rrggbb` hex.** Anything else is rejected at config load.
- **`MIN_SEPARATOR_DELTA` is 8** (`src/render/powerline.ts:32`). Adjacency distances are CIEDE2000 via `colorDistance` from `src/render/color-compare.js` — never hand-computed.
- **Do not modify `src/widgets/cwd.ts`.**
- **Do not hand-edit anything under `derived` in the real-payload fixtures.** `stdin` blocks in those fixtures are also recordings; this plan reads them, never rewrites them.
- Run the full suite with `npm test`. `vitest.config.ts` pins `include` to `src/**/__tests__/**` and `scripts/**/__tests__/**`; a test file placed anywhere else is silently never collected.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/types/status-json.ts` | Modify — add `WorkspaceSchema` and the `workspace` field | 1 |
| `src/__tests__/status-json.test.ts` | Create — proves `workspace.project_dir` survives parsing, and pins #59's evidence | 1 |
| `src/widgets/project.ts` | Create — the widget; `basename(project_dir)`, nothing else | 2 |
| `src/widgets/registry.ts` | Modify — register `project` | 2 |
| `src/__tests__/widgets.test.ts` | Modify — unit cases for the new widget | 2 |
| `src/__tests__/fixtures/widget-expectations.ts` | Modify — add `project`, retire `cwd`'s `knownWrong: 59` | 2 |
| `README.md` | Modify — widget table row | 2 |
| `src/config/defaults.ts` | Modify — add the segment, renumber priorities | 3 |
| `src/__tests__/defaults.test.ts` | Modify — give the sweep a `workspace`, add the palette guard | 3 |

---

### Task 1: Parse `workspace.project_dir`

`src/types/status-json.ts` parses 7 top-level fields. Valibot's default object schema **strips** unrecognised keys rather than erroring, so `workspace` is discarded silently and no widget can reach it. That is the mechanical reason #59 blocked #48.

**Files:**
- Modify: `src/types/status-json.ts:46-58`
- Test: `src/__tests__/status-json.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `StatusJson["workspace"]`, typed `{ project_dir?: string } | undefined`. Task 2 reads `context.stdin.workspace?.project_dir`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/status-json.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as v from "valibot";
import { StatusJsonSchema } from "../types/status-json.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

// opus5-1m-early is the fixture whose session was started in a subdirectory.
// It is the whole evidence base for #59, so assert against it rather than a
// hand-written payload: a hand-written one encodes what we believe Claude
// Code sends, which is exactly the failure mode #47 exists to close.
describe("StatusJsonSchema workspace", () => {
  const fx = earlyFixture as unknown as RealPayloadFixture;

  it("keeps workspace.project_dir instead of stripping it", () => {
    const parsed = v.parse(StatusJsonSchema, fx.stdin);
    expect(parsed.workspace?.project_dir).toBe(`${fx.homePlaceholder}/projects/demo-project`);
  });

  it("pins #59: cwd is a subdirectory of project_dir in this payload", () => {
    const parsed = v.parse(StatusJsonSchema, fx.stdin);
    expect(parsed.cwd).toBe(`${fx.homePlaceholder}/projects/demo-project/src/widgets`);
    expect(parsed.workspace?.project_dir).not.toBe(parsed.cwd);
  });

  it("still accepts a payload with no workspace at all", () => {
    const parsed = v.parse(StatusJsonSchema, { cwd: "/tmp/x" });
    expect(parsed.workspace).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/__tests__/status-json.test.ts`
Expected: the first two cases FAIL — `parsed.workspace` is `undefined` because the schema strips the key. The third passes already. If the first case *passes* at this point, stop: it means `workspace` is parsed somewhere already and this plan's premise is wrong.

- [ ] **Step 3: Add the schema**

In `src/types/status-json.ts`, insert after the `VimSchema` declaration (currently lines 46-48):

```ts
// Claude Code's `workspace` block also carries `current_dir` (a duplicate of
// top-level `cwd`), `added_dirs[]` and `repo{host,owner,name}`. None has a
// consumer, and valibot strips unrecognised keys, so they stay unparsed until
// one does. `project_dir` is the repo root — the only correct source for a
// project identifier (#59); `cwd` is wherever the shell happened to be.
const WorkspaceSchema = v.object({
  project_dir: v.optional(v.string()),
});
```

and add the field to `StatusJsonSchema`, after `cwd`:

```ts
  cwd: v.optional(v.string()),
  workspace: v.optional(WorkspaceSchema),
  session_id: v.optional(v.string()),
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/__tests__/status-json.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green. Nothing reads `workspace` yet, so no existing expectation can move.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/types/status-json.ts src/__tests__/status-json.test.ts
git add -f dist/index.js
git commit -m "Parse workspace.project_dir from the stdin payload (#59)

Valibot's default object schema strips unrecognised keys, so the payload's
workspace block was discarded silently and no widget could reach the repo
root. Parses project_dir only; current_dir duplicates cwd and added_dirs/repo
have no consumer."
```

---

### Task 2: The `project` widget

**Files:**
- Create: `src/widgets/project.ts`
- Modify: `src/widgets/registry.ts:15` (import) and `:42` (map entry)
- Modify: `src/__tests__/fixtures/widget-expectations.ts:59` (the `cwd` entry) and the same object literal (new `project` entry)
- Modify: `README.md:184` (widget table)
- Test: `src/__tests__/widgets.test.ts`

**Interfaces:**
- Consumes: `context.stdin.workspace?.project_dir` from Task 1.
- Produces: `export const projectWidget: Widget`, registered under the type string `"project"`. Task 3 references that exact string in `defaults.ts`.

**Note on ordering:** registering the widget without adding its `widget-expectations.ts` entry makes `widget-reality.test.ts`'s "covers every registered widget type" fail. That is the harness working as designed (#47) — both edits belong in this one task.

- [ ] **Step 1: Write the failing tests**

In `src/__tests__/widgets.test.ts`, add the import beside the existing widget imports at the top:

```ts
import { projectWidget } from "../widgets/project.js";
```

and append this block at the end of the file:

```ts
describe("projectWidget", () => {
  // HOME is read directly by the widget (as cwd.ts does), so pin it and put
  // it back — src/__tests__/error-line.test.ts uses the same save/restore.
  const originalHome = process.env["HOME"];
  afterEach(() => {
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
  });

  function ctx(workspace: unknown, cwd?: string): RenderContext {
    return makeContext({ stdin: { cwd, workspace } as never });
  }

  it("renders the basename of project_dir", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("ignores cwd when the session started in a subdirectory (#59)", () => {
    const out = projectWidget.render(
      ctx({ project_dir: "/Users/x/projects/gccusage" }, "/Users/x/projects/gccusage/src/widgets"),
      { type: "project" },
    );
    expect(out?.text).toBe("gccusage");
  });

  it("ignores a trailing slash", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage/" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("renders ~ when the project dir is HOME itself", () => {
    process.env["HOME"] = "/Users/x";
    const out = projectWidget.render(ctx({ project_dir: "/Users/x" }), { type: "project" });
    expect(out?.text).toBe("~");
  });

  it("renders / for the filesystem root", () => {
    const out = projectWidget.render(ctx({ project_dir: "/" }), { type: "project" });
    expect(out?.text).toBe("/");
  });

  it("falls back to the basename when HOME is unset", () => {
    delete process.env["HOME"];
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
    });
    expect(out?.text).toBe("gccusage");
  });

  it("declines when workspace is absent rather than falling back to cwd", () => {
    // A cwd fallback would be right whenever the session started at the repo
    // root and silently wrong whenever it did not — the #59 defect with no
    // signal that it fired. Fail closed instead.
    const out = projectWidget.render(ctx(undefined, "/Users/x/projects/gccusage/src/widgets"), {
      type: "project",
    });
    expect(out).toBeNull();
  });

  it("declines when project_dir is an empty string", () => {
    const out = projectWidget.render(ctx({ project_dir: "" }), { type: "project" });
    expect(out).toBeNull();
  });

  it("prefixes a configured label", () => {
    const out = projectWidget.render(ctx({ project_dir: "/Users/x/projects/gccusage" }), {
      type: "project",
      label: "proj",
    });
    expect(out?.text).toBe("proj gccusage");
  });
});
```

Add `afterEach` to the vitest import at the top of the file if it is not already there — the current first line is `import { describe, it, expect } from "vitest";`, so it becomes:

```ts
import { describe, it, expect, afterEach } from "vitest";
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: FAIL at import resolution — `Cannot find module '../widgets/project.js'`.

- [ ] **Step 3: Write the widget**

Create `src/widgets/project.ts`:

```ts
import * as path from "node:path";
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

/**
 * The current project's name, from `workspace.project_dir` — the repo root.
 *
 * Deliberately never reads `stdin.cwd`: cwd is wherever the shell happened to
 * be when Claude Code started, so its basename names a subdirectory whenever
 * the session did not start at the root (#59). When `project_dir` is absent
 * this declines rather than falling back to cwd, because that fallback is
 * silently wrong in exactly the case the widget exists to handle.
 *
 * Two checkouts of the same repo still render identically; that is a known
 * limit of any basename, recorded in the #48 design doc.
 */
export const projectWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const projectDir = context.stdin.workspace?.project_dir;
    if (!projectDir) return null;

    // Strip trailing separators so "/x/y/" and "/x/y" behave identically,
    // including for the HOME comparison below; keep a lone "/" intact.
    const dir = projectDir.replace(/\/+$/, "") || "/";

    const home = process.env["HOME"];
    // path.basename("/") is "", the only case that can be empty here.
    const name = dir === home ? "~" : path.basename(dir) || "/";

    const label = config.label ?? "";
    const text = label ? `${label} ${name}` : name;
    return { text, fg: config.fg, bg: config.bg };
  },
};
```

- [ ] **Step 4: Register the widget**

In `src/widgets/registry.ts`, add the import after the `cwd` import on line 15:

```ts
import { projectWidget } from "./project.js";
```

and the map entry after `cwd: cwdWidget,` on line 42:

```ts
  project: projectWidget,
```

- [ ] **Step 5: Run the widget tests and confirm they pass**

Run: `npx vitest run src/__tests__/widgets.test.ts`
Expected: PASS, including all 9 new cases.

- [ ] **Step 6: Confirm the reality harness now fails, then satisfy it**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: FAIL — `registered widgets with no expectation entry: project`. This is the #47 harness doing its job; do not silence it.

In `src/__tests__/fixtures/widget-expectations.ts`, add to the `WIDGET_EXPECTATIONS` object, directly after the `cwd` entry:

```ts
  project: {
    text: "demo-project",
    why: "basename(workspace.project_dir) — the repo root, never the session's cwd",
  },
```

and replace the existing `cwd` entry (line 59) with:

```ts
  cwd: {
    text: "~/projects/demo-project",
    why: "full path, home abbreviated — correct for cwd's own job. The project identifier moved to the `project` widget, which reads workspace.project_dir (#59 resolved)",
  },
```

Note the deliberate removal of `knownWrong: 59`. Leaving it would keep pointing a closed issue at a widget that is no longer wrong.

- [ ] **Step 7: Run the reality harness and confirm it passes**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: PASS. The `project renders exactly as recorded` case renders `demo-project`, and the `cwd` case's title no longer carries `(known wrong: #59)`.

- [ ] **Step 8: Document the widget**

In `README.md`, add a row directly after the `cwd` row at line 184:

```markdown
| `project` | Project name (repo root), from `workspace.project_dir` |
```

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all green. The widget is registered but in no layout, so `defaults.test.ts` is untouched by this task.

- [ ] **Step 10: Commit**

```bash
npm run build
git add src/widgets/project.ts src/widgets/registry.ts src/__tests__/widgets.test.ts \
        src/__tests__/fixtures/widget-expectations.ts README.md
git add -f dist/index.js
git commit -m "Add a project widget reading workspace.project_dir (#59)

Renders basename(project_dir), never basename(cwd) — cwd names a
subdirectory whenever the session did not start at the repo root. Declines
when project_dir is absent rather than falling back to cwd, which would be
silently wrong in exactly that case. cwd.ts is unchanged and its
knownWrong:59 tag retires: it renders the cwd correctly."
```

---

### Task 3: Promote it to the default bar

**Files:**
- Modify: `src/config/defaults.ts:7-24`
- Modify: `src/__tests__/defaults.test.ts:88-92` (`makeSweepContext`) and add one guard test

**Interfaces:**
- Consumes: the registered type string `"project"` from Task 2.
- Produces: a `DEFAULT_SETTINGS` line 2 whose first widget is `{ type: "project", fg: "#ffffff", bg: "#264653", priority: 5 }`, and priorities 1-10 with no duplicates.

- [ ] **Step 1: Write the failing guard test**

`makeSweepContext` builds a `stdin` with **no** `workspace` key. Combined with decline-on-absent, the new segment would render `null` through the entire rendered-adjacency sweep — the guards would pass while covering nothing. Fix that first, in `src/__tests__/defaults.test.ts`, inside `makeSweepContext`:

```ts
      stdin: {
        model: "claude-sonnet-4-20250514",
        cwd: process.cwd(),
        // Without this the `project` widget declines and the sweeps below
        // silently cover zero of its adjacencies — the same blind spot that
        // let 12 dormant widgets go unexercised (#47).
        workspace: { project_dir: process.cwd() },
```

Then append a new `describe` block at the end of the file:

```ts
describe("project segment palette", () => {
  // The rendered-adjacency sweep above deliberately does NOT guard the
  // palette itself — see the comment on assertEveryPieceVisible. A wide
  // separator is only emitted once colorDistance already cleared
  // MIN_SEPARATOR_DELTA, so re-asserting it there is a tautology, and two
  // backgrounds that drift together degrade to the thin glyph instead of
  // failing. #48 asks specifically that this segment's background clear ΔE 8,
  // and renderCompact flattens both lines before sorting by priority, so it
  // can sit beside any other segment — check against all of them.

  // Backgrounds set at render time from thresholds, which never appear in
  // DEFAULT_SETTINGS: context-percent/session-cost/today-spend alerts,
  // compact-countdown's own palette, and vim-mode's per-mode colors.
  const RUNTIME_BACKGROUNDS = ["#a67c00", "#c01c28", "#b8860b", "#a01822", "#2ec27e", "#e5a50a"];

  const configured = DEFAULT_SETTINGS.lines.flatMap((line) => line.widgets);
  const project = configured.find((w) => w.type === "project");

  it("is on the default bar with a background", () => {
    expect(project?.bg).toBeDefined();
  });

  it("clears the separator floor against every background the bar can paint", () => {
    const others = [
      ...configured.filter((w) => w.type !== "project" && w.bg !== undefined).map((w) => [w.type, w.bg!] as const),
      ...RUNTIME_BACKGROUNDS.map((bg) => [`runtime ${bg}`, bg] as const),
    ];
    for (const [type, bg] of others) {
      const distance = colorDistance(project!.bg!, bg);
      expect(
        distance,
        `project bg ${project!.bg} is only ΔE ${distance.toFixed(2)} from ${type} bg ${bg} ` +
          `(floor ${MIN_SEPARATOR_DELTA})`,
      ).toBeGreaterThanOrEqual(MIN_SEPARATOR_DELTA);
    }
  });
});
```

`colorDistance`, `MIN_SEPARATOR_DELTA` and `DEFAULT_SETTINGS` are already imported at the top of this file; add nothing.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/__tests__/defaults.test.ts`
Expected: `is on the default bar with a background` FAILS — `project` is in no layout yet, so `project?.bg` is `undefined`.

- [ ] **Step 3: Add the segment and renumber priorities**

Replace the two `widgets` arrays in `src/config/defaults.ts` with:

```ts
    {
      widgets: [
        { type: "model", fg: "#ffffff", bg: "#1a5fb4", priority: 1 },
        { type: "session-cost", fg: "#ffffff", bg: "#26a269", priority: 2 },
        { type: "context-percent", fg: "#ffffff", bg: "#0d7377", priority: 3 },
        { type: "compact-countdown", fg: "#ffffff", bg: "#1a5fb4", priority: 4 },
        { type: "burn-rate", fg: "#ffffff", bg: "#555555", priority: 8 },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "project", fg: "#ffffff", bg: "#264653", priority: 5 },
        { type: "git-branch", fg: "#ffffff", bg: "#613583", priority: 6 },
        { type: "git-changes", fg: "#ffffff", bg: "#7d4fa8", priority: 9 },
        { type: "lines-changed", fg: "#ffffff", bg: "#0d7377", priority: 10 },
        { type: "today-spend", fg: "#ffffff", bg: "#26a269", priority: 7 },
        { type: "vim-mode" },
      ],
      flex: "left",
    },
```

Only `burn-rate` changed on line 1 (7 → 8). On line 2, `project` is new and every existing priority shifted up one: git-branch 5→6, today-spend 6→7, git-changes 8→9, lines-changed 9→10. `vim-mode` still has no priority and falls to 99.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/__tests__/defaults.test.ts`
Expected: PASS — including `assigns each prioritised widget a distinct priority`, `references only registered widget types`, `uses only colors a user could write in their own config`, both invisible-piece sweeps (now with the project segment actually present), and both new palette cases.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/config/defaults.ts src/__tests__/defaults.test.ts
git add -f dist/index.js
git commit -m "Show the project name on the default bar (#48)

Adds project as the first segment of line 2 at priority 5, shifting every
priority at or above 5 up by one — priority is keep-first, and on a narrow
terminal a bare branch name without the project is the ambiguity #48 was
filed about, not the fix.

makeSweepContext gained a workspace, without which the new segment declines
and the adjacency sweeps cover none of it. Adds a palette guard: the existing
sweep deliberately does not check how close two backgrounds are allowed to
get, so the DE-8 claim for #264653 needed its own assertion."
```

---

### Task 4: Look at the real bar

#48 asks for this explicitly: *"Beyond unit tests, render the real default bar and look at it — this widget has never been seen on a real statusline."* Every check so far has been a string comparison.

**Files:** none expected. If this step reveals a problem, fix it here with a test that reproduces it first.

- [ ] **Step 1: Render the bar against a subdirectory payload**

Run from the repo root. `XDG_CACHE_HOME` is redirected so this does **not** write to the real `~/.cache/gccusage/daily-costs.json` and inflate the user's today total:

```bash
mkdir -p /tmp/gccusage-look
XDG_CACHE_HOME=/tmp/gccusage-look node -e '
const p = {
  session_id: "look-at-it",
  model: { id: "claude-opus-5", display_name: "Opus 5" },
  cwd: process.cwd() + "/src/widgets",
  workspace: { project_dir: process.cwd() },
  cost: { total_cost_usd: 2.1, total_duration_ms: 1800000, total_lines_added: 12, total_lines_removed: 4 },
  context_window: {
    context_window_size: 200000, used_percentage: 30,
    current_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 },
  },
};
process.stdout.write(JSON.stringify(p));
' | XDG_CACHE_HOME=/tmp/gccusage-look node dist/index.js
```

Expected: two lines, laid out for an 80-column terminal (stdout is a pipe, so `getTerminalWidth()` returns its `|| 80` fallback — the same width Claude Code itself gets). Line 2 starts with a `gccusage` segment on a dark slate background, followed by a visible `▶` and the git branch. It must **not** say `widgets` — that string is the entire bug.

- [ ] **Step 2: Confirm the separator is actually drawn**

Look at the boundary between the `gccusage` segment and the branch segment. A wide `▶` in the project segment's background means the ΔE check passed at paint time. A thin `│` would mean the two backgrounds came out closer than 8 despite the guard — investigate before proceeding.

- [ ] **Step 3: Check the compact path**

`COLUMNS` will not work here. `getTerminalWidth()` (`src/utils/terminal.ts:2`) reads `process.stdout.columns`, which is `undefined` whenever stdout is a pipe — as it always is under Claude Code — so the width is always the `|| 80` fallback. With `compact.mode: "auto"` the trigger is `terminalWidth < 80`, which that fallback can never satisfy. Force it with a config file instead:

```bash
mkdir -p /tmp/gccusage-look/gccusage
echo '{"compact":{"mode":"always"}}' > /tmp/gccusage-look/gccusage/settings.json
```

Then re-run the exact command from Step 1, adding `XDG_CONFIG_HOME=/tmp/gccusage-look` to **both** halves of the pipeline alongside `XDG_CACHE_HOME`. Only `compact` is overridden; `lines` still comes from `DEFAULT_SETTINGS`.

Expected: one line, both default lines flattened and sorted by priority, fitted into 80 columns. `gccusage` survives, appearing after `compact-countdown` and before `git-branch`. Every boundary still visible.

- [ ] **Step 4: Clean up**

```bash
rm -rf /tmp/gccusage-look
```

- [ ] **Step 5: Verify the tree is clean and the bundle is current**

```bash
npm test
npm run build
git status --porcelain
```

Expected: suite green, and `git status` reports nothing — if `dist/index.js` shows as modified, a previous task committed source without rebuilding. Fix by amending that commit's bundle rather than adding a stray build commit.

- [ ] **Step 6: Close out the issues**

Reference both in the PR body: #48 (delivered as respecified — project name only, from `project_dir`, with two-checkouts disambiguation explicitly out of scope) and #59 (resolved — the correct source is parsed and used, and `cwd`'s `knownWrong` tag is retired).

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Schema: `workspace.project_dir` only | 1 |
| New `project` widget, all six input cases | 2 |
| `$HOME`-unset behaviour | 2 (Step 1, sixth case) |
| `cwd.ts` untouched, no new `WidgetConfig` field | 2 — asserted by omission; no step edits either file |
| Defaults: first segment of line 2, `#264653`, priority 5 + renumber | 3 |
| `widget-expectations.ts`: add `project`, retire `cwd`'s `knownWrong` | 2, Step 6 |
| `makeSweepContext` gains a `workspace` | 3, Step 1 |
| Render the real bar and look at it | 4 |
| README widget row | 2, Step 8 |
| `npm run build` + `git add -f dist/index.js` | Global Constraints + every commit step |
| Two checkouts out of scope | Recorded in the widget's doc comment (Task 2) and the PR body (Task 4) |

**Type consistency:** `projectWidget` is the export name in Task 2's implementation, its `widgets.test.ts` import, and its `registry.ts` import. The registry key, the `WIDGET_EXPECTATIONS` key, the `defaults.ts` `type`, and the guard test's `find` predicate are all the string `"project"`. `context.stdin.workspace?.project_dir` in Task 2 matches the field Task 1 adds.

**Corrections made during review:** Task 4's compact check originally used `COLUMNS=60`, which does nothing — `getTerminalWidth()` reads `process.stdout.columns`, always `undefined` behind a pipe, so the width is always 80 and `compact.mode: "auto"` (`terminalWidth < 80`) can never fire. Replaced with an `XDG_CONFIG_HOME` settings override forcing `compact.mode: "always"`.

**Additions beyond the spec:** the palette guard test in Task 3 is not in the spec. It was added after reading `assertEveryPieceVisible`'s own comment, which states the sweep "does not guard the palette itself" — so without it the spec's ΔE claim for `#264653` would ship entirely unverified. Task 4's `XDG_CACHE_HOME` redirect is likewise an addition: the naive version of that command writes real spend into the user's daily-cost store.
