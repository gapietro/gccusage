# Widget Reality Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give all 25 registered widgets an exact, real-payload-backed expected output, and a guard that makes it impossible to register a 26th widget without one.

**Architecture:** Three sanitized payloads captured from Claude Code 2.1.220 are stored together with the *derived* `RenderContext` values a real pipeline run produced for them. A matrix test renders every widget against every fixture and asserts exact text; a two-way completeness guard ties the table to `getWidgetTypes()`; one integration case drives a fixture through the real `runStatusline`. Widgets confirmed to be wrong assert their current output tagged with `knownWrong: <issue>`.

**Tech Stack:** TypeScript, vitest, valibot, tsdown.

## Global Constraints

- `src/` uses `.js` import specifiers (tsdown rewrites them). `scripts/` uses `.ts`. Never mix.
- Any commit touching `src/` must run `npm run build` and stage `dist/index.js` (`git add -f dist/index.js`). This plan touches only `src/__tests__/`, so **no rebuild is required** unless a task changes production code.
- `vitest.config.ts` pins `include` to `src/**/__tests__/**/*.test.ts` and `scripts/**/__tests__/**/*.test.ts`. Helper modules under `__tests__` that are not `*.test.ts` are not collected — this is intentional and required for the fixture/table modules.
- Hermetic tests set **both** `HOME` and `XDG_CACHE_HOME` to a tmpdir.
- `daily-costs.json` keys its `date` on the **local** date. Never seed it with a UTC date string.
- Do not mock `../utils/paths.js` wholesale — it also exports `getCacheDir`/`ensureDir`.
- Mock only `../data/pricing-fetcher.js` (it hits the network).

---

### Task 1: File the six confirmed findings as issues

No code. This task produces the issue numbers that Task 3's `knownWrong` fields reference, so it must complete first.

**Files:** none.

**Interfaces:**
- Produces: six issue numbers, recorded in this plan's Task 3 table before Task 3 starts.

- [ ] **Step 1: File each finding with its evidence**

Use the evidence already gathered (all figures come from the captured 2.1.220 payload, session cost $4.32):

