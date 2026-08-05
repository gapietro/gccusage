# Turn Counter Derivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `turn-counter` display the session's real number of human prompts, derived from the transcript on every render, and delete the persistence machinery it no longer needs.

**Architecture:** `buildRenderContext` already parses the session transcript into `sessionEntries` (`src/data/pipeline.ts:43`). The turn count becomes a pure filter over that array — `type === "user" && originKind === "human"` — instead of a counter accumulated in a per-session cache file. Because it is recomputed rather than accumulated, it survives the statusline cache without drifting. `src/data/turn-tracker.ts` and `src/config/layout.ts` are deleted outright.

**Tech Stack:** TypeScript, vitest, valibot, tsdown.

**Spec:** `docs/superpowers/specs/2026-08-04-turn-counter-derivation-design.md`

## Global Constraints

- **Every commit touching `src/` must run `npm run build` and stage `dist/index.js`** with `git add -f dist/index.js` (it is gitignored but force-tracked). CI's `bundle-drift` job enforces byte-equality. A src-only commit leaves `git pull` upgraders on old code.
- **Never stage `AUDIT.md`.** It is deliberately untracked.
- Test files live under `src/__tests__/`; `vitest.config.ts:6` pins `include` to `src/**/__tests__/**/*.test.ts`, so a test outside that root never runs.
- Coverage gate is **per-file 70% statements** (`vitest.config.ts:18-21`), not a global average.
- Hermetic pipeline tests set **both** `HOME` (controls `getProjectsDir()`) and `XDG_CACHE_HOME` (controls `getCacheDir()`) to a tmpdir, and mock only `../data/pricing-fetcher.js`.
- Per the repo's vacuous-tests discipline: **every new test must be verified by breaking what it guards.** A test that passes against the unfixed code is a plan failure, not a pass.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/data/jsonl-reader.ts` | Transcript parsing / normalisation | Carry `origin.kind` through as `originKind` |
| `src/data/token-aggregator.ts` | Scalars derived from `sessionEntries` | Add `countHumanTurns` beside `getFirstTimestamp` |
| `src/data/pipeline.ts` | Assemble `RenderContext` | Replace gated `trackTurn` with `countHumanTurns` |
| `src/data/turn-tracker.ts` | *(persistence — obsolete)* | **Delete** |
| `src/config/layout.ts` | *(gate helper — sole caller removed)* | **Delete** |
| `src/data/daily-cost-tracker.ts` | Daily spend store | Bound `ShardSchema` numerics against `Infinity` |
| `src/cli.ts` | CLI commands | `setup` removes the orphaned turn store |

---

### Task 1: Carry `origin.kind` through the parser

**Files:**
- Modify: `src/data/jsonl-reader.ts:3-21` (interface), `src/data/jsonl-reader.ts:103-155` (`normalizeEntry`)
- Test: `src/__tests__/jsonl-reader.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `JsonlEntry.originKind?: string` — the value of the transcript line's `origin.kind`, absent when the line has no `origin` object or its `kind` is not a string. Task 2 reads this.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/jsonl-reader.test.ts`:

```ts
describe("origin.kind extraction", () => {
  it("carries origin.kind through for a human prompt", () => {
    const line = JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      promptSource: "typed",
      message: { role: "user", content: "hello" },
      timestamp: "2026-08-04T10:00:00.000Z",
    });
    const [entry] = parseJsonlContent(line);
    expect(entry?.originKind).toBe("human");
  });

  it("carries origin.kind through for a task notification", () => {
    const line = JSON.stringify({
      type: "user",
      origin: { kind: "task-notification" },
      promptSource: "system",
      message: { role: "user", content: "<task-notification>done</task-notification>" },
    });
    const [entry] = parseJsonlContent(line);
    expect(entry?.originKind).toBe("task-notification");
  });

  it("leaves originKind undefined when the line has no origin", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    });
    const [entry] = parseJsonlContent(line);
    expect(entry?.originKind).toBeUndefined();
  });

  it("leaves originKind undefined when origin.kind is not a string", () => {
    const line = JSON.stringify({ type: "user", origin: { kind: 42 } });
    const [entry] = parseJsonlContent(line);
    expect(entry?.originKind).toBeUndefined();
  });

  it("leaves originKind undefined when origin is null", () => {
    const line = JSON.stringify({ type: "user", origin: null });
    const [entry] = parseJsonlContent(line);
    expect(entry?.originKind).toBeUndefined();
  });
});
```

If `parseJsonlContent` is not already imported at the top of that file, add it to the existing import from `../data/jsonl-reader.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts -t "origin.kind"`
Expected: FAIL — the first two assertions get `undefined` instead of `"human"` / `"task-notification"`.

Note the last three tests pass already. That is expected: they pin the *absence* behaviour that must survive Step 3, and are not the ones proving the feature.

- [ ] **Step 3: Add the field to the interface**

