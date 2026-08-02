# Stop Re-Reading Today's Transcripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make statusline cache-miss render time flat with respect to the day's accumulated transcript volume (issue #94), by not reading today's transcripts at all in the default config and caching per-file aggregates in the `costSource: "calculated"` config.

**Architecture:** Three moves. (1) `aggregateTokens` collapses to a single-array signature and `AggregatedMetrics.today` is deleted, because nothing on the render path reads it. (2) `buildRenderContext` reads today's transcripts only when `settings.costSource === "calculated"`. (3) That remaining path goes through a new `today-aggregate-cache` module that reuses a per-file aggregate whenever the file's `(mtimeMs, size)` is unchanged, so only files that actually grew get re-parsed.

**Tech Stack:** TypeScript, tsdown (bundler), vitest, valibot.

**Spec:** `docs/superpowers/specs/2026-08-02-today-transcript-read-design.md`

## Global Constraints

These apply to every task below.

- **Imports in `src/` use the `.js` extension** (tsdown rewrites specifiers). `scripts/` uses `.ts`. Never change one to the other.
- **Every commit that touches `src/` must rebuild and stage the bundle:** `npm run build && git add -f dist/index.js`. `dist/` is gitignored but force-tracked; CI's `bundle-drift` job fails the PR otherwise. Each commit step below includes this.
- **New test files must live under `src/**/__tests__/**/*.test.ts`** or `vitest.config.ts` will never collect them.
- **Every new test must be sabotage-checked**: after it passes, break the thing it guards, confirm the test fails, then restore. A test that passes both ways asserts nothing.
- **Never `git add AUDIT.md`.** It is deliberately untracked; update it locally only.
- **Full verification before any completion claim:** `npm test` and `npm run typecheck` must both pass.
- Branch is `perf/today-transcript-read`, already created, with the design doc committed as `b441952`.

## File Structure

**Created:**
- `src/cache/today-aggregate-cache.ts` — the per-file aggregate cache. Owns the cache schema, the `(mtimeMs, size)` reuse decision, midnight invalidation, and the merge back into one `{byModel, totals, fileCount}`. Sole consumer of `findTodayJsonlFileStats`.
- `src/__tests__/today-aggregate-cache.test.ts` — unit tests for that module.
- `src/__tests__/today-read-flatness.test.ts` — the acceptance-criterion test (bytes read is flat across corpus sizes).

**Modified:**
- `src/types/token-metrics.ts` — `AggregatedMetrics`: `session`+`today` → `totals`.
- `src/data/token-aggregator.ts` — `aggregateTokens(entries)`.
- `src/utils/paths.ts` — add `findTodayJsonlFileStats()`; reimplement `findTodayJsonlFiles()` on top of it.
- `src/data/pipeline.ts` — gate the today read on the setting; use the cache.
- `src/cli.ts` — use the cache; output stays byte-identical.
- `src/__tests__/fixtures/real-payloads/fixture-types.ts` — declare the *recorded* metrics shape explicitly instead of deriving it from the live type.
- `src/__tests__/fixtures/context-from-fixture.ts` — adapt the recording (`session`) to the live type (`totals`).
- `src/__tests__/token-aggregator.test.ts`, `defaults.test.ts`, `renderer.test.ts`, `widgets.test.ts` — signature/field updates.
- `src/__tests__/pipeline.test.ts` — new tier-1 and tier-2 cases.

---

### Task 1: Collapse `aggregateTokens` to one array and delete `today`

Pure refactor, no behaviour change. The suite must be green at the end with the same assertions (adjusted for the rename), which is what proves it is behaviour-preserving.

**Files:**
- Modify: `src/types/token-metrics.ts:12-16`
- Modify: `src/data/token-aggregator.ts:16-44`
- Modify: `src/data/pipeline.ts:45,56`
- Modify: `src/cli.ts:43,51,58`
- Modify: `src/__tests__/token-aggregator.test.ts`
- Modify: `src/__tests__/fixtures/real-payloads/fixture-types.ts:41`
- Modify: `src/__tests__/fixtures/context-from-fixture.ts:13-16`
- Modify: `src/__tests__/defaults.test.ts:108-112`, `src/__tests__/renderer.test.ts:17-21`, `src/__tests__/widgets.test.ts:31-35,624-634,657-666`

**Interfaces:**
- Consumes: nothing.
- Produces: `aggregateTokens(entries: JsonlEntry[]): AggregatedMetrics` where `AggregatedMetrics` is `{ byModel: Map<string, TokenMetrics>; totals: TokenMetrics }`. Tasks 4 and 5 call this.

- [ ] **Step 1: Update the failing tests first**

Replace the whole `describe("aggregateTokens", ...)` block in `src/__tests__/token-aggregator.test.ts` with:

```ts
describe("aggregateTokens", () => {
  const entries: JsonlEntry[] = [
    {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 1000, output_tokens: 500 },
    },
    {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 2000, output_tokens: 800 },
    },
    {
      model: "claude-opus-4-20250514",
      usage: { input_tokens: 5000, output_tokens: 2000 },
    },
  ];

  it("aggregates totals across every entry", () => {
    const result = aggregateTokens(entries);
    expect(result.totals.inputTokens).toBe(8000);
    expect(result.totals.outputTokens).toBe(3300);
  });

  it("aggregates by model", () => {
    const result = aggregateTokens(entries);
    expect(result.byModel.size).toBe(2);
    expect(result.byModel.get("claude-sonnet-4-20250514")?.inputTokens).toBe(3000);
    expect(result.byModel.get("claude-opus-4-20250514")?.inputTokens).toBe(5000);
  });

  // An entry with usage but no `model` counts toward the totals and toward no
  // model bucket. This asymmetry is why the cache in
  // `today-aggregate-cache.ts` stores `totals` as well as `byModel`: the
  // totals cannot be reconstructed by summing the buckets.
  it("counts model-less usage in totals but not in byModel", () => {
    const result = aggregateTokens([{ usage: { input_tokens: 100, output_tokens: 50 } }]);
    expect(result.totals.inputTokens).toBe(100);
    expect(result.byModel.size).toBe(0);
  });

  it("returns zeroed totals for no entries", () => {
    const result = aggregateTokens([]);
    expect(result.totals.inputTokens).toBe(0);
    expect(result.byModel.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/token-aggregator.test.ts`
Expected: FAIL — `result.totals` is undefined (reading `inputTokens` of undefined), and `aggregateTokens` still wants two arguments.

- [ ] **Step 3: Change the type**

In `src/types/token-metrics.ts`, replace the `AggregatedMetrics` interface:

```ts
export interface AggregatedMetrics {
  byModel: Map<string, TokenMetrics>;
  totals: TokenMetrics;
}
```

`today` is deleted rather than left to read zero. A field that silently returns 0 is the "registered but never exercised" shape that let the `compact-countdown` defect survive; a future widget wanting today's tokens must add the plumbing on purpose.

- [ ] **Step 4: Change `aggregateTokens`**

In `src/data/token-aggregator.ts`, replace the `aggregateTokens` function (leave `emptyMetrics`, `addUsage` and `getFirstTimestamp` untouched):

```ts
export function aggregateTokens(entries: JsonlEntry[]): AggregatedMetrics {
  const byModel = new Map<string, TokenMetrics>();
  const totals = emptyMetrics();

  for (const entry of entries) {
    if (!entry.usage) continue;
    addUsage(totals, entry);

    if (entry.model) {
      let model = byModel.get(entry.model);
      if (!model) {
        model = emptyMetrics();
        byModel.set(entry.model, model);
      }
      addUsage(model, entry);
    }
  }

  return { byModel, totals };
}
```

- [ ] **Step 5: Fix the two production callers**

In `src/data/pipeline.ts`, change line 45 to:

```ts
  const metrics = aggregateTokens(sessionEntries);
```

and line 56 to:

```ts
  const today = calculateCostByModel(aggregateTokens(todayEntries).byModel, pricing);
```

(Task 2 replaces this line entirely; this keeps the tree compiling in the meantime.)

In `src/cli.ts`, change lines 43 and 51:

```ts
  const metrics = aggregateTokens(entries);
```

```ts
  console.log(
    `Total Tokens: ${formatTokens(metrics.totals.inputTokens + metrics.totals.outputTokens)}`,
  );
```

Line 58 (`metrics.byModel.get(model)`) is unchanged.

- [ ] **Step 6: Fix the fixture types**

In `src/__tests__/fixtures/real-payloads/fixture-types.ts`, replace the `metrics` line inside `derived` (currently line 40-41) with:

```ts
    /**
     * The metrics as RECORDED at capture time, declared explicitly rather than
     * derived from the live `AggregatedMetrics`. These fixtures are a recording
     * of what the pipeline produced then, and the live type has since changed
     * (`session` -> `totals`, `today` dropped in #94). `context-from-fixture.ts`
     * adapts the recording to the current type; re-capturing to chase a type
     * rename would throw away the "real payload" property they exist for.
     * `byModel` is entries, not a Map, because Maps don't survive JSON.
     */
    metrics: {
      byModel: [string, TokenMetrics][];
      session: TokenMetrics;
      today: TokenMetrics;
    };
```

`AggregatedMetrics` is now unused in this file — remove it from the import on line 1, leaving `import type { TokenMetrics } from "../../../types/token-metrics.js";`.

- [ ] **Step 7: Adapt the fixture loader**

In `src/__tests__/fixtures/context-from-fixture.ts`, replace the `metrics` property (lines 13-16) with:

```ts
    // The fixture recorded `session`; the live type calls it `totals`. The
    // recorded `today` has no counterpart — the render path no longer computes
    // it (#94) — so it is deliberately dropped here.
    metrics: {
      byModel: new Map(fx.derived.metrics.byModel),
      totals: fx.derived.metrics.session,
    },
```

The `as RenderContext["metrics"]` cast is no longer needed; delete it.

- [ ] **Step 8: Fix the four inline test contexts**

In each of `src/__tests__/defaults.test.ts` (lines 108-112), `src/__tests__/renderer.test.ts` (lines 17-21), and `src/__tests__/widgets.test.ts` (lines 31-35, 624-634, 657-666), the `metrics` object has this shape:

```ts
      metrics: {
        byModel: new Map(),
        session: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        today: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
```

In every one of those five sites: rename the `session` key to `totals` and delete the `today` line. At `widgets.test.ts:626` and `:659` the `session` value is a populated multi-line object rather than zeros — rename the key, keep the value exactly as it is, and delete only the `today` line beneath it.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. If `tsc` reports a remaining `.today` or `.session` reference, fix that site — the list above is exhaustive per `grep -rn "metrics.today\|\.session\b" --include="*.ts" src` but verify rather than assume.

- [ ] **Step 10: Sabotage-check the new assertion**

In `token-aggregator.ts`, temporarily change `if (entry.model)` to `if (true)`. Run `npx vitest run src/__tests__/token-aggregator.test.ts`. Expected: the "counts model-less usage in totals but not in byModel" test FAILS (it would throw on `entry.model` being undefined as a Map key, or record a bucket). Restore the line and re-run to confirm PASS.

- [ ] **Step 11: Commit**

```bash
npm run build
git add src/types/token-metrics.ts src/data/token-aggregator.ts src/data/pipeline.ts src/cli.ts src/__tests__
git add -f dist/index.js
git commit -m "Collapse aggregateTokens to one array and drop the unread today field"
```

---

### Task 2: Read today's transcripts only when they are used

**Files:**
- Modify: `src/data/pipeline.ts:37-42,56,79-89`
- Modify: `src/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `aggregateTokens(entries)` from Task 1.
- Produces: `buildRenderContext` no longer calls `findTodayJsonlFiles()` unless `settings.costSource === "calculated"`. Task 5 replaces the body of that branch.

- [ ] **Step 1: Add the pass-through spy to the pipeline test file**

The test needs to know *which transcript paths were read*. Spying on `fs.readFileSync` through an ESM namespace import is unreliable; mocking the module boundary with a pass-through wrapper is not. Add this `vi.mock` next to the existing `vi.mock("../data/pricing-fetcher.js", ...)` block near the top of `src/__tests__/pipeline.test.ts`:

```ts
// A pass-through spy: real parsing, but every path the pipeline reads is
// recorded. Used to assert that today's transcripts are NOT read in the
// default config — a behavioural assertion can't see that, because the old
// code read them and then discarded the result.
vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});
```

Add to the imports at the top of the file:

```ts
import { parseJsonlFile } from "../data/jsonl-reader.js";
```

And add this helper next to the other helpers (after `settingsWith`):

```ts
function parsedPaths(): string[] {
  return vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0]);
}