| Finding | Title | Key evidence to include |
|---|---|---|
| A | `token-breakdown` reports a last-message snapshot as session totals | Renders `In:117.3k Out:3` while the session's real output was 37,659 tokens |
| B | `cwd` basename is the wrong project identifier (blocks #48) | Real `cwd` is `.../gccusage/src/widgets` → basename `widgets`; `workspace.project_dir` holds the repo root but is not parsed |
| C | `cache-hit-rate` and `tokens-cached` both label `Cache:` | `Cache: 99%` vs `Cache: 5.24M` |
| D | `session-clock` and `session-timer` duplicate one concept | `28m 9s` vs `27m 44s` from two different sources |
| E | `api-latency` shows cumulative API time under a per-request name | `API: 8m 26s` from `total_api_duration_ms` |
| F | `per-model` collapses distinct models to the same short name | `"Sonnet 4.5"` and `"Sonnet 4"` both → `S4` |

Command shape:

```bash
gh issue create --title "<title>" --body "<evidence + how it was found>"
```

Each body must state that it was found by the #47 reality harness and name the fixture.

- [ ] **Step 2: Record the numbers**

Write the six issue numbers into the Task 3 expectation table below, replacing the `A`–`F` markers. Do not proceed to Task 3 until every marker is a real number.

- [ ] **Step 3: Commit**

Nothing to commit — issues live on GitHub. Proceed.

---

### Task 2: Capture and sanitize the three fixtures

**Files:**
- Create: `src/__tests__/fixtures/real-payloads/fixture-types.ts`
- Create: `src/__tests__/fixtures/real-payloads/opus5-1m-mid.json`
- Create: `src/__tests__/fixtures/real-payloads/fable5-1m-low.json`
- Create: `src/__tests__/fixtures/real-payloads/opus5-1m-early.json`
- Create: `src/__tests__/fixtures/real-payloads/capture.md`

**Interfaces:**
- Produces: `RealPayloadFixture` (the type below) and three JSON files conforming to it. Task 3 and Task 4 both import the type and load the JSON.

- [ ] **Step 1: Define the fixture type**

Create `src/__tests__/fixtures/real-payloads/fixture-types.ts`:

```ts
import type { AggregatedMetrics } from "../../../types/token-metrics.js";
import type { BlockMetrics } from "../../../types/block-metrics.js";
import type { BurnRate } from "../../../types/burn-rate.js";

/**
 * A real Claude Code statusline payload plus the RenderContext values a real
 * pipeline run derived from it.
 *
 * The derived block is RECORDED, not invented. Hand-written context values are
 * exactly the failure mode #47 exists to close: they encode what we believe the
 * pipeline produces rather than what it does produce.
 */
export interface RealPayloadFixture {
  name: string;
  claudeCodeVersion: string;
  /** Epoch ms at capture. Pins Date.now() so elapsed-time widgets are exact. */
  capturedAt: number;
  /** Absolute path prefix standing in for the real home dir in sanitized paths. */
  homePlaceholder: string;
  /** The raw payload as Claude Code sent it, with identifying values replaced. */
  stdin: Record<string, unknown>;
  derived: {
    metrics: AggregatedMetrics;
    sessionCostUsd: number;
    todayCostUsd: number;
    /** Map is not JSON-serialisable; stored as entries. */
    costByModel: [string, number][];
    sessionStartTime: number | null;
    turnCount: number;
    block: BlockMetrics | null;
    burnRate: BurnRate | null;
  };
}
```

`AggregatedMetrics` contains a `byModel` Map. Confirm its JSON shape when writing the
capture script in Step 2 and, if it is a Map, store it as entries exactly like
`costByModel` and reconstruct on load.

- [ ] **Step 2: Write a throwaway capture script**

The raw captures are at
`/private/tmp/claude-501/-Users-gpietro-projects-gccusage/60d7554b-c1e3-4aa4-9186-7349cd42c5d0/scratchpad/captured-stdin.jsonl`
(23 lines). Select three by `context_window`:

- `opus5-1m-mid` — `used_percentage` 26 or 28, `claude-opus-5[1m]`, 1M window
- `fable5-1m-low` — `claude-fable-5`, 1M window, `used_percentage` 6
- `opus5-1m-early` — `claude-opus-5[1m]`, 1M window, `used_percentage` 11

Exclude the synthetic probe line (`claude-opus-4-6`, 200k window) — it was injected by
the wrapper smoke test and is not a real Claude Code payload.

Create `src/__tests__/zz-capture.test.ts` as a temporary generator (deleted in Step 5):

```ts
import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as v from "valibot";
import { buildRenderContext } from "../data/pipeline.js";
import { StatusJsonSchema } from "../types/status-json.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

const SRC = "/private/tmp/claude-501/-Users-gpietro-projects-gccusage/60d7554b-c1e3-4aa4-9186-7349cd42c5d0/scratchpad/captured-stdin.jsonl";
const OUT = "src/__tests__/fixtures/real-payloads";
const HOME_PLACEHOLDER = "/home/testuser";

const PICKS = [
  { name: "opus5-1m-mid", match: (d: any) => d.model?.id === "claude-opus-5[1m]" && d.context_window?.used_percentage >= 26 },
  { name: "fable5-1m-low", match: (d: any) => d.model?.id === "claude-fable-5" && d.context_window?.used_percentage <= 6 },
  { name: "opus5-1m-early", match: (d: any) => d.model?.id === "claude-opus-5[1m]" && d.context_window?.used_percentage === 11 },
];

function sanitize(d: any, home: string): any {
  const s = JSON.parse(JSON.stringify(d));
  const swap = (val: string) => val.split(home).join(HOME_PLACEHOLDER);
  if (s.cwd) s.cwd = swap(s.cwd);
  if (s.transcript_path) s.transcript_path = swap(s.transcript_path);
  if (s.workspace) {
    if (s.workspace.current_dir) s.workspace.current_dir = swap(s.workspace.current_dir);
    if (s.workspace.project_dir) s.workspace.project_dir = swap(s.workspace.project_dir);
    if (s.workspace.repo) s.workspace.repo = { host: "github.com", owner: "example", name: "demo" };
  }
  s.session_id = "00000000-0000-4000-8000-000000000000";
  if (s.prompt_id) s.prompt_id = "00000000-0000-4000-8000-000000000001";
  if (s.session_name) s.session_name = "Example session";
  return s;
}

describe("capture", () => {
  it("writes fixtures", async () => {
    const home = process.env["HOME"]!;
    const lines = fs.readFileSync(SRC, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    fs.mkdirSync(OUT, { recursive: true });
    for (const pick of PICKS) {
      const rawAll = lines.filter(pick.match);
      if (rawAll.length === 0) throw new Error(`no payload matched ${pick.name}`);
      const raw = rawAll[rawAll.length - 1];
      // Derive against the REAL payload (real session_id reaches real transcripts),
      // then store the sanitized payload alongside the derived values.
      const ctx = await buildRenderContext(v.parse(StatusJsonSchema, raw), DEFAULT_SETTINGS);
      const fixture = {
        name: pick.name,
        claudeCodeVersion: raw.version ?? "unknown",
        capturedAt: Date.now(),
        homePlaceholder: HOME_PLACEHOLDER,
        stdin: sanitize(raw, home),
        derived: {
          metrics: { ...ctx.metrics, byModel: [...ctx.metrics.byModel] },
          sessionCostUsd: ctx.sessionCostUsd,
          todayCostUsd: ctx.todayCostUsd,
          costByModel: [...ctx.costByModel],
          sessionStartTime: ctx.sessionStartTime,
          turnCount: ctx.turnCount,
          block: ctx.block,
          burnRate: ctx.burnRate,
        },
      };
      fs.writeFileSync(`${OUT}/${pick.name}.json`, JSON.stringify(fixture, null, 2) + "\n");
      console.log("wrote", pick.name);
    }
  }, 60000);
});
```

- [ ] **Step 3: Run the generator**

Run: `npx vitest run src/__tests__/zz-capture.test.ts`
Expected: PASS, three "wrote <name>" lines.

- [ ] **Step 4: Verify the sanitization removed every identifying value**

Run:

```bash
grep -rlE "gpietro|60d7554b|99199410|gccusage/\.claude" src/__tests__/fixtures/real-payloads/ || echo "CLEAN"
```

Expected: `CLEAN`. If any file matches, extend `sanitize()` and regenerate. Then confirm the
derived numbers survived:

```bash
node -e 'const f=require("./src/__tests__/fixtures/real-payloads/opus5-1m-mid.json");
console.log(f.derived.metrics.session, f.derived.turnCount, f.stdin.cwd)'
```

Expected: real non-zero token counts, and a `cwd` under `/home/testuser`.

- [ ] **Step 5: Delete the generator and write capture.md**

```bash
rm src/__tests__/zz-capture.test.ts
```

Create `src/__tests__/fixtures/real-payloads/capture.md` documenting: Claude Code version
`2.1.220`, the capture date, that capture worked by temporarily pointing
`statusLine.command` at a `tee` wrapper, that identifying values are sanitized, that the
`derived` block was recorded from a real `buildRenderContext` run and must never be
hand-edited, and how to refresh the corpus.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/fixtures/real-payloads/
git commit -m "Add real Claude Code payload fixtures with recorded pipeline context (#47)"
```

---

### Task 3: Expectation table and two-way completeness guard

This is the part that stops the dormancy recurring. Build it before the matrix so the
matrix has a table to iterate.

**Files:**
- Create: `src/__tests__/fixtures/widget-expectations.ts`
- Create: `src/__tests__/widget-reality.test.ts`

**Interfaces:**
- Consumes: `RealPayloadFixture` from Task 2.
- Produces: `WIDGET_EXPECTATIONS: Record<string, WidgetExpectation>` and the
  `WidgetExpectation` type, both imported by Task 4's matrix.

- [ ] **Step 1: Write the failing guard test**

Create `src/__tests__/widget-reality.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getWidgetTypes } from "../widgets/registry.js";
import { WIDGET_EXPECTATIONS } from "./fixtures/widget-expectations.js";