In `src/data/jsonl-reader.ts`, add to `interface JsonlEntry` after `type?: string;`:

```ts
  /**
   * `origin.kind` from the transcript line — "human" for a prompt the user
   * actually typed, "task-notification" / "coordinator" / absent for the
   * harness-injected `type: "user"` lines that outnumber real prompts roughly
   * 5:1. This is the only field that separates them; content-shape sniffing
   * does not, because tool results and injections are both `type: "user"`.
   */
  originKind?: string;
```

- [ ] **Step 4: Extract it in `normalizeEntry`**

In `src/data/jsonl-reader.ts`, inside `normalizeEntry`, directly after the
`if (typeof raw["sessionId"] === "string") entry.sessionId = raw["sessionId"];`
line:

```ts
  // Same unwrapping shape as `message` below: a JSON `null` is typeof
  // "object", so it must be excluded explicitly or reading `.kind` throws.
  const origin =
    typeof raw["origin"] === "object" && raw["origin"] !== null
      ? (raw["origin"] as Record<string, unknown>)
      : undefined;
  const originKind = origin?.["kind"];
  if (typeof originKind === "string") entry.originKind = originKind;
```

Bind the value to a local before the `typeof` check rather than testing
`origin?.["kind"]` and then reading `origin["kind"]` again — the second read is
a fresh expression that TypeScript may not have narrowed, and it re-reads a
possibly-undefined object.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/jsonl-reader.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Verify the test is not vacuous**

Temporarily change the extraction to `entry.originKind = "human";` (unconditional). Run the file again. Expected: the "task notification", "no origin", "not a string" and "null" tests all go RED. Revert.

This proves the tests discriminate rather than merely asserting a field exists.

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/data/jsonl-reader.ts src/__tests__/jsonl-reader.test.ts
git add -f dist/index.js
git commit -m "Carry origin.kind through the transcript parser (#129)"
```

---

### Task 2: `countHumanTurns`

**Files:**
- Modify: `src/data/token-aggregator.ts` (append after `getFirstTimestamp`, line 82)
- Test: `src/__tests__/token-aggregator.test.ts`

**Interfaces:**
- Consumes: `JsonlEntry.originKind` from Task 1.
- Produces: `countHumanTurns(entries: JsonlEntry[]): number` — Task 3 calls this from `pipeline.ts`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/token-aggregator.test.ts`:

```ts
describe("countHumanTurns", () => {
  // Shapes taken from real transcripts (three sessions sampled for the design
  // spec). Every one of these is `type: "user"` — which is why counting
  // `type === "user"` over-counts by ~5x and origin.kind is the real signal.
  //
  // There is deliberately no case for `promptSource`. Its human variants
  // (typed / suggestion_accepted / queued) all carry origin.kind "human", and
  // the field is not on JsonlEntry at all — a test distinguishing them would
  // compare two identical fixtures and could not be broken by any mutation to
  // the rule it claims to guard.
  const HUMAN = { type: "user", originKind: "human" };
  const NOTIFICATION = { type: "user", originKind: "task-notification" };
  const COORDINATOR = { type: "user", originKind: "coordinator" }; // subagent sidechain
  const TOOL_RESULT = { type: "user" }; // content is a tool_result array; no origin
  const META = { type: "user" }; // isMeta text; no origin
  const ASSISTANT = { type: "assistant", originKind: undefined };

  it("counts only entries whose origin is human", () => {
    expect(countHumanTurns([HUMAN, NOTIFICATION, TOOL_RESULT, HUMAN])).toBe(2);
  });

  it("excludes task notifications", () => {
    expect(countHumanTurns([NOTIFICATION, NOTIFICATION, NOTIFICATION])).toBe(0);
  });

  it("excludes tool results and meta entries, which carry no origin", () => {
    expect(countHumanTurns([TOOL_RESULT, META, TOOL_RESULT])).toBe(0);
  });

  it("excludes subagent sidechain prompts", () => {
    expect(countHumanTurns([COORDINATOR, HUMAN])).toBe(1);
  });

  it("excludes assistant entries even though they dominate the transcript", () => {
    expect(countHumanTurns([ASSISTANT, ASSISTANT, ASSISTANT, HUMAN])).toBe(1);
  });

  it("returns 0 for a transcript predating the origin field", () => {
    // The accepted degradation: turn-counter.ts's `!count || count < 1` guard
    // then renders nothing, which beats rendering a wrong number.
    expect(countHumanTurns([{ type: "user" }, { type: "assistant" }])).toBe(0);
  });

  it("returns 0 for an empty transcript", () => {
    expect(countHumanTurns([])).toBe(0);
  });
});
```

