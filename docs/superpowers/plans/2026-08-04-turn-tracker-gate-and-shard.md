# Turn Tracker Gate and Shard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `trackTurn` doing filesystem I/O for a widget the layout does not contain, and make the turn count survive concurrent sessions.

**Architecture:** Three independent changes. A shared `shardKey()` moves to `src/utils/paths.ts` so untrusted session ids reach a path through one implementation. `src/data/turn-tracker.ts` moves from a single global `turn-count.json` to per-session shards under `turns/`, pruning stale shards only on a session's first render. `src/data/pipeline.ts` calls `trackTurn` only when the resolved layout contains a `turn-counter` widget.

**Tech Stack:** TypeScript, vitest, valibot, tsdown.

**Spec:** `docs/superpowers/specs/2026-08-04-turn-tracker-gate-and-shard-design.md`
**Issue:** [#99](https://github.com/gapietro/gccusage/issues/99) (audit CLEAN-002)

## Global Constraints

- **Every commit touching `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`.** `dist/` is gitignored but force-tracked; CI's `bundle-drift` job enforces byte-equality. A src-only commit leaves `git pull` upgraders running the old code.
- Imports inside `src/` use the `.js` extension (tsdown rewrites specifiers). This plan touches no files under `scripts/`.
- New test files must live under `src/**/__tests__/**/*.test.ts` or vitest never collects them.
- Coverage is gated **per file at 70%**, not on the average.
- Cache files are read through `readJsonValidated` (`src/utils/atomic-json.ts`) and written through `writeJsonAtomic`. Never `JSON.parse(raw) as SomeType` — that is the #92 defect.
- Hermetic tests set **both** `HOME` and `XDG_CACHE_HOME` to a tmpdir.
- Verify every new test by breaking what it guards. A test that passes against the pre-fix code asserts nothing.

---

### Task 1: Extract `shardKey` into `src/utils/paths.ts`

`daily-cost-tracker.ts` owns the only sanitiser that stops a stdin-supplied session id reaching a filesystem path. Task 2 needs the same rule. Extract it rather than copy it.

**Files:**
- Modify: `src/utils/paths.ts` (add import + export)
- Modify: `src/data/daily-cost-tracker.ts:1-3` (imports), `:54-56` (delete regex), `:71-76` (use helper)
- Test: `src/__tests__/paths.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function shardKey(sessionId: string): string` from `src/utils/paths.js`. Returns the id verbatim when it matches `/^[A-Za-z0-9_-]{1,128}$/`, otherwise the first 16 hex chars of its sha256. Task 2 imports this.

- [ ] **Step 0: Branch off main**

All three tasks land on one branch. `main` is the default branch, so do not commit there.

```bash
git checkout -b fix/turn-tracker-gate-and-shard
```

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/paths.test.ts`:

```ts
describe("shardKey", () => {
  it("passes a Claude Code session UUID through verbatim", () => {
    expect(shardKey("f824ed55-511f-4b26-ba97-20cd7efa5a13")).toBe(
      "f824ed55-511f-4b26-ba97-20cd7efa5a13",
    );
  });

  it("hashes an id containing path separators", () => {
    const key = shardKey("../../etc/passwd");
    expect(key).not.toContain("/");
    expect(key).not.toContain(".");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes an id longer than 128 characters", () => {
    expect(shardKey("a".repeat(129))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same input", () => {
    expect(shardKey("../x")).toBe(shardKey("../x"));
  });

  it("separates ids that differ only past the safe-character boundary", () => {
    expect(shardKey("a/b")).not.toBe(shardKey("a/c"));
  });
});
```

Add `shardKey` to the existing import from `../utils/paths.js` at the top of the file. If that file imports nothing from `paths.js` yet, add:

```ts
import { shardKey } from "../utils/paths.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/paths.test.ts -t "shardKey"`
Expected: FAIL — `shardKey is not a function` / TypeScript reports no exported member `shardKey`.

- [ ] **Step 3: Add the helper to `src/utils/paths.ts`**

Add to the imports at the top of the file:

```ts
import * as crypto from "node:crypto";
```

Add the helper (place it directly above `getCacheDir`):

```ts
// The UUIDs Claude Code sends. Anything else is hashed rather than trusted: a
// session id arrives from stdin and must never reach a filesystem path
// unchecked. Shared by the daily cost store and the turn store so there is one
// implementation of that rule, not two.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function shardKey(sessionId: string): string {
  return SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/paths.test.ts -t "shardKey"`
Expected: PASS (5 tests).

- [ ] **Step 5: Point `daily-cost-tracker.ts` at the shared helper**

In `src/data/daily-cost-tracker.ts`:

Delete the now-unused `crypto` import (line 1, `import * as crypto from "node:crypto";`).

Change the paths import to:

```ts
import { getCacheDir, shardKey } from "../utils/paths.js";
```

Delete the local regex and its comment (lines 54-56):

```ts
// The UUIDs Claude Code sends. Anything else is hashed rather than trusted:
// sessionId arrives from stdin and must never reach a path unchecked.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
```

Replace the body of `shardPath` (lines 71-76), keeping its doc comment:

```ts
function shardPath(sessionId: string): string {
  return path.join(getShardDir(), `${shardKey(sessionId)}.json`);
}
```

- [ ] **Step 6: Verify the extraction changed no behaviour**

Run: `npx vitest run src/__tests__/daily-cost-tracker.test.ts src/__tests__/concurrency.test.ts src/__tests__/paths.test.ts`
Expected: PASS, no test count change in the two daily-store files.

- [ ] **Step 7: Build and commit**

```bash
npm run build
git add src/utils/paths.ts src/data/daily-cost-tracker.ts src/__tests__/paths.test.ts
git add -f dist/index.js
git commit -m "refactor: share one session-id path sanitiser (#99)"
```

---

### Task 2: Shard the turn store per session

**Files:**
- Rewrite: `src/data/turn-tracker.ts`
- Modify: `src/__tests__/cache-validation.test.ts:104-127` (move the four validation cases to the new path)
- Test: `src/__tests__/turn-tracker.test.ts` (create)

**Interfaces:**
- Consumes: `shardKey(sessionId: string): string` from `src/utils/paths.js` (Task 1).
- Produces: `export function trackTurn(sessionId: string | undefined): number` — unchanged signature. Now reads and writes `<cacheDir>/turns/<shardKey(sessionId)>.json` holding `{sessionId: string, count: number, updatedAt: number}`. Returns 0 for a missing session id, otherwise the post-increment count. Task 3 calls this.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/turn-tracker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackTurn } from "../data/turn-tracker.js";

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

function turnsDir(): string {
  return path.join(tmpDir, "gccusage", "turns");
}

function shardFiles(): string[] {
  try {
    return fs.readdirSync(turnsDir()).sort();
  } catch {
    return [];
  }
}

function writeShard(name: string, contents: unknown): void {
  fs.mkdirSync(turnsDir(), { recursive: true });
  fs.writeFileSync(
    path.join(turnsDir(), name),
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-turns-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("trackTurn", () => {
  it("returns 0 and writes nothing without a session id", () => {
    expect(trackTurn(undefined)).toBe(0);
    expect(shardFiles()).toEqual([]);
  });

  it("counts up across calls in one session", () => {
    expect(trackTurn("s1")).toBe(1);
    expect(trackTurn("s1")).toBe(2);
    expect(trackTurn("s1")).toBe(3);
  });

  it("writes one shard per session, named for the session id", () => {
    trackTurn("s1");
    trackTurn("s2");
    expect(shardFiles()).toEqual(["s1.json", "s2.json"]);
  });

  // THE REGRESSION TEST for the single-global-slot defect (#99). Before
  // sharding, an interleaved second session reset the file on every
  // alternating call, pinning both counters at 1.
  it("keeps concurrent sessions' counts independent when interleaved", () => {
    expect(trackTurn("alpha")).toBe(1);
    expect(trackTurn("beta")).toBe(1);
    expect(trackTurn("alpha")).toBe(2);
    expect(trackTurn("beta")).toBe(2);
    expect(trackTurn("alpha")).toBe(3);
    expect(trackTurn("beta")).toBe(3);
  });

  it("keeps an unsafe session id inside the turns directory", () => {
    expect(trackTurn("../../etc/passwd")).toBe(1);
    const files = shardFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{16}\.json$/);
  });

  it("restarts the count when a shard holds a different session id", () => {
    // Only reachable via a hash collision, but the guard is what makes the
    // hashed key safe to reuse rather than silently continuing another
    // session's count.
    writeShard("s1.json", { sessionId: "other", count: 41, updatedAt: Date.now() });
    expect(trackTurn("s1")).toBe(1);
  });
});

describe("trackTurn store validation", () => {
  // The reproduced blank-bar defect (#92): a four-byte "null" file used to
  // throw out of trackTurn and erase the whole statusline.
  it("rebuilds from a bare null document instead of throwing", () => {
    writeShard("s1.json", "null");
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds when count is not a number", () => {
    writeShard("s1.json", { sessionId: "s1", count: "7", updatedAt: Date.now() });
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds from a torn file", () => {
    writeShard("s1.json", '{"sessionId": "s1", "cou');
    expect(trackTurn("s1")).toBe(1);
  });
});

describe("trackTurn pruning", () => {
  const DAY_MS = 24 * 3600 * 1000;

  it("removes shards untouched for more than 48h on a new session's first render", () => {
    writeShard("ancient.json", {
      sessionId: "ancient",
      count: 99,
      updatedAt: Date.now() - 3 * DAY_MS,
    });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json"]);
  });

  it("keeps shards touched within 48h", () => {
    writeShard("recent.json", {
      sessionId: "recent",
      count: 99,
      updatedAt: Date.now() - 1 * DAY_MS,
    });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json", "recent.json"]);
  });

  it("prunes a shard with no updatedAt, which predates this format", () => {
    writeShard("legacy-format.json", { sessionId: "legacy-format", count: 5 });
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["fresh.json"]);
  });

  it("does not scan the directory again once the session has a shard", () => {
    trackTurn("fresh");
    writeShard("ancient.json", {
      sessionId: "ancient",
      count: 99,
      updatedAt: Date.now() - 3 * DAY_MS,
    });
    // Second render of the same session: its own shard exists, so no sweep.
    trackTurn("fresh");
    expect(shardFiles()).toEqual(["ancient.json", "fresh.json"]);
  });

  it("deletes the pre-shard turn-count.json", () => {
    const legacy = path.join(tmpDir, "gccusage", "turn-count.json");
    fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ sessionId: "old", count: 12 }));
    trackTurn("fresh");
    expect(fs.existsSync(legacy)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/turn-tracker.test.ts`
Expected: FAIL. Most cases fail because `trackTurn` still writes `turn-count.json`, so `shardFiles()` returns `[]`; the interleaving case fails with `expected 1 to be 2`.

- [ ] **Step 3: Rewrite `src/data/turn-tracker.ts`**

Replace the file's entire contents with:

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir, shardKey } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

// `JSON.parse("null")` succeeds and yields null, which the old `as TurnData`
// cast then dereferenced outside the try block — throwing, and blanking the
// entire statusline over a four-byte cache file (#92).
//
// `updatedAt` falls back to 0 so a shard written in an older format reads as
// infinitely stale and is pruned, rather than surviving forever unpruneable.
const TurnDataSchema = v.object({
  sessionId: v.string(),
  count: v.number(),
  updatedAt: v.fallback(v.number(), 0),
});

type TurnData = v.InferOutput<typeof TurnDataSchema>;

// Matches the daily cost store's retention today, but deliberately its own
// constant: the two stores' policies are independent and there is no reason
// for them to have to move together.
const STALE_TURN_MS = 48 * 3600 * 1000;

function getTurnDir(): string {
  return path.join(getCacheDir(), "turns");
}

/**
 * One file per session, so a render only ever writes its own session's data.
 * A single global file reset the count to 1 on every alternating render once
 * two sessions were open (#99) — the same defect the daily cost store had
 * before it was sharded in #81.
 */
function turnShardPath(sessionId: string): string {
  return path.join(getTurnDir(), `${shardKey(sessionId)}.json`);
}

function getLegacyTurnPath(): string {
  return path.join(getCacheDir(), "turn-count.json");
}

/**
 * Bound the store's growth without adding a directory scan to every render.
 *
 * Called only when this session has no shard yet, which happens once per
 * session rather than once per render. Sharding otherwise trades a per-render
 * write for a per-render `readdir`, which is not a fix.
 */
function pruneStaleShards(now: number): void {
  // The pre-shard global file. Its value is deliberately not migrated: it
  // holds one count, for one session, for a widget in no default layout, and
  // the counter resets on session change by design.
  try {
    fs.unlinkSync(getLegacyTurnPath());
  } catch {
    // Absent, which is the common case after the first upgrade.
  }

  let files: string[];
  try {
    files = fs.readdirSync(getTurnDir());
  } catch {
    return; // No store yet.
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(getTurnDir(), file);

    const entry = readJsonValidated(fullPath, TurnDataSchema);
    // A null here is either a corrupt shard or one we failed to read, and
    // those are indistinguishable from outside. Deleting a file we merely
    // could not read is the mistake `migrateLegacyStore` exists to avoid, so
    // leave it. The leak is bounded by the number of sessions that ever
    // suffered a torn write, at roughly 60 bytes each.
    if (!entry) continue;

    if (now - entry.updatedAt < STALE_TURN_MS) continue;

    try {
      fs.unlinkSync(fullPath);
    } catch {
      // Best effort; a stale shard contributes nothing anyway.
    }
  }
}

/**
 * Increment and return the turn count for the given session.
 * Resets when the session ID changes.
 *
 * Note this counts renders that missed the statusline cache, not turns:
 * `runStatusline` returns from cache before the pipeline runs. That predates
 * sharding and is unchanged here.
 */
export function trackTurn(sessionId: string | undefined): number {
  if (!sessionId) return 0;

  const filePath = turnShardPath(sessionId);
  const now = Date.now();
  const existing = readJsonValidated(filePath, TurnDataSchema);

  // No shard for this session yet — the once-per-session moment to sweep. A
  // corrupt shard also reads as null and sweeps too, which is harmless: the
  // sweep only removes files that are independently stale.
  if (existing === null) {
    pruneStaleShards(now);
  }

  // Unsafe session ids share a hashed key space, so two ids could in
  // principle land on one file. Keeping the id in the document lets that be
  // detected rather than silently continuing another session's count.
  const data: TurnData =
    existing && existing.sessionId === sessionId
      ? { sessionId, count: existing.count + 1, updatedAt: now }
      : { sessionId, count: 1, updatedAt: now };

  // Atomic replacement, but deliberately no lock: one session writes only its
  // own shard, so there is no shared read-modify-write left to lose.
  writeJsonAtomic(filePath, data);

  return data.count;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/turn-tracker.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 5: Prove the regression test is not vacuous**

A sharding test that also passes against unsharded code asserts nothing. Temporarily restore the pre-fix tracker and confirm the interleaving test fails.

Stash the new implementation and paste the pre-fix body over `trackTurn`, keeping the new file's imports:

```ts
// TEMPORARY — pre-fix single-file tracker, for verification only.
export function trackTurn(sessionId: string | undefined): number {
  if (!sessionId) return 0;
  const filePath = path.join(getCacheDir(), "turn-count.json");
  let data = readJsonValidated(filePath, TurnDataSchema) ?? {
    sessionId: "",
    count: 0,
    updatedAt: 0,
  };
  if (data.sessionId !== sessionId) data = { sessionId, count: 0, updatedAt: 0 };
  data.count++;
  writeJsonAtomic(filePath, data);
  return data.count;
}
```

Run: `npx vitest run src/__tests__/turn-tracker.test.ts -t "keeps concurrent sessions"`
Expected: **FAIL** with `expected 1 to be 2` — the second `trackTurn("alpha")` reads a file whose `sessionId` is now `beta`, resets, and returns 1.

If it PASSES, the test is vacuous and must be rewritten before continuing.

Then restore the real implementation from Step 3 and re-run the full file to confirm PASS (15 tests).

- [ ] **Step 6: Move the old validation cases out of `cache-validation.test.ts`**

The four cases in `describe("turn counter validation", ...)` (lines 104-127) target `turn-count.json`, which no longer exists. Their replacements now live in `turn-tracker.test.ts` (Step 1). Delete that whole `describe` block, and delete the now-unused import:

```ts
import { trackTurn } from "../data/turn-tracker.js";
```

Leave the `runStatusline` hostile-payload test at line 478 alone — Task 3 deals with it, because the gate is what makes its turn-count sabotage inert.

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run src/__tests__/turn-tracker.test.ts src/__tests__/cache-validation.test.ts`
Expected: PASS. `cache-validation.test.ts` loses 4 tests; nothing else changes.

- [ ] **Step 8: Build and commit**

```bash
npm run build
git add src/data/turn-tracker.ts src/__tests__/turn-tracker.test.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "fix: shard the turn store per session (#99)"
```

---

### Task 3: Gate `trackTurn` on layout presence

This is the issue's stated acceptance criterion: a render whose layout has no `turn-counter` performs no turn-store I/O.

**Files:**
- Create: `src/config/layout.ts`
- Modify: `src/data/pipeline.ts:18` (import), `:139` (call site)
- Modify: `src/__tests__/cache-validation.test.ts:478-546` (repair the leg the gate makes inert)
- Test: `src/__tests__/layout-gate.test.ts` (create)

**Interfaces:**
- Consumes: `trackTurn(sessionId: string | undefined): number` from `src/data/turn-tracker.js` (Task 2).
- Produces: `export function layoutIncludesWidget(settings: Settings, type: string): boolean` from `src/config/layout.js`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/layout-gate.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { layoutIncludesWidget } from "../config/layout.js";
import { buildRenderContext } from "../data/pipeline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import type { Settings } from "../config/schema.js";
import type { StatusJson } from "../types/status-json.js";

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => ({})),
  getPricingForRender: vi.fn(() => ({ pricing: {}, stale: false })),
}));

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