// A today-dated transcript belonging to some OTHER session, worth $2.00 of
// calculated cost. The current session's own transcript is written by
// `writeTranscript`.
function writeOtherSessionTranscript(sessionId: string): string {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      sessionId,
      message: {
        model: "test-model",
        usage: { input_tokens: 2_000_000, output_tokens: 0 },
      },
    }) + "\n",
  );
  return filePath;
}
```

In the existing `beforeEach`, add `vi.mocked(parseJsonlFile).mockClear();` as the last line so each case starts with an empty call log.

- [ ] **Step 2: Write the failing tests**

Append this `describe` block to `src/__tests__/pipeline.test.ts`:

```ts
describe("today's transcripts are read only when they are used (#94)", () => {
  const stdinWithCost: StatusJson = {
    session_id: "sess-current",
    cost: { total_cost_usd: 3.0 },
  } as StatusJson;

  it("does not read other sessions' transcripts under costSource auto", async () => {
    writeTranscript("sess-current");
    const other = writeOtherSessionTranscript("sess-other");

    await buildRenderContext(stdinWithCost, settingsWith("auto"));

    expect(parsedPaths()).not.toContain(other);
  });

  it("does not read other sessions' transcripts under costSource stdin", async () => {
    writeTranscript("sess-current");
    const other = writeOtherSessionTranscript("sess-other");

    await buildRenderContext(stdinWithCost, settingsWith("stdin"));

    expect(parsedPaths()).not.toContain(other);
  });

  // The gate is the SETTING, not the resolved source. "auto" with no stdin
  // cost resolves the *session* source to calculated (pipeline.ts:63) while
  // today's spend still comes from the daily store, so today's transcripts are
  // still not needed.
  it("does not read them under auto even when stdin carries no cost", async () => {
    writeTranscript("sess-current");
    const other = writeOtherSessionTranscript("sess-other");

    await buildRenderContext(
      { session_id: "sess-current" } as StatusJson,
      settingsWith("auto"),
    );

    expect(parsedPaths()).not.toContain(other);
  });

  it("does read them under costSource calculated", async () => {
    writeTranscript("sess-current");
    const other = writeOtherSessionTranscript("sess-other");

    const ctx = await buildRenderContext(stdinWithCost, settingsWith("calculated"));

    expect(parsedPaths()).toContain(other);
    // $1.00 from the current session + $2.00 from the other one.
    expect(ctx.todayCostUsd).toBeCloseTo(3.0, 6);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pipeline.test.ts -t "#94"`
Expected: the first three FAIL (`parsedPaths()` contains the other session's path — the current code reads it unconditionally). The fourth PASSES already; that is correct and expected, it is the counterweight that stops Step 4 from "fixing" things by never reading anything.

- [ ] **Step 4: Gate the read**

In `src/data/pipeline.ts`, replace lines 37-42:

```ts
  // Read JSONL files
  const sessionFiles = findSessionJsonlFiles(stdin.session_id);
  const todayFiles = findTodayJsonlFiles();

  const sessionEntries = sessionFiles.flatMap(parseJsonlFile);
  const todayEntries = filterTodayEntries(todayFiles.flatMap(parseJsonlFile));

  // Aggregate tokens
  const metrics = aggregateTokens(sessionEntries);
```

with:

```ts
  // Read this session's transcript. Today's transcripts are read further down,
  // and only when `costSource` is "calculated" — the sole setting that
  // consumes them (#94).
  const sessionFiles = findSessionJsonlFiles(stdin.session_id);
  const sessionEntries = sessionFiles.flatMap(parseJsonlFile);

  const metrics = aggregateTokens(sessionEntries);
```

Then replace lines 56-57:

```ts
  const today = calculateCostByModel(aggregateTokens(todayEntries).byModel, pricing);
  const calculatedTodayCost = calculateTotalCost(today.costs);
```

with:

```ts
  // Today's transcripts are read only for the one setting that displays a
  // JSONL-derived today figure. Everywhere else `todayCostUsd` comes from the
  // daily store, and reading them was 33 MB of work per cache miss whose
  // result was discarded (#94).
  //
  // The condition is the SETTING, not `sessionCostSource`: "auto" with no
  // stdin cost resolves the session source to "calculated" while today's spend
  // still comes from the store, so gating on the resolved source would put the
  // read back.
  const today =
    settings.costSource === "calculated"
      ? calculateCostByModel(
          aggregateTokens(filterTodayEntries(findTodayJsonlFiles().flatMap(parseJsonlFile)))
            .byModel,
          pricing,
        )
      : null;
```

Replace lines 79-82 (the `todayCostUsd` assignment) with:

```ts
  const todayCostUsd =
    today !== null
      ? calculateTotalCost(today.costs)
      : trackDailyCost(stdin.session_id, sessionCostUsd, sessionCostSource);
```

and line 89 (`todayCostUncertain`) with:

```ts
  const todayCostUncertain = today !== null && today.unpriced.length > 0;
```

The comment block at lines 72-78 explaining the store-vs-calculated split still applies verbatim — keep it above the new `todayCostUsd`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, all four #94 cases included. `tsc` may flag `filterTodayEntries` or `findTodayJsonlFiles` as unused if a step was missed — both are still used inside the ternary, so an unused warning means the edit did not land.

- [ ] **Step 6: Sabotage-check**

Change the ternary condition to `true` (always read). Run `npx vitest run src/__tests__/pipeline.test.ts -t "#94"`. Expected: the first three FAIL. Then change it to `false` (never read). Expected: the fourth FAILS. Restore the real condition and confirm all four PASS. Both directions must be checked — a one-sided check would pass a `false` that breaks calculated mode.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/data/pipeline.ts src/__tests__/pipeline.test.ts
git add -f dist/index.js
git commit -m "Read today's transcripts only under costSource calculated (#94)"
```

---

### Task 3: Expose file stats from the today-files walk

`findTodayJsonlFiles` already calls `statSync` on every candidate. Task 4 needs `mtimeMs` and `size` from that same stat; re-statting would double the syscalls it is trying to avoid.

**Files:**
- Modify: `src/utils/paths.ts:76-101`
- Modify: `src/__tests__/paths.test.ts` (create it if it does not exist)

**Interfaces:**
- Consumes: nothing.
- Produces: `interface TodayJsonlFile { path: string; mtimeMs: number; size: number }` and `findTodayJsonlFileStats(): TodayJsonlFile[]`, both exported from `src/utils/paths.js`. Task 4 imports them. `findTodayJsonlFiles(): string[]` keeps its existing signature.

- [ ] **Step 1: Check whether a paths test file exists**

Run: `ls src/__tests__/paths.test.ts`
If it exists, append the test from Step 2 to it. If not, create it with this header:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findTodayJsonlFileStats, findTodayJsonlFiles } from "../utils/paths.js";

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-paths-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Write the failing test**

```ts
describe("findTodayJsonlFileStats", () => {
  function writeTranscript(name: string, contents: string): string {
    const dir = path.join(tmpDir, ".claude", "projects", "proj");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(filePath, contents);
    return filePath;
  }

  it("reports the size and mtime of each of today's transcripts", () => {
    const filePath = writeTranscript("a", "line one\nline two\n");
    const stat = fs.statSync(filePath);

    const stats = findTodayJsonlFileStats();

    expect(stats).toHaveLength(1);
    expect(stats[0]!.path).toBe(filePath);
    expect(stats[0]!.size).toBe(stat.size);
    expect(stats[0]!.mtimeMs).toBe(stat.mtimeMs);
  });

  it("excludes transcripts last written before today", () => {
    const filePath = writeTranscript("old", "x\n");
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000);
    fs.utimesSync(filePath, yesterday, yesterday);

    expect(findTodayJsonlFileStats()).toHaveLength(0);
  });

  it("findTodayJsonlFiles returns the same paths", () => {
    const a = writeTranscript("a", "x\n");
    const b = writeTranscript("b", "y\n");

    expect(findTodayJsonlFiles().sort()).toEqual([a, b].sort());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/paths.test.ts`
Expected: FAIL — `findTodayJsonlFileStats is not a function`.

- [ ] **Step 4: Implement**

In `src/utils/paths.ts`, replace the whole `findTodayJsonlFiles` function (lines 76-101) with:

```ts
export interface TodayJsonlFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Today's transcripts with the `mtimeMs` and `size` from the stat this walk
 * already performs. `today-aggregate-cache.ts` keys its reuse decision on that
 * pair, and re-statting to get it would double the syscalls the cache exists
 * to avoid.
 */
export function findTodayJsonlFileStats(): TodayJsonlFile[] {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return [];

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const files: TodayJsonlFile[] = [];
  try {
    for (const projectDir of fs.readdirSync(projectsDir)) {
      const fullPath = path.join(projectsDir, projectDir);
      const stat = fs.statSync(fullPath);
      if (!stat.isDirectory()) continue;
      for (const f of findJsonlFiles(fullPath)) {
        const fstat = fs.statSync(f);
        if (fstat.mtimeMs >= todayMs) {
          files.push({ path: f, mtimeMs: fstat.mtimeMs, size: fstat.size });
        }
      }
    }
  } catch {
    // ignore
  }
  return files;
}

export function findTodayJsonlFiles(): string[] {
  return findTodayJsonlFileStats().map((f) => f.path);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/paths.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Sabotage-check**

Change `fstat.mtimeMs >= todayMs` to `true`. Expected: "excludes transcripts last written before today" FAILS. Change `size: fstat.size` to `size: 0`. Expected: "reports the size and mtime" FAILS. Restore both and confirm PASS.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/utils/paths.ts src/__tests__/paths.test.ts
git add -f dist/index.js
git commit -m "Expose mtime and size from the today-transcripts walk"
```

---

### Task 4: The per-file aggregate cache

**Files:**
- Create: `src/cache/today-aggregate-cache.ts`
- Create: `src/__tests__/today-aggregate-cache.test.ts`

**Interfaces:**
- Consumes: `findTodayJsonlFileStats()`, `TodayJsonlFile` (Task 3); `aggregateTokens(entries)` (Task 1); `parseJsonlFile`, `filterTodayEntries` from `../data/jsonl-reader.js`; `readJsonValidated`, `writeJsonAtomic` from `../utils/atomic-json.js`; `getCacheDir` from `../utils/paths.js`.
- Produces: `interface TodayAggregate { byModel: Map<string, TokenMetrics>; totals: TokenMetrics; fileCount: number }` and `getTodayAggregate(now?: Date): TodayAggregate`, exported from `src/cache/today-aggregate-cache.js`. Task 5 calls it from both `pipeline.ts` and `cli.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/today-aggregate-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";

// Pass-through spy: real parsing, but every path read is recorded. "Did this
// render re-parse the file?" is the whole point of the cache and cannot be
// observed from the returned totals.
vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-today-agg-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = path.join(tmpDir, "cache");
  vi.mocked(parseJsonlFile).mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function projectDir(): string {
  const dir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function line(model: string | null, input: number, when: Date): string {
  const message: Record<string, unknown> = {
    usage: { input_tokens: input, output_tokens: 0 },
  };
  if (model !== null) message["model"] = model;
  return JSON.stringify({ type: "assistant", timestamp: when.toISOString(), message });
}

function write(name: string, lines: string[]): string {
  const filePath = path.join(projectDir(), `${name}.jsonl`);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

function append(filePath: string, lines: string[]): void {
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
  // Guarantee a distinct mtime even on a coarse-grained filesystem clock. The
  // cache also keys on size, so this belt-and-braces step only removes a
  // theoretical flake, it is not what the fix relies on.
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(filePath, future, future);
}

function parsedPaths(): string[] {
  return vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0]);
}

const NOW = new Date();
const EARLIER_TODAY = new Date(NOW.getTime() - 60 * 1000);
const YESTERDAY = new Date(NOW.getTime() - 26 * 60 * 60 * 1000);

describe("getTodayAggregate", () => {
  it("sums today's entries across files, by model and in total", () => {
    write("a", [line("opus", 100, EARLIER_TODAY), line("sonnet", 200, EARLIER_TODAY)]);
    write("b", [line("opus", 300, EARLIER_TODAY)]);

    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(600);
    expect(result.byModel.get("opus")?.inputTokens).toBe(400);
    expect(result.byModel.get("sonnet")?.inputTokens).toBe(200);
    expect(result.fileCount).toBe(2);
  });

  it("excludes entries from before midnight in a file touched today", () => {
    write("a", [line("opus", 100, YESTERDAY), line("opus", 50, EARLIER_TODAY)]);

    expect(getTodayAggregate(NOW).totals.inputTokens).toBe(50);
  });

  it("counts model-less usage in totals but not in byModel", () => {
    write("a", [line(null, 70, EARLIER_TODAY)]);

    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(70);
    expect(result.byModel.size).toBe(0);
  });

  it("does not re-parse anything when no file has changed", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toEqual([]);
    expect(result.totals.inputTokens).toBe(300);
  });

  it("re-parses only the file that changed", () => {
    const a = write("a", [line("opus", 100, EARLIER_TODAY)]);
    write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    append(a, [line("opus", 5, EARLIER_TODAY)]);
    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toEqual([a]);
    expect(result.totals.inputTokens).toBe(305);
  });

  it("discards the whole cache when the local date changes", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    getTodayAggregate(NOW);
    vi.mocked(parseJsonlFile).mockClear();

    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    getTodayAggregate(tomorrow);

    expect(parsedPaths()).toHaveLength(1);
  });

  it("drops files that leave today's window", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    const b = write("b", [line("opus", 200, EARLIER_TODAY)]);
    getTodayAggregate(NOW);

    fs.rmSync(b);
    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(100);
    expect(result.fileCount).toBe(1);
  });

  it("recomputes correctly from a corrupt cache file", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    getTodayAggregate(NOW);

    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    fs.writeFileSync(cacheFile, "{ not json");
    vi.mocked(parseJsonlFile).mockClear();

    const result = getTodayAggregate(NOW);

    expect(parsedPaths()).toHaveLength(1);
    expect(result.totals.inputTokens).toBe(100);
  });

  it("recomputes correctly from a schema-valid-looking but wrong cache file", () => {
    write("a", [line("opus", 100, EARLIER_TODAY)]);
    const cacheFile = path.join(tmpDir, "cache", "gccusage", "today-aggregates.json");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ date: "not-today", files: "nope" }));

    expect(getTodayAggregate(NOW).totals.inputTokens).toBe(100);
  });

  it("returns zeroes when there are no transcripts at all", () => {
    const result = getTodayAggregate(NOW);

    expect(result.totals.inputTokens).toBe(0);
    expect(result.byModel.size).toBe(0);
    expect(result.fileCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/today-aggregate-cache.test.ts`
Expected: FAIL — cannot resolve `../cache/today-aggregate-cache.js`.

- [ ] **Step 3: Implement the module**

Create `src/cache/today-aggregate-cache.ts`:

```ts
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, findTodayJsonlFileStats } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { parseJsonlFile, filterTodayEntries } from "../data/jsonl-reader.js";
import { aggregateTokens } from "../data/token-aggregator.js";
import type { TokenMetrics } from "../types/token-metrics.js";

const TokenMetricsSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  cacheCreationTokens: v.number(),
  cacheReadTokens: v.number(),
});

/**
 * `byModel` is entries rather than an object because a Map does not survive
 * JSON; `totals` is stored alongside it because entries carrying usage but no
 * `model` count toward the totals and toward no bucket, so the totals cannot
 * be reconstructed by summing `byModel`.
 */
const FileAggregateSchema = v.object({
  mtimeMs: v.number(),
  size: v.number(),
  byModel: v.array(v.tuple([v.string(), TokenMetricsSchema])),
  totals: TokenMetricsSchema,
});

const TodayAggregateCacheSchema = v.object({
  date: v.string(),
  files: v.record(v.string(), FileAggregateSchema),
});

type FileAggregate = v.InferOutput<typeof FileAggregateSchema>;

export interface TodayAggregate {
  byModel: Map<string, TokenMetrics>;
  totals: TokenMetrics;
  fileCount: number;
}

function cachePath(): string {
  return path.join(getCacheDir(), "today-aggregates.json");
}

/** Local date, matching how `filterTodayEntries` picks its midnight. */
function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function emptyMetrics(): TokenMetrics {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addInto(target: TokenMetrics, source: TokenMetrics): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
}

/**
 * Today's token usage across every transcript, aggregated per file and cached.
 *
 * A cached per-file aggregate is reused only when the file's `mtimeMs` AND
 * `size` both still match, so the returned figure is always assembled from
 * entries that were verified against the live files during this call. Two
 * statuslines racing on the write can therefore cost one extra re-parse on a
 * later render, but neither can serve a wrong total — the same no-lock posture
 * as the daily cost store.
 *
 * Whole files are re-parsed when they change, rather than resuming from a byte
 * offset: `parseJsonlContent` merges lines sharing a `message.id`, so a group
 * straddling an offset boundary would need that map carried across renders.
 * The only file that changes mid-day is the active transcript, and re-parsing
 * it whole is still flat with respect to the day's total volume (#94).
 */
export function getTodayAggregate(now: Date = new Date()): TodayAggregate {
  const files = findTodayJsonlFileStats();
  const date = localDateKey(now);

  const cached = readJsonValidated(cachePath(), TodayAggregateCacheSchema);
  // A different date discards everything: that is the midnight reset.
  const previous = cached && cached.date === date ? cached.files : {};

  const next: Record<string, FileAggregate> = {};
  // A file that dropped out of today's window leaves the counts unequal; one
  // swapped for another is caught by the added file missing from `previous`.
  let changed = Object.keys(previous).length !== files.length;

  for (const file of files) {
    const hit = previous[file.path];
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) {
      next[file.path] = hit;
      continue;
    }

    const entries = filterTodayEntries(parseJsonlFile(file.path), now);
    const aggregate = aggregateTokens(entries);
    next[file.path] = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      byModel: [...aggregate.byModel],
      totals: aggregate.totals,
    };
    changed = true;
  }

  if (changed) {
    try {
      writeJsonAtomic(cachePath(), { date, files: next });
    } catch {
      // The next render recomputes; a cache that cannot be written costs
      // speed, never correctness.
    }
  }

  const byModel = new Map<string, TokenMetrics>();
  const totals = emptyMetrics();
  for (const aggregate of Object.values(next)) {
    addInto(totals, aggregate.totals);
    for (const [model, metrics] of aggregate.byModel) {
      let bucket = byModel.get(model);
      if (!bucket) {
        bucket = emptyMetrics();
        byModel.set(model, bucket);
      }
      addInto(bucket, metrics);
    }
  }

  return { byModel, totals, fileCount: files.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/today-aggregate-cache.test.ts && npm run typecheck`
Expected: PASS, 10 tests.

- [ ] **Step 5: Sabotage-check each guard**

Run the suite after each mutation, restore, then move to the next. Every one must fail the test named beside it.

1. Drop `&& hit.size === file.size` from the reuse condition → "re-parses only the file that changed" must FAIL (only if the filesystem gave the append the same mtime; if it still passes, ALSO drop `hit.mtimeMs === file.mtimeMs` and confirm it fails then — the pair is the guard, and this records which half carried it).
2. Change `cached.date === date` to `cached !== null` → "discards the whole cache when the local date changes" must FAIL.
3. Change `let changed = Object.keys(previous).length !== files.length` to `let changed = false` → "drops files that leave today's window" must FAIL.
4. Remove `filterTodayEntries(...)`, passing `parseJsonlFile(file.path)` straight through → "excludes entries from before midnight in a file touched today" must FAIL.
5. Replace `totals: aggregate.totals` with a sum over `byModel` → "counts model-less usage in totals but not in byModel" must FAIL.

- [ ] **Step 6: Commit**

```bash
npm run build
git add src/cache/today-aggregate-cache.ts src/__tests__/today-aggregate-cache.test.ts
git add -f dist/index.js
git commit -m "Add a per-file aggregate cache for today's transcripts (#94)"
```

---

### Task 5: Route the pipeline and the CLI through the cache

**Files:**
- Modify: `src/data/pipeline.ts` (the ternary added in Task 2, and its imports)
- Modify: `src/cli.ts:1-6,40-76`
- Modify: `src/__tests__/pipeline.test.ts`

**Interfaces:**
- Consumes: `getTodayAggregate(now?)` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to the `describe("today's transcripts are read only when they are used (#94)")` block in `src/__tests__/pipeline.test.ts`:

```ts
  it("does not re-parse unchanged transcripts on a second calculated render", async () => {
    writeTranscript("sess-current");
    const other = writeOtherSessionTranscript("sess-other");

    await buildRenderContext(stdinWithCost, settingsWith("calculated"));
    vi.mocked(parseJsonlFile).mockClear();

    const ctx = await buildRenderContext(stdinWithCost, settingsWith("calculated"));

    // The session transcript is still read every render — it feeds byModel,
    // session totals and the start timestamp. Today's OTHER transcripts come
    // from the cache.
    expect(parsedPaths()).not.toContain(other);
    expect(ctx.todayCostUsd).toBeCloseTo(3.0, 6);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/pipeline.test.ts -t "does not re-parse unchanged"`
Expected: FAIL — the pipeline still parses every today-file inline on each call.

- [ ] **Step 3: Rewrite the pipeline's today branch**

In `src/data/pipeline.ts`, replace the `today` ternary from Task 2 with:

```ts
  const today =
    settings.costSource === "calculated"
      ? calculateCostByModel(getTodayAggregate().byModel, pricing)
      : null;
```

Update the imports at the top: `filterTodayEntries` and `findTodayJsonlFiles` are now unused here — change line 4 to

```ts
import { findSessionJsonlFiles } from "../utils/paths.js";
```

and line 5 to

```ts
import { parseJsonlFile } from "./jsonl-reader.js";
```

then add:

```ts
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
```

- [ ] **Step 4: Route the CLI through the same cache**

In `src/cli.ts`, replace the body of `reportToday` (lines 40-76) with:

```ts
async function reportToday(): Promise<void> {
  // Same per-file cache the statusline uses, so a `gccusage today` run right
  // after a render costs a stat sweep rather than a full re-parse (#94).
  const { byModel, totals, fileCount } = getTodayAggregate();
  const pricing = await fetchPricing(86400000);
  const { costs: costByModel, unpriced } = calculateCostByModel(byModel, pricing);
  const totalCost = calculateTotalCost(costByModel);

  console.log("=== Today's Usage ===\n");
  console.log(`Total Cost: ${formatDollars(totalCost)}${unpriced.length > 0 ? " (partial)" : ""}`);
  console.log(`Total Tokens: ${formatTokens(totals.inputTokens + totals.outputTokens)}`);
  console.log();

  if (costByModel.size > 0) {
    console.log("By Model:");
    for (const [model, cost] of costByModel) {
      const tokens = byModel.get(model);
      const total = tokens
        ? tokens.inputTokens + tokens.outputTokens
        : 0;
      console.log(
        `  ${formatModelName(model)}: ${formatDollars(cost)} (${formatTokens(total)} tokens)`,
      );
    }
  }

  // Without this the usage of an unpriced model is simply absent from the
  // total, and the report looks complete (#82).
  if (unpriced.length > 0) {
    console.log(`\nNo pricing for ${unpriced.join(", ")} — their usage is missing from the total.`);
    console.log("Run \`npm run pricing\` to refresh the offline table.");
  }

  console.log(`\nSessions analyzed: ${fileCount} files`);
}
```

Note the backticks inside the `npm run pricing` string must stay as plain backticks in a normal string literal — copy that line from the original file rather than retyping it, to be certain the output is byte-identical.

Then fix the imports: delete lines 1-3 and replace with

```ts
import { getTodayAggregate } from "./cache/today-aggregate-cache.js";
```

`findTodayJsonlFiles`, `findSessionJsonlFiles`, `parseJsonlFile`, `filterTodayEntries` and `aggregateTokens` are all now unused in `cli.ts` — `tsc` will confirm.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Verify the CLI output really is unchanged**

The real check is against a real corpus, since the test suite has no `gccusage today` fixture.

```bash
git stash && npm run build && node dist/index.js today > /private/tmp/claude-501/-Users-gpietro-projects-gccusage/4729b5c1-fedb-40e3-838c-880c6370ce42/scratchpad/today-before.txt
git stash pop && npm run build
rm -f ~/.cache/gccusage/today-aggregates.json
node dist/index.js today > /private/tmp/claude-501/-Users-gpietro-projects-gccusage/4729b5c1-fedb-40e3-838c-880c6370ce42/scratchpad/today-after.txt
diff /private/tmp/claude-501/-Users-gpietro-projects-gccusage/4729b5c1-fedb-40e3-838c-880c6370ce42/scratchpad/today-{before,after}.txt && echo "IDENTICAL"
```

Expected: `IDENTICAL`. Then run `node dist/index.js today` a second time (warm cache) and diff again — also identical, and visibly faster.

If the two differ, do not proceed: the difference is the bug, and it will be in `totals` vs the old `metrics.today`, or in `fileCount` vs `files.length`.

- [ ] **Step 7: Sabotage-check**

In `today-aggregate-cache.ts`, force `const previous = {}`. Run `npx vitest run src/__tests__/pipeline.test.ts -t "does not re-parse unchanged"`. Expected: FAIL. Restore and confirm PASS.

- [ ] **Step 8: Commit**

```bash
npm run build
git add src/data/pipeline.ts src/cli.ts src/__tests__/pipeline.test.ts
git add -f dist/index.js
git commit -m "Route the pipeline and gccusage today through the aggregate cache (#94)"
```

---

### Task 6: Pin the acceptance criterion

The issue asks for render time flat with respect to the day's transcript volume. A wall-clock assertion in CI is flaky, so CI pins the thing that *causes* the time — bytes read from transcripts — and asserts it does not grow with the corpus. The literal 35 MB / 350 MB timing is measured in Task 7 and reported in the PR.

**Files:**
- Create: `src/__tests__/today-read-flatness.test.ts`

**Interfaces:**
- Consumes: `buildRenderContext` (Task 2/5), `getTodayAggregate` (Task 4).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/today-read-flatness.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { getTodayAggregate } from "../cache/today-aggregate-cache.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";
import { parseJsonlFile } from "../data/jsonl-reader.js";

const PINNED_PRICING = {
  "test-model": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

vi.mock("../data/jsonl-reader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/jsonl-reader.js")>();
  return { ...actual, parseJsonlFile: vi.fn(actual.parseJsonlFile) };
});

let tmpDir: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-flatness-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpDir;
  process.env["XDG_CACHE_HOME"] = path.join(tmpDir, "cache");
  vi.mocked(parseJsonlFile).mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Writes `sess-0` (the rendering session's own transcript) at a FIXED
 * `sessionLines`, and every other file at `linesPerFile`. Holding the session
 * file constant while scaling the rest is what makes the flatness assertion
 * sharp: the warm render must read exactly the session file and nothing else,
 * so its bytes-parsed figure has to come out *identical* across corpus sizes
 * rather than merely growing slowly.
 */
function writeCorpus(fileCount: number, linesPerFile: number, sessionLines = 100): string[] {
  const dir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let f = 0; f < fileCount; f++) {
    const lines: string[] = [];
    const count = f === 0 ? sessionLines : linesPerFile;
    for (let i = 0; i < count; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date().toISOString(),
          sessionId: `sess-${f}`,
          message: {
            id: `msg-${f}-${i}`,
            model: "test-model",
            usage: { input_tokens: 10, output_tokens: 0 },
            // Padding, so a line resembles a real transcript line in size.
            content: [{ type: "text", text: "x".repeat(400) }],
          },
        }),
      );
    }
    const filePath = path.join(dir, `sess-${f}.jsonl`);
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    paths.push(filePath);
  }
  return paths;
}