Add `countHumanTurns` to the existing import from `../data/token-aggregator.js` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/token-aggregator.test.ts -t "countHumanTurns"`
Expected: FAIL — `countHumanTurns is not a function`.

- [ ] **Step 3: Implement**

Append to `src/data/token-aggregator.ts`:

```ts
/**
 * The number of prompts the user actually typed.
 *
 * `type: "user"` alone is not a turn: tool results and harness injections
 * (`<task-notification>`) are written as user entries too, and outnumber real
 * prompts roughly 5:1 — 756 tool results and 124 notifications against 28
 * prompts, on the 3,564-line session sampled for #129. `origin.kind` is the
 * field that separates them, and it also excludes subagent sidechains, whose
 * prompts come from a `coordinator` rather than a human.
 *
 * Recomputed per render rather than accumulated. That is the fix for #129: a
 * counter persisted across renders incremented once per statusline-cache miss,
 * which is neither a turn nor a render.
 */
export function countHumanTurns(entries: JsonlEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === "user" && entry.originKind === "human") count++;
  }
  return count;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/token-aggregator.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the test is not vacuous**

Make each of these three mutations in turn, run the file, confirm RED, then revert:

1. Drop the `entry.type === "user"` clause → the assistant test goes red.
2. Change `=== "human"` to `!== undefined` → the notification and coordinator tests go red.
3. Change `=== "human"` to `entry.type === "user"` → the notification, tool-result and coordinator tests go red.

If any mutation leaves the suite green, the corresponding test is vacuous and must be strengthened before proceeding.

- [ ] **Step 6: Build and commit**

```bash
npm run build
git add src/data/token-aggregator.ts src/__tests__/token-aggregator.test.ts
git add -f dist/index.js
git commit -m "Add countHumanTurns, deriving turns from the transcript (#129)"
```

---

### Task 3: Wire the pipeline, delete the tracker, and close the Infinity holes

**Files:**
- Modify: `src/data/pipeline.ts:18-19` (imports), `src/data/pipeline.ts:140-146` (the gate)
- Delete: `src/data/turn-tracker.ts`, `src/config/layout.ts`, `src/__tests__/turn-tracker.test.ts`, `src/__tests__/layout-gate.test.ts`
- Modify: `src/data/daily-cost-tracker.ts:26-34` (`ShardSchema`), `:43-49` (`LegacyEntrySchema`)
- Modify: `src/__tests__/cache-validation.test.ts:448-578`
- Test: `src/__tests__/turn-count-render.test.ts` (create)

**Interfaces:**
- Consumes: `countHumanTurns` from Task 2.
- Produces: `RenderContext.turnCount` is now the human-prompt count. Its type is unchanged (`number`, `src/types/render-context.ts:49`), so no consumer signature changes.

**Why these are one task.** Deleting `turn-tracker.ts` is what removes the
repo's only two uses of `v.safeInteger()`, and it breaks the two
`cache-validation.test.ts` tests that used the turn store as their sabotage
vehicle. Splitting the deletion from the repair would commit a knowingly-red
suite. The two halves are causally linked, so they land together and the suite
is green at every commit.

This task ends in **two commits** — the derivation, then the schema fix — both
made only after the full suite passes.

- [ ] **Step 1: Write the failing regression test**

Create `src/__tests__/turn-count-render.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRenderContext } from "../data/pipeline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { StatusJson } from "../types/status-json.js";

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({})),
  getPricingForRender: vi.fn(() => ({ pricing: {}, stale: false })),
}));

const SESSION_ID = "turn-count-session";

const STDIN: StatusJson = {
  session_id: SESSION_ID,
  model: { id: "claude-opus-4-5", display_name: "Opus" },
  cost: { total_cost_usd: 1.5 },
};

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

/**
 * A transcript in the real shape: three human prompts buried in the tool
 * results, task notifications, meta lines and assistant responses that make up
 * the other ~95% of a session's lines.
 */
function writeTranscript(): void {
  const projectDir = path.join(tmpDir, ".claude", "projects", "proj");
  fs.mkdirSync(projectDir, { recursive: true });

  const stamp = (n: number) => `2026-08-04T10:${String(n).padStart(2, "0")}:00.000Z`;
  const lines = [
    { type: "user", origin: { kind: "human" }, promptSource: "typed",
      message: { role: "user", content: "first" }, timestamp: stamp(1), sessionId: SESSION_ID },
    { type: "assistant", message: { id: "msg_1", model: "claude-opus-4-5",
      usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: stamp(2), sessionId: SESSION_ID },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      timestamp: stamp(3), sessionId: SESSION_ID },
    { type: "assistant", message: { id: "msg_2", model: "claude-opus-4-5",
      usage: { input_tokens: 20, output_tokens: 5 } }, timestamp: stamp(4), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "task-notification" }, promptSource: "system",
      message: { role: "user", content: "<task-notification>done</task-notification>" },
      timestamp: stamp(5), sessionId: SESSION_ID },
    { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat/>" },
      timestamp: stamp(6), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "human" }, promptSource: "typed",
      message: { role: "user", content: "second" }, timestamp: stamp(7), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "coordinator" }, isSidechain: true,
      message: { role: "user", content: "subagent task" }, timestamp: stamp(8), sessionId: SESSION_ID },
    { type: "user", origin: { kind: "human" }, promptSource: "suggestion_accepted",
      message: { role: "user", content: "third" }, timestamp: stamp(9), sessionId: SESSION_ID },
  ];

  fs.writeFileSync(
    path.join(projectDir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-turncount-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
  writeTranscript();
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("turnCount is derived, not accumulated (#129)", () => {
  it("counts the three human prompts, not the nine lines", async () => {
    const context = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(context.turnCount).toBe(3);
  });

  // The #129 regression itself. The old trackTurn incremented a persisted
  // counter once per buildRenderContext call, so this returned 1 then 2 then 3
  // for a transcript that never changed.
  it("does not change across repeated renders of the same transcript", async () => {
    const first = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    const second = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    const third = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect([first.turnCount, second.turnCount, third.turnCount]).toEqual([3, 3, 3]);
  });

  // The gate at pipeline.ts:144 is gone: counting an in-memory array is free,
  // so there is nothing left to charge only to turn-counter users.
  it("counts under the default layout, which has no turn-counter", async () => {
    const context = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(context.turnCount).toBe(3);
  });

  it("writes no turn store to disk", async () => {
    await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(fs.existsSync(path.join(tmpDir, "gccusage", "turns"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "gccusage", "turn-count.json"))).toBe(false);
  });

  it("reports 0 when the session has no transcript at all", async () => {
    const context = await buildRenderContext(
      { ...STDIN, session_id: "no-such-session" },
      DEFAULT_SETTINGS,
    );
    expect(context.turnCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/turn-count-render.test.ts`