describe("expectation table completeness", () => {
  it("covers every registered widget type", () => {
    const missing = getWidgetTypes().filter((t) => !(t in WIDGET_EXPECTATIONS));
    expect(missing, `registered widgets with no expectation entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no entry for an unregistered widget type", () => {
    const registered = new Set(getWidgetTypes());
    const stale = Object.keys(WIDGET_EXPECTATIONS).filter((t) => !registered.has(t));
    expect(stale, `expectation entries with no registered widget: ${stale.join(", ")}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: FAIL — cannot resolve `./fixtures/widget-expectations.js`.

- [ ] **Step 3: Write the expectation table**

Create `src/__tests__/fixtures/widget-expectations.ts`. Replace `A`–`F` with the real
issue numbers from Task 1.

```ts
/**
 * What every registered widget is expected to render against the real payload
 * fixtures.
 *
 * `text` is the EXACT string observed against `opus5-1m-mid`. Asserting exact
 * text rather than "non-empty or null" is deliberate: every one of the 25
 * widgets returns a plausible non-empty string against a real payload, so a
 * smoke test passes on all of them and catches nothing (#47).
 *
 * `knownWrong` marks output that is confirmed incorrect and tracked by an
 * issue. The assertion still encodes CURRENT behaviour so the suite stays
 * green; the tag keeps the defect visible here and forces a deliberate edit
 * when it is fixed.
 */
export interface WidgetExpectation {
  /** Exact text against opus5-1m-mid, or null when the widget declines to render. */
  text: string | null;
  /** Why this is the right output — or why the widget correctly declines. */
  why: string;
  /** Issue number tracking confirmed-wrong output. */
  knownWrong?: number;
}

export const WIDGET_EXPECTATIONS: Record<string, WidgetExpectation> = {
  model: { text: "Opus 5", why: "formatModelName strips the [1m] suffix" },
  "session-cost": { text: "$4.32", why: "sessionCostUsd from the recorded pipeline run" },
  "today-spend": { text: "Today: $521", why: "todayCostUsd from the daily cost tracker" },
  "block-timer": { text: "Block: 1hr 39m", why: "block.elapsedMs, clock pinned to capturedAt" },
  "burn-rate": { text: "$9.34/hr", why: "recorded burnRate" },
  "context-percent": { text: "[=---------] 12% (1.00M)", why: "used_percentage against a 1M window" },
  "git-branch": { text: "reality-fixture", why: "scratch repo branch" },
  "git-changes": { text: "+1", why: "scratch repo has one added file" },
  "tokens-input": { text: "In: 122", why: "metrics.session.inputTokens — uncached input only" },
  "tokens-output": { text: "Out: 37.7k", why: "metrics.session.outputTokens, real session total" },
  "tokens-cached": { text: "Cache: 5.24M", why: "cacheCreation + cacheRead", knownWrong: C },
  "per-model": { text: "O5:$4.13", why: "one model this session", knownWrong: F },
  "session-clock": { text: "28m 9s", why: "capturedAt - sessionStartTime", knownWrong: D },
  cwd: { text: "~/projects/gccusage/src/widgets", why: "full path, home abbreviated", knownWrong: B },
  "custom-text": { text: null, why: "declines without user-supplied text — correct" },
  "custom-command": { text: null, why: "declines without a configured command — correct" },
  separator: { text: " | ", why: "structural widget, renders its glyph" },
  "cache-hit-rate": { text: "Cache: 99%", why: "cache_read / (read + creation)", knownWrong: C },
  "lines-changed": { text: "+112 -7", why: "cost.total_lines_added / removed" },
  "vim-mode": { text: null, why: "declines when vim mode is off — correct" },
  "api-latency": { text: "API: 8m 26s", why: "cumulative total_api_duration_ms", knownWrong: E },
  "token-breakdown": { text: "In:117.3k Out:3", why: "context_window totals — a last-message snapshot", knownWrong: A },
  "session-timer": { text: "27m 44s", why: "cost.total_duration_ms", knownWrong: D },
  "compact-countdown": { text: "~847.0k left", why: "windowSize - used - 33k reserve" },
  "turn-counter": { text: "#9", why: "turnCount from the turn tracker" },
};
```

Every `text` above was observed by rendering against the real payload, except
`git-branch` and `git-changes`, which Task 4 pins with a scratch repo. If any observed
value differs when Task 4 runs, **correct the table to the observed value** — do not adjust
the widget. Recording reality is the point.

- [ ] **Step 4: Run the guard to verify it passes**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the guard actually guards**

Temporarily add `"not-a-widget": { text: null, why: "x" }` to the table and re-run.
Expected: the second test FAILS naming `not-a-widget`. Remove it.
Then temporarily comment out the `model:` entry and re-run.
Expected: the first test FAILS naming `model`. Restore it.

A guard that has never been seen to fail is not a guard.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/fixtures/widget-expectations.ts src/__tests__/widget-reality.test.ts
git commit -m "Add widget expectation table and two-way completeness guard (#47)"
```

---

### Task 4: The matrix

**Files:**
- Modify: `src/__tests__/widget-reality.test.ts`

**Interfaces:**
- Consumes: `WIDGET_EXPECTATIONS`, `RealPayloadFixture`, the three fixture JSON files.
- Produces: nothing imported elsewhere.

- [ ] **Step 1: Write the failing matrix test**

Append to `src/__tests__/widget-reality.test.ts`:

```ts
import { beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as v from "valibot";
import { getWidget } from "../widgets/registry.js";
import { StatusJsonSchema } from "../types/status-json.js";
import type { RenderContext } from "../types/render-context.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };

let tmpHome: string;
let originalHome: string | undefined;

function initScratchRepo(repoDir: string): void {
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-q", "-b", "reality-fixture");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git("add", "seed.txt");
  git("commit", "-q", "-m", "seed");
  // one ADDED file -> git-changes renders "+1"
  fs.writeFileSync(path.join(repoDir, "added.txt"), "added\n");
  git("add", "added.txt");
}

/** Rebuild a RenderContext from a fixture's recorded derived values. */
function contextFromFixture(fx: RealPayloadFixture, homeDir: string): RenderContext {
  const stdinRaw = JSON.parse(
    JSON.stringify(fx.stdin).split(fx.homePlaceholder).join(homeDir),
  );
  return {
    stdin: v.parse(StatusJsonSchema, stdinRaw),
    metrics: {
      ...fx.derived.metrics,
      byModel: new Map(fx.derived.metrics.byModel as unknown as [string, unknown][]),
    } as RenderContext["metrics"],
    block: fx.derived.block,
    burnRate: fx.derived.burnRate,
    pricing: {},
    sessionCostUsd: fx.derived.sessionCostUsd,
    todayCostUsd: fx.derived.todayCostUsd,
    costByModel: new Map(fx.derived.costByModel),
    sessionStartTime: fx.derived.sessionStartTime,
    terminalWidth: 200,
    alerts: { sessionWarn: 5, sessionDanger: 15, dailyWarn: 10, dailyDanger: 25 },
    turnCount: fx.derived.turnCount,
  };
}

beforeAll(() => {
  originalHome = process.env["HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-reality-"));
  process.env["HOME"] = tmpHome;
  const fx = midFixture as unknown as RealPayloadFixture;
  const cwd = (fx.stdin as { cwd: string }).cwd.split(fx.homePlaceholder).join(tmpHome);
  initScratchRepo(cwd);
  vi.useFakeTimers();
  vi.setSystemTime(fx.capturedAt);
});

afterAll(() => {
  vi.useRealTimers();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("widget matrix against a real payload", () => {
  const fx = midFixture as unknown as RealPayloadFixture;

  for (const [type, expected] of Object.entries(WIDGET_EXPECTATIONS)) {
    it(`${type} renders exactly as recorded${expected.knownWrong ? ` (known wrong: #${expected.knownWrong})` : ""}`, () => {
      const ctx = contextFromFixture(fx, tmpHome);
      const out = getWidget(type)!.render(ctx, { type } as never);
      if (expected.text === null) {
        expect(out, `${type}: ${expected.why}`).toBeNull();
      } else {
        expect(out, `${type} returned null but should render`).not.toBeNull();
        expect(out!.text, `${type}: ${expected.why}`).toBe(expected.text);
      }
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: FAIL. Some widgets will mismatch — `cwd` and the git widgets are the likely
first failures, and elapsed-time text may differ from the table.

- [ ] **Step 3: Reconcile the table to observed reality**

For every mismatch, decide which side is wrong:

- **Widget output is a fact** → update `WIDGET_EXPECTATIONS[type].text` to the observed
  string. This is the normal case; the table records reality.
- **Test harness is wrong** (scratch repo branch name, `HOME` substitution, frozen clock)
  → fix the harness, not the table.

Never change a widget's implementation in this task. Findings are filed, not fixed (#47).

- [ ] **Step 4: Run until green**

Run: `npx vitest run src/__tests__/widget-reality.test.ts`
Expected: PASS, 27 tests (2 guard + 25 matrix).

- [ ] **Step 5: Extend the matrix across the other two fixtures**

Some widgets vary by payload (`model`, `context-percent`, `compact-countdown`,
`cache-hit-rate`). Rather than a second full table, assert the *invariant* that holds for
every fixture: no widget throws, and any widget whose expectation is `null` for structural
reasons (`custom-text`, `custom-command`, `vim-mode`) stays `null`.

```ts
import fableFixture from "./fixtures/real-payloads/fable5-1m-low.json" with { type: "json" };
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

const STRUCTURAL_NULLS = ["custom-text", "custom-command", "vim-mode"];

describe.each([
  ["fable5-1m-low", fableFixture],
  ["opus5-1m-early", earlyFixture],
])("secondary fixture %s", (name, raw) => {
  const fx = raw as unknown as RealPayloadFixture;

  it("renders every widget without throwing", () => {
    const ctx = contextFromFixture(fx, tmpHome);
    for (const type of Object.keys(WIDGET_EXPECTATIONS)) {
      expect(
        () => getWidget(type)!.render(ctx, { type } as never),
        `${type} threw against ${name}`,
      ).not.toThrow();
    }
  });

  it("keeps structurally-null widgets null", () => {
    const ctx = contextFromFixture(fx, tmpHome);
    for (const type of STRUCTURAL_NULLS) {
      expect(getWidget(type)!.render(ctx, { type } as never), type).toBeNull();
    }
  });
});
```

Note the deliberate limit: the secondary fixtures assert non-throwing and structural
nulls, not exact text. That is weaker than the primary matrix, and it is a known bound —
`log` it in the PR body rather than implying full coverage across all three.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all files pass. Confirm the total test count rose by 31.

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/widget-reality.test.ts src/__tests__/fixtures/widget-expectations.ts
git commit -m "Render every registered widget against real payloads (#47)"
```

---

### Task 5: Pipeline integration case

Proves the context the matrix reconstructs is the one production actually builds. Without
this, the matrix could drift from the pipeline and stay green.

**Files:**
- Create: `src/__tests__/widget-reality-pipeline.test.ts`

**Interfaces:**
- Consumes: `opus5-1m-mid.json`, `DEFAULT_SETTINGS`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import { StatusJsonSchema } from "../types/status-json.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: async () => ({}),
}));

let tmpHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-realpipe-"));
  process.env["HOME"] = tmpHome;
  process.env["XDG_CACHE_HOME"] = path.join(tmpHome, "cache");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("real payload through the real pipeline", () => {
  it("produces a RenderContext with the same shape the matrix assumes", async () => {
    const fx = midFixture as unknown as RealPayloadFixture;
    const { buildRenderContext } = await import("../data/pipeline.js");
    const { DEFAULT_SETTINGS } = await import("../config/defaults.js");

    const stdin = v.parse(StatusJsonSchema, fx.stdin);
    const ctx = await buildRenderContext(stdin, DEFAULT_SETTINGS);

    // Every key the matrix reconstructs must exist on the real context.
    for (const key of [
      "stdin", "metrics", "block", "burnRate", "pricing", "sessionCostUsd",
      "todayCostUsd", "costByModel", "sessionStartTime", "terminalWidth",
      "alerts", "turnCount",
    ]) {
      expect(ctx, `pipeline context is missing ${key}`).toHaveProperty(key);
    }
    expect(ctx.metrics.session).toHaveProperty("inputTokens");
    expect(ctx.metrics.session).toHaveProperty("cacheReadTokens");
    expect(ctx.costByModel).toBeInstanceOf(Map);
    // No transcripts exist under the tmp HOME, so session metrics are zero here.
    // The assertion is about SHAPE; the recorded fixture supplies the values.
    expect(typeof ctx.sessionCostUsd).toBe("number");
  }, 30000);
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/__tests__/widget-reality-pipeline.test.ts`
Expected: PASS. If it fails on a missing key, the matrix's `contextFromFixture` is
reconstructing a context shape the pipeline no longer produces — fix
`contextFromFixture`, and treat the divergence as a finding worth filing.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/widget-reality-pipeline.test.ts
git commit -m "Prove the reality fixture flows through the real pipeline (#47)"
```

---

### Task 6: Verify and open the PR

**Files:** none created.

- [ ] **Step 1: Full verification**

```bash
npm test
npm run typecheck
npm run typecheck:scripts
npm run build
```

All four must pass. `npm run build` is run to confirm the tree still builds; because this
plan touches only `src/__tests__/`, `dist/index.js` should be **unchanged** — confirm with
`git status --short dist/`. If it changed, something outside `__tests__` was modified and
the bundle must be staged.

- [ ] **Step 2: Confirm the guard is wired into `npm test`**

```bash
npm test 2>&1 | grep widget-reality
```

Expected: both `widget-reality.test.ts` and `widget-reality-pipeline.test.ts` listed. A
test that is never collected is the exact trap `vitest.config.ts` already sprang once.

- [ ] **Step 3: Open the PR**

Body must include: the finding that no widget crashed and therefore a smoke test would
have found nothing; the six filed issues with numbers; the deliberate coverage bound on
the secondary fixtures; and that `#48` is blocked pending respecification.

```bash
gh pr create --title "Render every registered widget against a real payload (#47)" --body "<as above>"
```

---

## Self-Review

**Spec coverage:**

| Spec item | Task |
|---|---|
| Sanitized fixtures + `capture.md` | Task 2 |
| Expectation table with `why` and `knownWrong` | Task 3 |
| Matrix, exact text | Task 4 |
| Two-way completeness guard | Task 3 (proved in Step 5) |
| Pipeline case | Task 5 |
| Determinism: frozen clock | Task 4 Step 1 (`vi.setSystemTime`) |
| Determinism: scratch git repo | Task 4 Step 1 (`initScratchRepo`) |
| Findings filed, not fixed | Task 1; reinforced in Task 4 Step 3 |
| Success criterion 4 (build/typecheck) | Task 6 |

**Placeholder scan:** `A`–`F` in Task 3's table are explicit, gated placeholders — Task 1
Step 2 forbids starting Task 3 until they are real numbers. No other placeholders.

**Type consistency:** `RealPayloadFixture` (Task 2) is consumed unchanged by Tasks 4 and 5.
`WidgetExpectation` / `WIDGET_EXPECTATIONS` (Task 3) are consumed by Task 4.
`contextFromFixture` is defined once in Task 4 and used by both `describe` blocks there.
`initScratchRepo` is defined and used only in Task 4.

**Known gap, accepted:** `AggregatedMetrics.byModel` is assumed to be a `Map`. Task 2
Step 1 instructs confirming this while writing the generator and adjusting the
serialisation if not.