/** Total bytes of every transcript this render actually read and parsed. */
function bytesParsed(): number {
  return vi
    .mocked(parseJsonlFile)
    .mock.calls.map((c) => c[0])
    .reduce((sum, p) => sum + (fs.existsSync(p) ? fs.statSync(p).size : 0), 0);
}

function settingsWith(costSource: Settings["costSource"]): Settings {
  return { ...DEFAULT_SETTINGS, costSource };
}

const SMALL = 200;
const LARGE = 2000; // 10x

describe("cache-miss cost is flat in the day's transcript volume (#94)", () => {
  it("reads nothing but its own session's transcript in the default config", async () => {
    const paths = writeCorpus(8, LARGE);
    const stdin = { session_id: "sess-0", cost: { total_cost_usd: 1 } } as StatusJson;

    await buildRenderContext(stdin, settingsWith("auto"));

    // Its own transcript, and only that one, out of eight.
    expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[0]]);
  });

  it("parses an identical number of bytes on a warm calculated render, at both corpus sizes", async () => {
    const stdin = { session_id: "sess-0", cost: { total_cost_usd: 1 } } as StatusJson;

    // Two renders: the first populates the cache, the second is the one under
    // test. `smallCorpus`/`largeCorpus` differ 10x in everything EXCEPT the
    // session's own transcript, which is pinned at 100 lines by writeCorpus.
    const measureWarm = async (linesPerFile: number): Promise<number> => {
      fs.rmSync(path.join(tmpDir, ".claude"), { recursive: true, force: true });
      fs.rmSync(path.join(tmpDir, "cache"), { recursive: true, force: true });
      const paths = writeCorpus(8, linesPerFile);
      await buildRenderContext(stdin, settingsWith("calculated"));
      vi.mocked(parseJsonlFile).mockClear();
      await buildRenderContext(stdin, settingsWith("calculated"));

      // Exactly the session's own transcript, nothing else.
      expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[0]]);
      return bytesParsed();
    };

    const smallWarm = await measureWarm(SMALL);
    const largeWarm = await measureWarm(LARGE);

    // The 10x corpus growth is entirely in files the warm render never touches,
    // so the bytes it parses are not merely similar — they are the same number.
    // This is #94's acceptance criterion, stated deterministically.
    expect(smallWarm).toBeGreaterThan(0);
    expect(largeWarm).toBe(smallWarm);
  });

  it("re-parses only the changed file, whatever the corpus size", async () => {
    const paths = writeCorpus(8, LARGE);
    getTodayAggregate();
    vi.mocked(parseJsonlFile).mockClear();

    fs.appendFileSync(
      paths[3]!,
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: { model: "test-model", usage: { input_tokens: 1, output_tokens: 0 } },
      }) + "\n",
    );
    getTodayAggregate();

    expect(vi.mocked(parseJsonlFile).mock.calls.map((c) => c[0])).toEqual([paths[3]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/today-read-flatness.test.ts`
Expected: PASS. These are written after the fix, so they pass immediately — which is exactly why Step 3 is mandatory.

- [ ] **Step 3: Sabotage-check all three**

1. In `pipeline.ts`, change the today ternary condition to `true` → "reads nothing but its own session's transcript" must FAIL.
2. In `today-aggregate-cache.ts`, force `const previous = {}` → both remaining tests must FAIL.

Restore after each and confirm PASS. If any test still passes under its mutation, it is vacuous — fix the test, not the mutation.

- [ ] **Step 4: Commit**

```bash
npm run build
git add src/__tests__/today-read-flatness.test.ts
git add -f dist/index.js
git commit -m "Pin #94's acceptance criterion: bytes parsed stay flat as the corpus grows"
```

---

### Task 7: Measure at the issue's stated sizes, then ship

**Files:**
- Modify: `AUDIT.md` (local only — never staged)
- No source changes expected.

**Interfaces:**
- Consumes: everything above.
- Produces: the PR.

- [ ] **Step 1: Confirm the whole suite and typecheck pass**

Run: `npm test && npm run typecheck`
Expected: PASS. Record the test count — it should exceed the 617 recorded for PR #110.

- [ ] **Step 2: Verify the committed bundle matches a fresh build**

Run: `npm run build && git diff --exit-code -- dist/index.js && echo "BUNDLE CLEAN"`
Expected: `BUNDLE CLEAN`. This is the check CI's `bundle-drift` job runs.

- [ ] **Step 3: Measure against the real corpus**

```bash
rm -f ~/.cache/gccusage/statusline-cache.json ~/.cache/gccusage/today-aggregates.json
STDIN_JSON='{"session_id":"measure-1","cwd":"'"$PWD"'","model":{"id":"claude-opus-4-6","display_name":"Opus"},"cost":{"total_cost_usd":1.23,"total_duration_ms":600000}}'

for i in 1 2 3; do
  rm -f ~/.cache/gccusage/statusline-cache.json
  /usr/bin/time -p sh -c "echo '$STDIN_JSON' | node dist/index.js > /dev/null" 2>&1 | grep real
done
```

Run the same three times on `git stash`-ed (pre-change) code for the before figure. Record both. Expected: a clear drop, since the 33 MB read is gone from the default path.

- [ ] **Step 4: Measure the calculated path at 35 MB and 350 MB**

The issue names these sizes explicitly, so measure them rather than inferring from the ratio test. Write this to the scratchpad (do NOT commit it):

```bash
cat > /private/tmp/claude-501/-Users-gpietro-projects-gccusage/4729b5c1-fedb-40e3-838c-880c6370ce42/scratchpad/bench-corpus.mjs <<'EOF'
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const targetMb = Number(process.argv[2] ?? 35);
const home = fs.mkdtempSync(path.join(os.tmpdir(), `gccusage-bench-${targetMb}-`));
const dir = path.join(home, ".claude", "projects", "proj");
fs.mkdirSync(dir, { recursive: true });

const line = (f, i) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    sessionId: `sess-${f}`,
    message: {
      id: `msg-${f}-${i}`,
      model: "claude-opus-4-6",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "x".repeat(1800) }],
    },
  });