Expected: FAIL. Against current code, `turnCount` is `0` under `DEFAULT_SETTINGS` (the layout gate suppresses it), so the first, second, third and fifth tests fail with `0` where `3` is expected.

**This is the mutation check for #129, and it must be recorded.** Before proceeding, confirm the *accumulation* half also fails: temporarily change `pipeline.ts:144-146` to the ungated `turnCount: trackTurn(stdin.session_id),`. Re-run. Expected: "does not change across repeated renders" now fails with `[1, 2, 3]`. That is the exact defect #129 describes, reproduced. Revert the temporary change.

- [ ] **Step 3: Rewire the pipeline**

In `src/data/pipeline.ts`:

Remove these two import lines (18 and 19):

```ts
import { trackTurn } from "./turn-tracker.js";
import { layoutIncludesWidget } from "../config/layout.js";
```

Add `countHumanTurns` to the existing `token-aggregator.js` import on line 6:

```ts
import { aggregateTokens, getFirstTimestamp, countHumanTurns } from "./token-aggregator.js";
```

Replace lines 140-146 (the comment block and the gated call) with:

```ts
    // Derived from the transcript on every render rather than accumulated in a
    // cache file. The old counter incremented once per statusline-cache miss,
    // which is neither a turn nor a render (#129); recomputing makes the number
    // survive a cache hit, and costs nothing — `sessionEntries` is already in
    // memory for `aggregateTokens` above.
    turnCount: countHumanTurns(sessionEntries),
```

- [ ] **Step 4: Delete the obsolete modules and their tests**

```bash
git rm src/data/turn-tracker.ts src/config/layout.ts
git rm src/__tests__/turn-tracker.test.ts src/__tests__/layout-gate.test.ts
```

`layout-gate.test.ts` goes in full: its `layoutIncludesWidget` describe block tests a function that no longer exists, and its "turn tracking gate" block tests a gate that no longer exists. `turn-count-render.test.ts` from Step 1 covers what remains meaningful (that no store is written).

- [ ] **Step 5: Run the new test to verify it passes**

Run: `npx vitest run src/__tests__/turn-count-render.test.ts`
Expected: PASS, all five tests.

- [ ] **Step 6: Run the whole suite to see the expected fallout**

Run: `npx vitest run`
Expected: FAIL in `src/__tests__/cache-validation.test.ts` — two tests reference the deleted turn store. Steps 7-15 repair them. **Do not commit yet.**

Any *other* failure is unexpected and must be understood before continuing — particularly anything importing `../config/layout.js`. Confirm with:

```bash
grep -rn "turn-tracker\|config/layout" src/ scripts/
```

Expected: no matches outside `cache-validation.test.ts`.

**Background for Steps 7-13.** Deleting `turn-tracker.ts` removed the repo's only two uses of `v.safeInteger()`. The same shape exists unguarded in `daily-cost-tracker.ts`, in a store that — unlike the turn store — is in the default layout. Two distinct defects:

1. `updatedAt: v.fallback(v.number(), 0)` (line 33). `JSON.parse("1e400")` is `Infinity`, `v.number()` accepts it, and the prune at line 173 computes `now.getTime() - Infinity === -Infinity`, which is never `>= STALE_SESSION_MS`. The shard is unpruneable forever.
2. `costUsd: v.number()` (line 29). An `Infinity` here reaches `formatDollars`, which is `amount.toFixed(0)` with no finite check — so the bar renders the literal text **`$Infinity`**.

- [ ] **Step 7: File the spun-off issue**

```bash
gh issue create \
  --title "daily-cost-tracker's ShardSchema accepts Infinity: unpruneable shards and a \$Infinity bar" \
  --label bug \
  --body "$(cat <<'EOF'
Found while designing #129. Deleting `src/data/turn-tracker.ts` removes the
repo's only two uses of `v.safeInteger()`; the same shape is unguarded in the
daily cost store, which unlike the turn store IS in the default layout.

`JSON.parse("1e400")` is `Infinity`, and a bare `v.number()` accepts it.

## Defect 1 — unpruneable shards

```
src/data/daily-cost-tracker.ts:33    updatedAt: v.fallback(v.number(), 0),
src/data/daily-cost-tracker.ts:173   if (now.getTime() - entry.updatedAt >= STALE_SESSION_MS) {
```

`now - Infinity` is `-Infinity`, never `>= STALE_SESSION_MS`. The shard is never
pruned, for the life of the cache directory.

This is the exact failure mode `turn-tracker.ts:15-18` documented and guarded
against. The hardening was never carried across.

## Defect 2 — `$Infinity` on the bar

```
src/data/daily-cost-tracker.ts:29    costUsd: v.number(),
src/utils/format.ts:5                return `$${amount.toFixed(0)}`;
```

`formatDollars` has no finite check, so `Infinity.toFixed(0)` is `"Infinity"`
and `today-spend` renders `$Infinity`.

The existing hostile-cache test asserts `not.toContain("Infinity")` but only
ever sabotages `costUsd` with `"not-a-number"`, so it never fires on this.

## Fix

Constrain the numeric fields in `ShardSchema` and `LegacyEntrySchema` the way
`TurnDataSchema` constrained its own. `updatedAt` keeps its fallback to 0, so a
rejected value reads as infinitely stale and is pruned.

## Acceptance criteria

A shard with `"updatedAt": 1e400` is pruned, and one with `"costUsd": 1e400`
does not put `Infinity` on the bar — each with a test that fails without the fix.
EOF
)"
```

Record the issue number it prints; call it `NNN` below.

- [ ] **Step 8: Write the failing tests**

In `src/__tests__/cache-validation.test.ts`, replace the entire
`it("rejects an Infinity turn count instead of rendering it", ...)` block
(lines 542-577) with:

```ts
  it("prunes a daily shard whose updatedAt is Infinity instead of keeping it forever", async () => {
    // `JSON.parse("1e400")` is `Infinity` and a bare `v.number()` accepts it.
    // The prune at daily-cost-tracker.ts:173 computes `now - Infinity`, which
    // is `-Infinity` and never `>= STALE_SESSION_MS` — so an unguarded schema
    // makes this shard immortal. The fallback to 0 is what makes a rejected
    // value read as infinitely stale, and therefore prunable.
    fs.mkdirSync(path.join(tmpDir, "gccusage", "daily"), { recursive: true });
    const immortal = path.join(tmpDir, "gccusage", "daily", "immortal.json");
    fs.writeFileSync(
      immortal,
      '{"sessionId":"immortal","date":"2020-01-01","costUsd":1,"baselineUsd":0,"updatedAt":1e400}',
    );

    // Any render that reads the store triggers the prune sweep.
    await runStatusline(
      {
        session_id: "sweeper",
        model: { id: "claude-opus-4-5", display_name: "Opus" },
        cost: { total_cost_usd: 1.5 },
      },
      DEFAULT_SETTINGS,
    );

    expect(fs.existsSync(immortal)).toBe(false);
  });

  it("rejects an Infinity daily cost instead of rendering $Infinity", async () => {
    // formatDollars is `amount.toFixed(0)` with no finite check, so an
    // Infinity that survives the schema reaches the bar as the literal text
    // "$Infinity". `date` must be today and `updatedAt` fresh, or the shard is
    // filtered out before its costUsd is ever read and this asserts nothing.
    fs.mkdirSync(path.join(tmpDir, "gccusage", "daily"), { recursive: true });
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fs.writeFileSync(
      path.join(tmpDir, "gccusage", "daily", "infinite-cost.json"),
      `{"sessionId":"infinite-cost","date":"${today}","costUsd":1e400,"baselineUsd":0,"updatedAt":${now.getTime()}}`,
    );

    const output = await runStatusline(
      {
        session_id: "reader",
        model: { id: "claude-opus-4-5", display_name: "Opus" },
        cost: { total_cost_usd: 1.5 },
      },
      DEFAULT_SETTINGS,
    );

    expect(output).not.toContain("Infinity");
    expect(output).toContain("$1.50");
  });
```

- [ ] **Step 9: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/cache-validation.test.ts -t "Infinity"`
Expected: BOTH FAIL.

- "prunes a daily shard…" fails because `immortal.json` still exists.
- "rejects an Infinity daily cost…" fails because the output contains `$Infinity`.

**If either passes here, stop.** The defect is not what the design predicted and the spec needs revisiting before the fix goes in.

- [ ] **Step 10: Fix the schemas**

In `src/data/daily-cost-tracker.ts`, replace `ShardSchema` (lines 26-34) with:

```ts
const ShardSchema = v.object({
  sessionId: v.string(),
  date: v.string(), // local date the baseline belongs to
  // `v.finite()`, not bare `v.number()`: `JSON.parse("1e400")` is `Infinity`
  // and `v.number()` accepts it. An infinite cost reaches `formatDollars` —
  // `amount.toFixed(0)` with no finite check — as the literal text
  // "$Infinity" (#NNN).
  costUsd: v.pipe(v.number(), v.finite()), // latest cumulative session cost
  baselineUsd: v.fallback(v.pipe(v.number(), v.finite()), 0), // cumulative cost at the start of `date`
  // Absent in legacy files, and an unrecognised value is treated the same way.
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  // A second, independent failure from the same parse: `now - Infinity` is
  // `-Infinity`, which is always less than STALE_SESSION_MS, making the shard
  // unpruneable forever. The fallback to 0 makes a rejected value read as
  // infinitely stale instead, so it is pruned on the next sweep (#NNN).
  updatedAt: v.fallback(v.pipe(v.number(), v.finite()), 0),
});
```

Replace `LegacyEntrySchema` (lines 43-49) with:

```ts
const LegacyEntrySchema = v.object({
  sessionId: v.string(),
  costUsd: v.pipe(v.number(), v.finite()),
  baselineUsd: v.fallback(v.pipe(v.number(), v.finite()), 0),
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.optional(v.pipe(v.number(), v.finite())), undefined),
});
```

Replace `#NNN` with the real issue number from Step 1.