function turnsDirExists(): boolean {
  return fs.existsSync(path.join(tmpDir, "gccusage", "turns"));
}

function withWidget(type: string): Settings {
  return {
    ...DEFAULT_SETTINGS,
    lines: [{ widgets: [{ type }], flex: "left" }],
  };
}

const STDIN: StatusJson = {
  session_id: "gate-session",
  model: { id: "claude-opus-4-5", display_name: "Opus" },
  cost: { total_cost_usd: 1.5 },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-gate-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("layoutIncludesWidget", () => {
  it("finds a widget on the first line", () => {
    expect(layoutIncludesWidget(withWidget("turn-counter"), "turn-counter")).toBe(true);
  });

  it("finds a widget on a later line", () => {
    // git-branch is on the SECOND default line, so a first-line-only scan
    // would report false here.
    expect(layoutIncludesWidget(DEFAULT_SETTINGS, "git-branch")).toBe(true);
  });

  it("reports false for a widget in no line", () => {
    expect(layoutIncludesWidget(DEFAULT_SETTINGS, "turn-counter")).toBe(false);
  });

  it("reports false for an empty layout", () => {
    expect(layoutIncludesWidget({ ...DEFAULT_SETTINGS, lines: [] }, "turn-counter")).toBe(
      false,
    );
  });
});

describe("turn tracking gate", () => {
  it("writes no turn shard when the layout has no turn-counter", async () => {
    const context = await buildRenderContext(STDIN, DEFAULT_SETTINGS);
    expect(turnsDirExists()).toBe(false);
    expect(context.turnCount).toBe(0);
  });

  it("writes a turn shard when the layout has a turn-counter", async () => {
    const context = await buildRenderContext(STDIN, withWidget("turn-counter"));
    expect(turnsDirExists()).toBe(true);
    expect(context.turnCount).toBe(1);
  });

  it("keeps counting across renders once enabled", async () => {
    const settings = withWidget("turn-counter");
    await buildRenderContext(STDIN, settings);
    const second = await buildRenderContext(STDIN, settings);
    expect(second.turnCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/layout-gate.test.ts`
Expected: FAIL — TypeScript cannot resolve `../config/layout.js`, and the "writes no turn shard" case would fail anyway because `trackTurn` is still unconditional.

- [ ] **Step 3: Create `src/config/layout.ts`**

```ts
import type { Settings } from "./schema.js";

/**
 * Whether `type` appears anywhere in the resolved layout.
 *
 * Deliberately coarse: it asks whether the widget is *configured*, not whether
 * it survives the shrink pass at render time. A widget dropped for width still
 * counts. Over-counting in that edge is acceptable — the point is to charge
 * nothing to the users who never configured the widget at all.
 *
 * `lines` is always present after the loader merge (`loader.ts:40`), so there
 * is no optional handling here.
 */
export function layoutIncludesWidget(settings: Settings, type: string): boolean {
  return settings.lines.some((line) => line.widgets.some((w) => w.type === type));
}
```

- [ ] **Step 4: Gate the call site in `src/data/pipeline.ts`**

Add to the imports (beside the other config import at the top):

```ts
import { layoutIncludesWidget } from "../config/layout.js";
```

Replace line 139:

```ts
    turnCount: trackTurn(stdin.session_id),
```

with:

```ts
    // `trackTurn` reads and writes a file, and `turn-counter` is in no default
    // layout — so for almost every user this was I/O for a number nothing
    // displays (#99). Gate on the layout, the same shape as the `today` gate
    // above. 0 is safe: `turn-counter` renders nothing below 1.
    turnCount: layoutIncludesWidget(settings, "turn-counter")
      ? trackTurn(stdin.session_id)
      : 0,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/layout-gate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Repair the hostile-payload test the gate makes inert**

`cache-validation.test.ts:478` renders with `DEFAULT_SETTINGS`, which has no `turn-counter`. With the gate in place its `write("turn-count.json", "null")` sabotage is never read — the leg silently stops testing anything, which is exactly the vacuous-test trap this repo has been bitten by.

Two edits inside that test.

First, replace the `write("turn-count.json", "null")` call and its comment with a write to the new store, since the file the test sabotages must be the file the code reads:

```ts
    // A null turn shard throws inside trackTurn when the reader is
    // unvalidated (see the sabotage below) — that throw propagates straight
    // out of runStatusline here, since this test calls it directly rather
    // than through src/index.ts's main().catch(), which is what turns the
    // same throw into an empty bar and exit 0 in production.
    //
    // The turn store is only read when the layout contains `turn-counter`
    // (#99), so this leg renders with HOSTILE_SETTINGS below rather than
    // DEFAULT_SETTINGS. With the default layout the sabotage is never read
    // and this leg would assert nothing.
    fs.mkdirSync(path.join(tmpDir, "gccusage", "turns"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "gccusage", "turns", "hostile.json"), "null");
```

Second, define the settings above the `runStatusline` call and use them:

```ts
    // DEFAULT_SETTINGS plus a turn-counter, so the corrupted turn shard is
    // actually read. Everything else about the layout is unchanged.
    const HOSTILE_SETTINGS = {
      ...DEFAULT_SETTINGS,
      lines: [
        ...DEFAULT_SETTINGS.lines,
        { widgets: [{ type: "turn-counter" }], flex: "left" as const },
      ],
    };

    const output = await runStatusline(stdin, HOSTILE_SETTINGS);
```

The existing assertions (`not.toContain("NaN")`, `toContain("$1.50")`, etc.) stay as they are.

- [ ] **Step 7: Prove the repaired leg still bites**

Confirm the sabotage is reachable: temporarily make `TurnDataSchema` permissive in `src/data/turn-tracker.ts` by replacing it with `const TurnDataSchema = v.any();`.

Run: `npx vitest run src/__tests__/cache-validation.test.ts -t "renders a correct bar with the turn counter"`
Expected: **FAIL** — `existing.sessionId` on a null document throws out of `trackTurn`.

If it PASSES, the leg is still inert and the settings edit did not take effect.

Restore `TurnDataSchema` to the Task 2 version and re-run: PASS.

- [ ] **Step 8: Run the affected suites**

Run: `npx vitest run src/__tests__/layout-gate.test.ts src/__tests__/cache-validation.test.ts src/__tests__/pipeline.test.ts src/__tests__/widget-reality-pipeline.test.ts`
Expected: PASS.

`src/__tests__/fixtures/context-from-fixture.ts:52` sets `turnCount` literally from `controlled.turnCount` and does not route through `buildRenderContext`, so the widget reality harness should be unaffected. This step confirms that rather than assuming it.

- [ ] **Step 9: Build and commit**

```bash
npm run build
git add src/config/layout.ts src/data/pipeline.ts src/__tests__/layout-gate.test.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "perf: track turns only when the layout shows them (#99)"
```

---

### Task 4: Verify the whole branch

CI cannot run (see Known verification gap), so every job is run by hand.

**Files:** none modified unless a check fails.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS, zero failures.

- [ ] **Step 2: Per-file coverage gate**

Run: `npm run test:coverage`
Expected: PASS. `src/config/layout.ts` and `src/data/turn-tracker.ts` must each clear 70%. The gate is per file — a high average does not rescue either.

- [ ] **Step 3: Bundle drift**

Run: `npm run build && git status --short dist/`
Expected: no output. Any diff means a commit shipped stale `dist/index.js`; rebuild and amend.

- [ ] **Step 4: Confirm the acceptance criterion against the real binary**

The unit tests exercise `buildRenderContext`. This confirms it end to end through the shipped bundle, with a clean cache dir.

```bash
CACHE=$(mktemp -d)
echo '{"session_id":"accept-1","model":{"id":"claude-opus-4-5","display_name":"Opus"},"cost":{"total_cost_usd":1.5}}' \
  | XDG_CACHE_HOME="$CACHE" node dist/index.js > /dev/null
ls "$CACHE/gccusage/"
```

Expected: the listing contains no `turns` directory and no `turn-count.json`.

- [ ] **Step 5: Confirm the counter still works when enabled**

The config file is `$XDG_CONFIG_HOME/gccusage/settings.json` (`getConfigPath` in
`src/config/loader.ts:13`). Note the loader replaces `lines` wholesale rather
than merging into the default layout, so this config yields a bar containing
only the turn counter — which is what makes the check unambiguous.

```bash
CACHE=$(mktemp -d)
CFG=$(mktemp -d)
mkdir -p "$CFG/gccusage"
cat > "$CFG/gccusage/settings.json" <<'EOF'
{"lines":[{"widgets":[{"type":"turn-counter"}]}]}
EOF
for i in 1 2 3; do
  echo "{\"session_id\":\"accept-2\",\"model\":{\"id\":\"claude-opus-4-5\",\"display_name\":\"Opus\"},\"cost\":{\"total_cost_usd\":$i.5}}" \
    | XDG_CONFIG_HOME="$CFG" XDG_CACHE_HOME="$CACHE" node dist/index.js
done
cat "$CACHE/gccusage/turns/accept-2.json"
```

Expected: three bars, showing a rising `#1`, `#2`, `#3`, and a shard reading
`{"sessionId":"accept-2","count":3,...}`.

Note the varying `total_cost_usd`: the statusline cache is keyed on the whole stdin payload, so identical input three times would serve two cached bars and increment once.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin fix/turn-tracker-gate-and-shard
gh pr create --title "Track turns only when shown, and per session (#99)" --body "$(cat <<'EOF'
Closes #99 (audit CLEAN-002).

`buildRenderContext` called `trackTurn` on every render — a file read and a
write — for `turn-counter`, a widget in no default layout. It is now called
only when the resolved layout contains that widget.

The store also moves from a single global `turn-count.json` to per-session
shards under `turns/`, following the daily cost store (#81). One global slot
meant two concurrent sessions reset each other to 1 on alternating renders, so
the counter was wrong under exactly the conditions that made it interesting.
Stale shards are pruned on a session's first render, not on every render, so
sharding does not trade a per-render write for a per-render directory scan.

### Correction to the issue's framing

The issue says "every render". `runStatusline` returns from the statusline
cache before the pipeline runs, so `trackTurn` only ever fired on a cache
miss. The saving is real but smaller than stated — and it means `turnCount`
has always counted cache misses rather than turns. That is unchanged here and
filed separately.

### Verification

CI is blocked account-wide by a GitHub billing failure ("The job was not
started…"); every run since before PR #114 aborts in seconds having executed
zero steps. All four jobs were run by hand on a clean clone:

| Job | Result |
|---|---|
| test | _fill in_ |
| coverage | _fill in_ |
| bundle-drift | _fill in_ |

**Node 22 and 24 remain unverified** — this machine has only Node 25/26 and no
version manager. Only real CI retires that debt.

The acceptance criterion was also confirmed end to end against the shipped
bundle: a render with the default layout creates no `turns/` directory, and one
with `turn-counter` configured counts 1, 2, 3 across three renders.
EOF
)"
```

Fill the three result cells from the actual runs in Steps 1-3 before creating the PR — do not pre-write them.

---

## Follow-up to file after merge

`turnCount` counts statusline-cache misses, not turns: `runStatusline` returns from cache before `buildRenderContext` runs (`src/statusline.ts:26-29`), so a burst of renders inside the 5s TTL increments once. The widget's default `#` label promises a turn number the code has never produced.

Out of scope here by decision. File as its own issue, with the two options the spec records: derive a real count from `sessionEntries` (already parsed in `buildRenderContext`), or relabel the widget to stop implying a turn number.