const FILES = 20;
let written = 0;
for (let f = 0; f < FILES; f++) {
  const lines = [];
  let bytes = 0;
  while (bytes < (targetMb * 1e6) / FILES) {
    const l = line(f, lines.length);
    lines.push(l);
    bytes += l.length + 1;
  }
  fs.writeFileSync(path.join(dir, `sess-${f}.jsonl`), lines.join("\n") + "\n");
  written += bytes;
}
console.log(`${home} ${(written / 1e6).toFixed(1)}MB`);
EOF
```

Then, for each size:

```bash
SCRATCH=/private/tmp/claude-501/-Users-gpietro-projects-gccusage/4729b5c1-fedb-40e3-838c-880c6370ce42/scratchpad
for MB in 35 350; do
  read -r BENCH_HOME SIZE < <(node $SCRATCH/bench-corpus.mjs $MB)
  echo "=== ${SIZE} corpus ==="
  mkdir -p "$SCRATCH/cfg-$MB/gccusage"
  echo '{"costSource":"calculated"}' > "$SCRATCH/cfg-$MB/gccusage/settings.json"
  STDIN_JSON='{"session_id":"sess-0","cwd":"'"$PWD"'","model":{"id":"claude-opus-4-6","display_name":"Opus"},"cost":{"total_cost_usd":1.23}}'
  for run in cold warm1 warm2; do
    [ "$run" = cold ] && rm -rf "$SCRATCH/cache-$MB"
    rm -f "$SCRATCH/cache-$MB/gccusage/statusline-cache.json"
    printf '%s: ' "$run"
    HOME="$BENCH_HOME" XDG_CACHE_HOME="$SCRATCH/cache-$MB" XDG_CONFIG_HOME="$SCRATCH/cfg-$MB" \
      /usr/bin/time -p sh -c "echo '$STDIN_JSON' | node $PWD/dist/index.js > /dev/null" 2>&1 | grep real
  done
  rm -rf "$BENCH_HOME"