`v.finite()` rather than `v.safeInteger()`: these are dollar amounts and
millisecond timestamps, so they are legitimately non-integer. `v.finite()`
rejects `Infinity`, `-Infinity` and `NaN`, which is the whole hazard.

- [ ] **Step 11: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/cache-validation.test.ts`
Expected: the two Infinity tests PASS. The `#92` hostile-directory test at line
449 still FAILS — Step 12 fixes it.

- [ ] **Step 12: Drop the turn-store leg from the `#92` hostile test**

In the same file, in `it("renders a correct bar with the turn counter, statusline cache, and daily shard all corrupted", ...)`:

Rename it — the turn counter is no longer part of it:

```ts
  it("renders a correct bar with the statusline cache and daily shard both corrupted", async () => {
```

Delete the two `fs` calls that write the turn shard:

```ts
    fs.mkdirSync(path.join(tmpDir, "gccusage", "turns"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "gccusage", "turns", "hostile.json"), "null");
```

Delete the `HOSTILE_SETTINGS` object — the `const HOSTILE_SETTINGS = { ...DEFAULT_SETTINGS, lines: [...DEFAULT_SETTINGS.lines, { widgets: [{ type: "turn-counter" }], flex: "left" as const }] };` block, along with the two-line comment above it explaining why the layout needed a turn-counter — and change the call to use `DEFAULT_SETTINGS`:

```ts
    const output = await runStatusline(stdin, DEFAULT_SETTINGS);
```

Replace the long comment block at lines 456-473 (which explains `trackTurn`'s
null-guard) with:

```ts
    // This used to sabotage a third store, the turn shard, to pin trackTurn's
    // null-guard. That store was deleted in #129 — the turn count is derived
    // from the transcript now and persists nothing. The bare-null-document
    // case it covered is pinned directly by the block-cache and pricing-cache
    // describes above, which assert `readJsonValidated` maps "null" to null.
```

- [ ] **Step 13: Run the whole suite**

Run: `npx vitest run`
Expected: PASS, everything.

- [ ] **Step 14: Verify the schema fix is not vacuous**

Revert `updatedAt` to `v.fallback(v.number(), 0)`, run the file, confirm the prune test goes RED. Restore.
Revert `costUsd` to `v.number()`, run the file, confirm the `$Infinity` test goes RED. Restore.

- [ ] **Step 15: Build and commit — two commits, in this order**

The whole suite is green before either commit is made. Splitting them keeps the
derivation and the schema fix independently revertable and separately
reviewable, without ever leaving a red commit on the branch.

First the derivation:

```bash
npm run build
git add src/data/pipeline.ts src/__tests__/turn-count-render.test.ts
git add -f dist/index.js
git commit -m "Derive turnCount from the transcript, delete the turn store (#129)"
```

Note the deletions from Step 4 were already staged by `git rm`, so they ride
along with this first commit — that is correct, they are part of the same
change.