done
```

Expected: `cold` grows roughly 10x from 35 MB to 350 MB (unavoidable — nothing is cached yet), while `warm1`/`warm2` stay roughly constant between the two corpora. That constancy is the acceptance criterion. Record all six numbers verbatim for the PR body.

If `warm` does grow with corpus size, stop and diagnose — the most likely cause is `findTodayJsonlFileStats` reporting a changing `mtimeMs` (check whether the bench writes and the render land in the same second) rather than a defect in the cache.

- [ ] **Step 5: Update the local audit ledger**

Edit `AUDIT.md`: mark `PERF-001` / #94 closed, with the measured before/after numbers, the finding that `metrics.today` had no render-path consumer, and the note that the issue's own suggested fixes all optimised a computation that mostly should not have run. **Do not `git add` this file.**

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin perf/today-transcript-read
gh pr create --title "Stop re-reading today's transcripts on every cache miss (#94)" --body "$(cat <<'EOF'
Closes #94.

## What was actually wrong

`buildRenderContext` parsed every transcript touched today on every cache miss —
23 files / 33.2 MB / 80 ms on a real corpus. In the shipped default config that
work was entirely discarded:

- `metrics.today` had **one** consumer repo-wide, `src/cli.ts:51`, and `cli.ts`
  never calls `buildRenderContext`. No widget reads it.
- `calculatedTodayCost` is used only under `costSource: "calculated"`. The
  default is `"auto"`, where today's spend comes from the daily store.

The issue's own suggested fixes (incremental offsets, mtime skip, dedupe the
double aggregation) all optimise a computation that mostly should not run.

## Changes

1. `aggregateTokens(entries)` replaces the two-array form; `AggregatedMetrics.today`
   is deleted rather than left reading zero, so a future widget must add the
   plumbing deliberately instead of getting a plausible 0.
2. Today's transcripts are read only when `settings.costSource === "calculated"`.
   The gate is the setting, not the resolved source: `"auto"` with no stdin cost
   resolves the *session* source to calculated while today's spend still comes
   from the store.
3. `src/cache/today-aggregate-cache.ts` reuses a per-file aggregate whenever
   `(mtimeMs, size)` are both unchanged, so the calculated path re-parses only
   files that actually grew. `gccusage today` shares it; its output is unchanged
   (verified by diff against the pre-change binary).

A cached entry is reused only after `(mtimeMs, size)` re-verify against the live
file, so racing statuslines can cost an extra re-parse but can never serve a
wrong total — the same no-lock posture as the daily cost store.

## Measurements

<!-- paste the Step 3 and Step 4 numbers here -->

## Tests

<!-- paste the final test count here -->
Every new test was sabotage-checked by breaking what it guards.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill the two placeholder comments with the recorded numbers before creating the PR — an unfilled measurements section is the one thing this issue cannot ship without.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: single-array `aggregateTokens` and the `today` deletion → Task 1; the setting-not-source gate → Task 2; `findTodayJsonlFileStats` → Task 3; the cache module, its schema, midnight invalidation, whole-file re-parse and the `totals`-alongside-`byModel` decision → Task 4; pipeline and `cli.ts` wiring plus the byte-identical-output check → Task 5; the acceptance criterion → Task 6; the 35/350 MB measurement, bundle and ledger → Task 7.

**Type consistency.** `aggregateTokens(entries): {byModel, totals}` (Task 1) is what Task 4 calls and what Task 5's `metrics.totals` reads. `TodayJsonlFile {path, mtimeMs, size}` (Task 3) is destructured in Task 4 as `file.path`/`file.mtimeMs`/`file.size`. `TodayAggregate {byModel, totals, fileCount}` (Task 4) is destructured in Task 5's `reportToday` and read as `.byModel` in `pipeline.ts`.

**Known interaction to watch.** Task 2 adds a module-level `vi.mock("../data/jsonl-reader.js")` to `pipeline.test.ts`. It is a pass-through wrapper, so the existing cases in that file keep their real behaviour — but if any pre-existing test in that file breaks at Task 2 Step 5, the mock is the first suspect, not the pipeline change.