Then the schema fix:

```bash
npm run build
git add src/data/daily-cost-tracker.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "Reject Infinity in the daily cost store (#NNN)

Found while deleting turn-tracker.ts for #129, which removed the repo's only
two uses of v.safeInteger(). The same shape was unguarded in the daily store,
which unlike the turn store is in the default layout: an Infinity updatedAt
made a shard unpruneable forever, and an Infinity costUsd rendered as the
literal text \$Infinity."
```

Verify both landed and the tree is clean:

```bash
git log --oneline -2 && git status --porcelain
```

Expected: the two commits above, and no output from `git status` other than
`?? AUDIT.md`.

---

### Task 4: Remove the orphaned turn store in `gccusage setup`

**Files:**
- Modify: `src/cli.ts` (imports, and `runSetup` at line 177)
- Test: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**Background.** `trackTurn` owned both the 48-hour prune and the legacy-file unlink, so deleting it strands whatever is already on disk: `~/.cache/gccusage/turn-count.json` (~62 B, present for every existing user, since the pre-#128 call was unconditional) and `~/.cache/gccusage/turns/` (only for users who configured the widget). Cleanup goes in `setup` because it is off the render path — putting an unlink back into every render is the per-render I/O that #99 removed.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cli.test.ts`, inside the describe block that already exercises `runCli(["setup"])` (match the existing tmpdir/env setup in that file rather than introducing a second pattern):

```ts
  it("removes the orphaned turn store left by the pre-#129 tracker", async () => {
    const cacheDir = path.join(tmpDir, "gccusage");
    fs.mkdirSync(path.join(cacheDir, "turns"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "turns", "abc.json"),
      '{"sessionId":"abc","count":7,"updatedAt":0}',
    );
    fs.writeFileSync(
      path.join(cacheDir, "turn-count.json"),
      '{"sessionId":"abc","count":7,"updatedAt":0}',
    );

    await runCli(["setup"]);

    expect(fs.existsSync(path.join(cacheDir, "turns"))).toBe(false);
    expect(fs.existsSync(path.join(cacheDir, "turn-count.json"))).toBe(false);
  });

  it("does not fail when there is no turn store to remove", async () => {
    // The common case for anyone who never configured turn-counter, and for
    // every user after the first cleanup. Must not throw.
    await expect(runCli(["setup"])).resolves.toBeUndefined();
  });
```

This test requires `XDG_CACHE_HOME` to point at `tmpDir` so `getCacheDir()`
resolves there. If the existing setup block in `cli.test.ts` sets only `HOME`,
add `process.env["XDG_CACHE_HOME"] = tmpDir;` to its `beforeEach` and restore it
in `afterEach`, following the pattern in `src/__tests__/turn-count-render.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/cli.test.ts -t "turn store"`
Expected: FAIL — `turns/` and `turn-count.json` both still exist after setup.

- [ ] **Step 3: Implement the cleanup**

In `src/cli.ts`, extend the `node:fs` import on line 5 to include `rmSync`:

```ts
import { readFileSync, existsSync, rmSync } from "node:fs";
```

Add an import for the cache directory helper alongside the others:

```ts
import { getCacheDir } from "./utils/paths.js";
```

Add this function immediately above `runSetup`:

```ts
/**
 * Remove the turn store the pre-#129 tracker left behind.
 *
 * `trackTurn` owned both the 48h prune and the legacy-file unlink, so deleting
 * it stranded whatever was on disk. This runs in `setup` rather than on the
 * render path: an unconditional unlink per render is exactly the I/O #99
 * removed, and the leftovers are ~110 bytes of inert JSON.
 *
 * Best effort. A cache directory we cannot clean is not a reason to fail the
 * command that configures the statusline.
 */
function removeLegacyTurnStore(): void {
  const cacheDir = getCacheDir();
  for (const target of [resolve(cacheDir, "turns"), resolve(cacheDir, "turn-count.json")]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort — see above.
    }
  }
}
```

Call it from `runSetup`, immediately after the `writeFileAtomic(settingsPath, ...)` line (196), so a failed settings write still aborts before touching anything else:

```ts
  removeLegacyTurnStore();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Verify the test is not vacuous**

Comment out the `removeLegacyTurnStore();` call. Run the file. Expected: the
"removes the orphaned turn store" test goes RED. Restore.

- [ ] **Step 6: Build and commit**

```bash
npm run build
git add src/cli.ts src/__tests__/cli.test.ts
git add -f dist/index.js
git commit -m "Remove the orphaned turn store in gccusage setup (#129)"
```

---

### Task 5: Documentation, fixtures, and the full gate

**Files:**
- Modify: `src/__tests__/fixtures/widget-expectations.ts:102-105`
- Modify: `README.md:311`
- Test: the full suite plus coverage

**Interfaces:**
- Consumes: everything above.
- Produces: the merge-ready branch.

- [ ] **Step 1: Correct the widget fixture rationale**

`widget-expectations.ts:104`'s `why` explains sharded-tracker reasoning for a
tracker that no longer exists. Replace the `"turn-counter"` entry with:

```ts
  "turn-counter": {
    text: "#9",
    why: "controlled.turnCount fixture input (9). Derived per render from the transcript's origin.kind === 'human' entries (#129), so it is a property of the captured session rather than of generation order — the pre-#129 tracker started every fresh shard at 1, so a recorded value encoded only when the fixture was generated",
  },
```

The `text` is unchanged: `context-from-fixture.ts:52` feeds `controlled.turnCount`
into the context directly, so this widget's fixture is unaffected by where the
number comes from in production.

- [ ] **Step 2: Correct the README**

`README.md:311` currently reads:

```
| `turn-counter` | Conversation turn count (`#9`) |
```

Replace with:

```
| `turn-counter` | Number of prompts you've sent this session (`#9`) — derived from the transcript, so it doesn't drift with render count |
```

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS, no skips.

- [ ] **Step 4: Run coverage and check the per-file floor**

Run: `npx vitest run --coverage`
Expected: PASS. No file below 70% statements.

Watch `src/data/token-aggregator.ts` and `src/data/jsonl-reader.ts` specifically —
both grew. If either dips below the floor, the gap is a missing test, not a
threshold to lower.

`src/config/layout.ts` and `src/data/turn-tracker.ts` should be absent from the
report entirely. If either still appears, a delete was missed.

- [ ] **Step 5: Verify the bundle is in sync**

Run:

```bash
npm run build && git status --porcelain dist/index.js
```

Expected: **no output.** Any output means a previous task committed source
without its rebuilt bundle, and CI's `bundle-drift` job will fail. Fix by
staging `dist/index.js` now.

- [ ] **Step 6: Confirm nothing references the deleted modules**

```bash
grep -rn "trackTurn\|turn-tracker\|layoutIncludesWidget\|config/layout" src/ scripts/ README.md
```

Expected: no matches.

- [ ] **Step 7: Commit**

```bash
npm run build
git add src/__tests__/fixtures/widget-expectations.ts README.md
git add -f dist/index.js
git commit -m "Document what turn-counter actually counts (#129)"
```

- [ ] **Step 8: Open the PR**

```bash
gh pr create --title "Derive the turn count from the transcript (#129)" --body "$(cat <<'EOF'
Closes #129. Also closes #NNN, filed during this work.

`turn-counter` rendered `context.turnCount` with a `#` label, implying a turn
number. It never was one: `runStatusline` returns from the statusline cache
before `buildRenderContext` runs, so the persisted counter incremented once per
cache miss — neither a turn nor a render.

## What a turn is

Measured three real transcripts before picking a rule, because the obvious
reading over-counts by ~5x — `<task-notification>` injections and tool results
are both `type: "user"`:

| `origin.kind` | kraken-bot (3564 lines) | gccusage A | gccusage B |
|---|---|---|---|
| `human` | **28** | **18** | **23** |
| `task-notification` | 124 | 27 | 25 |
| absent (tool_result / meta) | 784 | 293 | 314 |

`origin.kind === "human"` separates them exactly, and excludes subagent
sidechains for free — their prompts come from a `coordinator`.

## Consequences

The count is now derived from `sessionEntries`, which `buildRenderContext`
already parses, so it adds no I/O and survives a cache hit. That makes the
persistence obsolete: `src/data/turn-tracker.ts` (142 lines) is deleted, and
with it the layout gate that existed only to avoid its I/O — which leaves
`src/config/layout.ts` (16 lines) with no callers. Net ~-350 lines, and the
render path loses a read, a write and a conditional `readdir`.

`gccusage setup` cleans up the store left on disk.

## Spun-off fix

Deleting `turn-tracker.ts` removed the repo's only two uses of
`v.safeInteger()`. The same shape was unguarded in `daily-cost-tracker.ts` —
which, unlike the turn store, is in the default layout. An `Infinity`
`updatedAt` made a shard unpruneable forever; an `Infinity` `costUsd` rendered
as the literal text `$Infinity`, because `formatDollars` is `toFixed(0)` with
no finite check. Both now fail a test without the fix.

## Known gap

The zero-fallback for transcripts predating the `origin` field is inferred from
`turn-counter.ts`'s `!count || count < 1` guard, not observed — no transcript on
the development machine predates 2026-04-01.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace `#NNN` with the issue number from Task 3 Step 7.

---

## Post-merge

Per the repo's standing CI situation: GitHub Actions has been billing-blocked
for six consecutive merges, with every job aborting in 3-12s having executed
zero steps. Verify by hand on a clean clone and again on merged `main` if that
is still the case. Node 22/24 remain unverified across #114-#128; this machine
has only Node 25/26 and no version manager, so only real CI retires that debt.
