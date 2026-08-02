# Cache and Pricing Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop trusting two classes of external bytes — the third-party LiteLLM pricing feed (#91) and the four on-disk cache files (#92) — by bounding what a price may be and validating every cache read against a schema.

**Architecture:** One new module (`src/data/pricing-validation.ts`) owns the "is this a plausible price?" question and is used at both the fetch boundary and the cache-read boundary. One new function (`readJsonValidated` in `src/utils/atomic-json.ts`) owns "read a JSON file or give me null", making that module the single read-validate-write owner. Schemas stay colocated with the module that owns each file.

**Tech Stack:** TypeScript, valibot (already a dependency, `^1.0.0`), vitest, tsdown.

**Spec:** `docs/superpowers/specs/2026-08-02-cache-and-pricing-validation-design.md`

## Global Constraints

- **Every commit touching `src/` must rebuild and stage the bundle.** Run `npm run build`, then `git add -f dist/index.js` (the path is gitignored but force-tracked). CI's `bundle-drift` job fails otherwise, and `gccusage setup` points Claude Code at `dist/index.js`, so a src-only commit ships nothing to `git pull` upgraders.
- **`AUDIT.md` is deliberately untracked.** Update it locally; never `git add` it.
- Verification before any commit: `npm run typecheck`, `npm run typecheck:scripts`, `npm test`. All must pass.
- Imports inside `src/` use the **`.js`** extension (tsdown rewrites specifiers). Never `.ts` — that convention belongs to `scripts/` only.
- `vitest.config.ts` pins `include`; `src/__tests__/` is already a collected root, so new test files there are picked up automatically.
- **Verify every new test by breaking what it guards.** After a test goes green, sabotage the line it protects, confirm the test goes red, then restore. A test that passes against broken code asserts nothing.
- Reject-and-degrade is always silent. A rejected pricing entry falls through to a correct `FALLBACK_PRICING` value, so there is nothing to surface on the bar.
- No new dependencies.

---

## File Structure

**Created:**
- `src/data/pricing-validation.ts` — bounds check and snapshot anchor for pricing tables. No I/O. Imports `FALLBACK_PRICING` and the pricing types only.
- `src/__tests__/pricing-validation.test.ts` — unit tests for the above.
- `src/__tests__/cache-validation.test.ts` — the four cache readers fed hostile files, plus the end-to-end no-`NaN` assertion.

**Modified:**
- `src/utils/atomic-json.ts` — gains `readJsonValidated`; keeps `writeJsonAtomic` unchanged.
- `src/data/pricing-fetcher.ts` — bounds inside `parseLitellmPricing`; anchor in `refreshPricing` and `fetchPricing`.
- `src/data/cost-calculator.ts:67-83` — `findPricing` fuzzy tie-break becomes longest-key-wins.
- `src/cache/pricing-cache.ts` — schema-validated envelope, per-entry bounds on `data`.
- `src/cache/cache-manager.ts` — schema-validated entry.
- `src/data/turn-tracker.ts` — schema-validated entry (fixes the blank-bar crash).
- `src/data/daily-cost-tracker.ts` — schema-validated shard and legacy file; hand-rolled `typeof` checks removed.
- `src/__tests__/pricing-fetcher.test.ts` — absurd-table and off-anchor cases.
- `src/__tests__/cost-calculator.test.ts` — key-ordering case.

---

## Task 1: `readJsonValidated` helper

**Files:**
- Modify: `src/utils/atomic-json.ts`
- Test: `src/__tests__/atomic-json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readJsonValidated<S extends v.GenericSchema>(filePath: string, schema: S): v.InferOutput<S> | null` — returns `null` for a missing file, unreadable file, malformed JSON, or schema mismatch. Tasks 5, 6 and 7 all call it.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/atomic-json.test.ts`. Add `readJsonValidated` to the existing import from `../utils/atomic-json.js`, and add `import * as v from "valibot";` at the top.

```ts
describe("readJsonValidated", () => {
  const Schema = v.object({ name: v.string(), count: v.number() });

  it("returns the parsed value when the file matches the schema", () => {
    const target = path.join(tmpDir, "ok.json");
    fs.writeFileSync(target, JSON.stringify({ name: "a", count: 2 }));
    expect(readJsonValidated(target, Schema)).toEqual({ name: "a", count: 2 });
  });

  it("returns null when the file does not exist", () => {
    expect(readJsonValidated(path.join(tmpDir, "absent.json"), Schema)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const target = path.join(tmpDir, "torn.json");
    fs.writeFileSync(target, '{"name": "a", "cou');
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  // The exact shape that blanked the statusline: JSON.parse("null") succeeds
  // and yields null, which every `as T` cast in the codebase then dereferenced.
  it("returns null for a bare null document", () => {
    const target = path.join(tmpDir, "null.json");
    fs.writeFileSync(target, "null");
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  it("returns null when a field has the wrong type", () => {
    const target = path.join(tmpDir, "wrong.json");
    fs.writeFileSync(target, JSON.stringify({ name: "a", count: "2" }));
    expect(readJsonValidated(target, Schema)).toBeNull();
  });

  // valibot's object schema accepts an array and yields {}, so an array root
  // only fails because required keys are missing. Pin that it does fail.
  it("returns null for an array root", () => {
    const target = path.join(tmpDir, "array.json");
    fs.writeFileSync(target, "[1,2,3]");
    expect(readJsonValidated(target, Schema)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/atomic-json.test.ts`
Expected: FAIL — `readJsonValidated is not a function` (or a TS resolution error on the import).

- [ ] **Step 3: Implement `readJsonValidated`**

In `src/utils/atomic-json.ts`, add `import * as v from "valibot";` alongside the existing imports, and append:

```ts
/**
 * Read a JSON file and validate it, or get nothing. Every cache file in this
 * codebase used to be read with `JSON.parse(raw) as SomeType` — a cast that
 * checks nothing at runtime — while config got full valibot validation. The
 * caches are the files that can actually be corrupted, by a torn write or by
 * hand (#92).
 *
 * Returns null for a missing file, an unreadable one, malformed JSON, or a
 * document that does not match `schema`. Callers treat null as "rebuild from
 * scratch", which is the posture they already had for a missing file.
 */
export function readJsonValidated<S extends v.GenericSchema>(
  filePath: string,
  schema: S,
): v.InferOutput<S> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = v.safeParse(schema, parsed);
  return result.success ? result.output : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/atomic-json.test.ts`
Expected: PASS (existing `writeJsonAtomic` tests included).

- [ ] **Step 5: Break what the tests guard**

Temporarily change the last line to `return result.success ? result.output : (parsed as v.InferOutput<S>);`. Re-run. Expected: the wrong-type, bare-null and array-root cases go RED. Restore the correct line and re-run to green.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/utils/atomic-json.ts src/__tests__/atomic-json.test.ts
git add -f dist/index.js
git commit -m "feat: add readJsonValidated, a schema-checked JSON file reader"
```

---

## Task 2: Pricing bounds and snapshot anchor

**Files:**
- Create: `src/data/pricing-validation.ts`
- Test: `src/__tests__/pricing-validation.test.ts`

**Interfaces:**
- Consumes: `FALLBACK_PRICING` from `src/data/fallback-pricing.js`; `ModelPricing`, `PricingTable` from `src/types/pricing.js`.
- Produces:
  - `MAX_COST_PER_TOKEN: number` (`1e-3`)
  - `MAX_SNAPSHOT_DEVIATION: number` (`10`)
  - `isSaneModelPricing(value: unknown): value is ModelPricing`
  - `sanitisePricingTable(table: Record<string, unknown>): PricingTable`
  - `anchorToSnapshot(table: PricingTable, snapshot?: PricingTable): PricingTable`

  Task 3 uses `isSaneModelPricing` and `anchorToSnapshot`; Task 7 uses `sanitisePricingTable`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/pricing-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  MAX_COST_PER_TOKEN,
  isSaneModelPricing,
  sanitisePricingTable,
  anchorToSnapshot,
} from "../data/pricing-validation.js";
import type { ModelPricing, PricingTable } from "../types/pricing.js";

function pricing(overrides: Partial<ModelPricing> = {}): ModelPricing {
  return {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
    ...overrides,
  };
}

describe("isSaneModelPricing", () => {
  it("accepts a real Opus-scale price", () => {
    expect(isSaneModelPricing(pricing())).toBe(true);
  });

  it("accepts a zero cache-read cost", () => {
    expect(isSaneModelPricing(pricing({ cacheReadCostPerToken: 0 }))).toBe(true);
  });

  // A zero input cost renders a confident $0.00 for a real session exactly as
  // a missing table did (#82). That is a broken record, not a free model.
  it("rejects a zero input cost", () => {
    expect(isSaneModelPricing(pricing({ inputCostPerToken: 0 }))).toBe(false);
  });

  it("rejects a negative cost", () => {
    expect(isSaneModelPricing(pricing({ outputCostPerToken: -1 }))).toBe(false);
  });

  it("rejects a cost above the ceiling", () => {
    expect(
      isSaneModelPricing(pricing({ outputCostPerToken: MAX_COST_PER_TOKEN * 2 })),
    ).toBe(false);
  });

  it("rejects a non-numeric cost", () => {
    expect(isSaneModelPricing({ ...pricing(), inputCostPerToken: "3e-6" })).toBe(false);
  });

  it("rejects a missing cost field", () => {
    const { cacheReadCostPerToken: _omitted, ...partial } = pricing();
    expect(isSaneModelPricing(partial)).toBe(false);
  });

  it("rejects null and non-objects", () => {
    expect(isSaneModelPricing(null)).toBe(false);
    expect(isSaneModelPricing(42)).toBe(false);
  });
});

describe("sanitisePricingTable", () => {
  it("drops only the offending entry", () => {
    const result = sanitisePricingTable({
      good: pricing(),
      poisoned: pricing({ outputCostPerToken: 1 }),
      junk: "not-an-object",
    });
    expect(Object.keys(result)).toEqual(["good"]);
  });
});

describe("anchorToSnapshot", () => {
  const snapshot: PricingTable = { "claude-known": pricing() };

  it("keeps an entry that matches the snapshot", () => {
    const result = anchorToSnapshot({ "claude-known": pricing() }, snapshot);
    expect(result["claude-known"]).toBeDefined();
  });

  it("keeps an entry within the deviation band", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ outputCostPerToken: 30 / 1_000_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeDefined();
  });

  // The attack the issue describes: a value that passes bounds comfortably but
  // is nothing like the price we shipped.
  it("rejects an entry that deviates beyond the band", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ outputCostPerToken: 15 / 1_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeUndefined();
  });

  it("rejects an entry priced far below the snapshot", () => {
    const result = anchorToSnapshot(
      { "claude-known": pricing({ inputCostPerToken: 3 / 1_000_000_000 }) },
      snapshot,
    );
    expect(result["claude-known"]).toBeUndefined();
  });

  it("lets a model absent from the snapshot through", () => {
    const result = anchorToSnapshot({ "claude-brand-new": pricing() }, snapshot);
    expect(result["claude-brand-new"]).toBeDefined();
  });

  it("rejects one entry without disturbing its table-mates", () => {
    const result = anchorToSnapshot(
      {
        "claude-known": pricing({ outputCostPerToken: 15 / 1_000 }),
        "claude-brand-new": pricing(),
      },
      snapshot,
    );
    expect(Object.keys(result)).toEqual(["claude-brand-new"]);
  });

  it("defaults to the shipped snapshot", () => {
    // Called with one argument, so FALLBACK_PRICING is the anchor. A known
    // model priced 1000x high must not survive.
    const result = anchorToSnapshot({
      "claude-haiku-4-5": pricing({ inputCostPerToken: 1 / 1_000 }),
    });
    expect(result["claude-haiku-4-5"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/pricing-validation.test.ts`
Expected: FAIL — cannot resolve `../data/pricing-validation.js`.

- [ ] **Step 3: Implement the module**

Create `src/data/pricing-validation.ts`:

```ts
import type { ModelPricing, PricingTable } from "../types/pricing.js";
import { FALLBACK_PRICING } from "./fallback-pricing.js";

/**
 * $1000 per million tokens. The live table tops out at 7.5e-5 (Opus output),
 * so this sits ~13x above anything real: it rejects the absurd and never a
 * genuine repricing.
 */
export const MAX_COST_PER_TOKEN = 1e-3;

/**
 * How far a fetched price may drift from the checked-in snapshot before we
 * stop believing it. Anthropic has never moved a price by this factor.
 */
export const MAX_SNAPSHOT_DEVIATION = 10;

const COST_KEYS = [
  "inputCostPerToken",
  "outputCostPerToken",
  "cacheCreationCostPerToken",
  "cacheReadCostPerToken",
] as const;

/**
 * Bounds. Answers "is this a plausible price record?", which is intrinsic to
 * parsing one — so it runs inside `parseLitellmPricing`, and every caller
 * inherits it, including `npm run pricing` when it regenerates the snapshot.
 */
export function isSaneModelPricing(value: unknown): value is ModelPricing {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;

  for (const key of COST_KEYS) {
    const cost = record[key];
    if (typeof cost !== "number" || !Number.isFinite(cost)) return false;
    if (cost < 0 || cost > MAX_COST_PER_TOKEN) return false;
  }

  // A zero input cost is not a free model — it is a broken record, and it
  // renders a confident $0.00 for a real session exactly as the stale
  // fallback table did (#82).
  return (record["inputCostPerToken"] as number) > 0;
}

/** Drop the entries that fail bounds, keep the rest. Never all-or-nothing. */
export function sanitisePricingTable(table: Record<string, unknown>): PricingTable {
  const out: PricingTable = {};
  for (const [key, value] of Object.entries(table)) {
    if (isSaneModelPricing(value)) out[key] = value;
  }
  return out;
}

/**
 * Integrity anchor. Bounds alone still admit a 13x overcharge, so a fetched
 * price for a model we already ship a snapshot for must land within
 * MAX_SNAPSHOT_DEVIATION of it. A rejected entry falls through to its
 * FALLBACK_PRICING value via the merge in pricing-fetcher, so the degradation
 * is to last-known-good rather than to nothing.
 *
 * Deliberately NOT applied when reading the cache: the anchor is about
 * trusting the feed, cached entries already passed it at write time, and
 * re-running it would silently invalidate a legitimately cached price the day
 * someone regenerates the snapshot after a real price move.
 *
 * Models absent from the snapshot are genuinely new and pass on bounds alone.
 */
export function anchorToSnapshot(
  table: PricingTable,
  snapshot: PricingTable = FALLBACK_PRICING,
): PricingTable {
  const out: PricingTable = {};

  for (const [key, value] of Object.entries(table)) {
    const known = snapshot[key];
    if (!known) {
      out[key] = value;
      continue;
    }
    if (COST_KEYS.every((k) => withinDeviation(value[k], known[k]))) {
      out[key] = value;
    }
  }

  return out;
}

/**
 * A zero in the snapshot means the feed stated zero — `parseLitellmPricing`
 * derives its defaults from the input cost and never produces one. There is no
 * ratio to take, so only zero matches.
 */
function withinDeviation(fetched: number, known: number): boolean {
  if (known === 0) return fetched === 0;
  const ratio = fetched / known;
  return ratio >= 1 / MAX_SNAPSHOT_DEVIATION && ratio <= MAX_SNAPSHOT_DEVIATION;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/pricing-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Break what the test guards**

Temporarily change `if (cost < 0 || cost > MAX_COST_PER_TOKEN) return false;` to `if (cost < 0) return false;`. Re-run — the ceiling case goes RED. Restore. Then change `anchorToSnapshot`'s `every(...)` line to `out[key] = value;` unconditionally. Re-run — the deviation cases go RED. Restore and confirm green.

- [ ] **Step 6: Verify and commit**

`src/data/pricing-validation.ts` is not yet imported by anything, so the bundle is unchanged — but rebuild anyway so the committed bundle is provably current.

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/data/pricing-validation.ts src/__tests__/pricing-validation.test.ts
git add -f dist/index.js
git commit -m "feat: bound pricing values and anchor them to the shipped snapshot (#91)"
```

---

## Task 3: Apply bounds and anchor at the fetch boundary

**Files:**
- Modify: `src/data/pricing-fetcher.ts` (`parseLitellmPricing`, `refreshPricing`, `fetchPricing`)
- Test: `src/__tests__/pricing-fetcher.test.ts`

**Interfaces:**
- Consumes: `isSaneModelPricing`, `anchorToSnapshot` from Task 2.
- Produces: no signature changes. `parseLitellmPricing` now omits out-of-bounds entries; `refreshPricing` and `fetchPricing` now omit off-anchor entries.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/pricing-fetcher.test.ts`. Add `parseLitellmPricing` to the existing import from `../data/pricing-fetcher.js`.

The file already stubs `fetch` in its existing cases — follow whatever pattern is in place there for the `fetchPricing` case below (`vi.stubGlobal("fetch", ...)` returning `{ ok: true, json: async () => data }`).

```ts
describe("pricing feed integrity (#91)", () => {
  // The upstream field names, not ours — this is what parseLitellmPricing eats.
  function upstream(input: number, output: number): Record<string, unknown> {
    return { input_cost_per_token: input, output_cost_per_token: output };
  }

  it("drops a model whose price is absurd and keeps its table-mates", () => {
    const table = parseLitellmPricing({
      "claude-sane-test": upstream(3 / 1_000_000, 15 / 1_000_000),
      "claude-absurd-test": upstream(3 / 1_000_000, 5),
    });

    expect(table["claude-sane-test"]).toBeDefined();
    expect(table["claude-absurd-test"]).toBeUndefined();
  });

  it("drops a model priced at zero rather than reporting $0.00 for it", () => {
    const table = parseLitellmPricing({
      "claude-free-test": upstream(0, 0),
    });

    expect(table["claude-free-test"]).toBeUndefined();
  });

  it("rejects a known model whose fetched price deviates from the snapshot", async () => {
    // haiku-4-5 ships in FALLBACK_PRICING at 1e-6 input. 1e-4 is 100x that:
    // comfortably inside the bounds ceiling, nothing like the real price.
    stubFetchJson({
      "claude-haiku-4-5": upstream(1 / 10_000, 5 / 10_000),
    });

    const table = await fetchPricing(TTL);

    expect(table["claude-haiku-4-5"]!.inputCostPerToken).toBe(
      FALLBACK_PRICING["claude-haiku-4-5"]!.inputCostPerToken,
    );
  });

  it("still accepts a fetched price for a model the snapshot has never seen", async () => {
    stubFetchJson({
      "claude-future-9": upstream(9 / 1_000_000, 45 / 1_000_000),
    });

    const table = await fetchPricing(TTL);

    expect(table["claude-future-9"]!.inputCostPerToken).toBe(9 / 1_000_000);
  });
});
```

Add this helper near the top of the file, next to the existing `writeCache` helper:

```ts
function stubFetchJson(data: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => data })),
  );
}
```

If the existing tests already define an equivalent helper, reuse it rather than adding a second one. Ensure `vi.unstubAllGlobals()` runs in the file's `afterEach` — add it if absent.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts`
Expected: FAIL — the absurd and zero entries are present, and the deviating haiku price overrides the snapshot.

- [ ] **Step 3: Wire the checks in**

In `src/data/pricing-fetcher.ts`, add the import:

```ts
import { anchorToSnapshot, isSaneModelPricing } from "./pricing-validation.js";
```

In `parseLitellmPricing`, after the `const pricing: ModelPricing = { ... };` literal and before the key assignments, insert:

```ts
    // Bounds before storage, so an absurd or zero price never reaches the
    // cache, the bar, or the regenerated snapshot (#91). Per entry: one
    // poisoned model must not discard the two dozen good ones.
    if (!isSaneModelPricing(pricing)) continue;
```

In `refreshPricing`, replace `const pricing = parseLitellmPricing(data);` with:

```ts
    const pricing = anchorToSnapshot(parseLitellmPricing(data));
```

In `fetchPricing`, replace `const pricing = parseLitellmPricing(data);` with the same line. The existing `Object.keys(pricing).length` guards stay as they are — they now also cover a feed whose every entry was rejected.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/pricing-fetcher.test.ts`
Expected: PASS, including every pre-existing case in the file. The `#93` fallback-merge tests must stay green — if one fails, the anchor is rejecting a legitimate fixture price, so fix the fixture, not the anchor.

- [ ] **Step 5: Confirm the snapshot still regenerates**

`npm run pricing` runs `parseLitellmPricing` against the live feed to rebuild `FALLBACK_PRICING`. Bounds now apply there too.

Run: `npm run pricing && git diff --stat src/data/fallback-pricing.ts`
Expected: no diff, or a diff containing only genuine upstream changes — never a mass deletion of models. A mass deletion means the ceiling or the zero-input rule is wrong. Discard any diff with `git checkout src/data/fallback-pricing.ts` unless it is an intended refresh.

- [ ] **Step 6: Break what the tests guard**

Comment out the `if (!isSaneModelPricing(pricing)) continue;` line. Re-run: the absurd and zero cases go RED. Restore. Change `anchorToSnapshot(parseLitellmPricing(data))` back to `parseLitellmPricing(data)` in `fetchPricing`. Re-run: the deviation case goes RED. Restore and confirm green.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/data/pricing-fetcher.ts src/__tests__/pricing-fetcher.test.ts
git add -f dist/index.js
git commit -m "feat: reject implausible and off-anchor prices before caching them (#91)"
```

---

## Task 4: Make `findPricing`'s fuzzy match ordering-independent

**Files:**
- Modify: `src/data/cost-calculator.ts:67-83`
- Test: `src/__tests__/cost-calculator.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `findPricing(model, table)` unchanged in signature; the fuzzy branch now returns the longest matching key, ties broken lexicographically.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cost-calculator.test.ts`:

```ts
describe("findPricing fuzzy tie-break (#91)", () => {
  const alias: ModelPricing = {
    inputCostPerToken: 15 / 1_000_000,
    outputCostPerToken: 75 / 1_000_000,
    cacheCreationCostPerToken: 18.75 / 1_000_000,
    cacheReadCostPerToken: 1.5 / 1_000_000,
  };
  const specific: ModelPricing = {
    inputCostPerToken: 5 / 1_000_000,
    outputCostPerToken: 25 / 1_000_000,
    cacheCreationCostPerToken: 6.25 / 1_000_000,
    cacheReadCostPerToken: 0.5 / 1_000_000,
  };

  const MODEL = "claude-opus-4-5-20251101-v1:0";

  // Both keys substring-match the model. First-match-wins made the answer a
  // function of upstream key ordering: one bare alias added to the feed ahead
  // of the dated key charged a 4.5 session at 4.x rates, a 3x overcharge.
  it("picks the same price regardless of key insertion order", () => {
    const aliasFirst: PricingTable = {
      "claude-opus-4": alias,
      "claude-opus-4-5-20251101": specific,
    };
    const specificFirst: PricingTable = {
      "claude-opus-4-5-20251101": specific,
      "claude-opus-4": alias,
    };

    expect(findPricing(MODEL, aliasFirst)).toEqual(findPricing(MODEL, specificFirst));
  });

  it("resolves to the more specific key, not the bare alias", () => {
    const table: PricingTable = {
      "claude-opus-4": alias,
      "claude-opus-4-5-20251101": specific,
    };

    expect(findPricing(MODEL, table)!.inputCostPerToken).toBe(5 / 1_000_000);
  });

  it("still prefers an exact match over any fuzzy candidate", () => {
    const table: PricingTable = {
      "claude-opus-4-5-20251101-v1:0-extra-long-key": alias,
      [MODEL]: specific,
    };

    expect(findPricing(MODEL, table)).toBe(specific);
  });

  it("returns null when nothing matches", () => {
    expect(findPricing("gpt-4", { "claude-opus-4": alias })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/cost-calculator.test.ts`
Expected: FAIL — the ordering and specificity cases return the alias price for `aliasFirst`.

- [ ] **Step 3: Rewrite the fuzzy branch**

In `src/data/cost-calculator.ts`, replace the fuzzy loop and its comment (currently lines 75-82) with:

```ts
  // Fuzzy match, longest key wins, lexicographic on ties. First-match-wins
  // made the result a function of the upstream table's key ordering (#91):
  // a bare "claude-opus-4" alias appearing before "claude-opus-4-5-20251101"
  // priced a 4.5 session at 4.x rates. Length is the proxy for specificity —
  // the dated key is always the longer one.
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (!key.includes(model) && !model.includes(key)) continue;
    if (
      best === null ||
      key.length > best.length ||
      (key.length === best.length && key < best)
    ) {
      best = key;
    }
  }

  return best === null ? null : table[best]!;
```

Delete the trailing `return null;` that followed the old loop.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/cost-calculator.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Break what the test guards**

Change `key.length > best.length` to `false`. Re-run: the ordering and specificity cases go RED. Restore and confirm green.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/data/cost-calculator.ts src/__tests__/cost-calculator.test.ts
git add -f dist/index.js
git commit -m "fix: make findPricing's fuzzy match independent of upstream key order (#91)"
```

---

## Task 5: Validate the statusline and turn-count caches

**Files:**
- Modify: `src/cache/cache-manager.ts`, `src/data/turn-tracker.ts`
- Test: `src/__tests__/cache-validation.test.ts` (create)

**Interfaces:**
- Consumes: `readJsonValidated` from Task 1.
- Produces: no signature changes to `checkCache`, `writeCache`, or `trackTurn`.

This task fixes the reproduced blank-bar defect: `turn-count.json` containing `null` made `trackTurn` throw, and the statusline rendered nothing at all.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/cache-validation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache, writeCache } from "../cache/cache-manager.js";
import { trackTurn } from "../data/turn-tracker.js";

/**
 * Every cache file used to be read with `JSON.parse(raw) as SomeType`, a cast
 * that checks nothing at runtime (#92). Verified against the shipped bundle
 * before this change: a turn-count.json containing the four bytes "null"
 * produced an empty statusline and exit 0 — the whole bar, gone.
 */

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cachevalid-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, contents: string): void {
  fs.writeFileSync(path.join(tmpDir, "gccusage", name), contents);
}

function read(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, "gccusage", name), "utf-8"));
}

describe("statusline cache validation", () => {
  const HOUR = 3_600_000;

  it("serves a well-formed entry", () => {
    writeCache("bar-output", "s1", 1.25, 120);
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBe("bar-output");
  });

  it("discards an entry whose output is not a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: 42, timestamp: Date.now(), sessionId: "s1", costUsd: 1.25, terminalWidth: 120 }),
    );
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards an entry whose timestamp is a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: "x", timestamp: String(Date.now()), sessionId: "s1", costUsd: 1.25, terminalWidth: 120 }),
    );
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards a bare null document", () => {
    write("statusline-cache.json", "null");
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });

  it("discards a torn file", () => {
    write("statusline-cache.json", '{"output": "x", "timest');
    expect(checkCache(HOUR, "s1", 1.25, 120)).toBeNull();
  });
});

describe("turn counter validation", () => {
  it("counts up across calls in one session", () => {
    expect(trackTurn("s1")).toBe(1);
    expect(trackTurn("s1")).toBe(2);
  });

  // The reproduced blank-bar defect.
  it("rebuilds from a bare null document instead of throwing", () => {
    write("turn-count.json", "null");
    expect(trackTurn("s1")).toBe(1);
  });

  it("rebuilds when count is not a number", () => {
    write("turn-count.json", JSON.stringify({ sessionId: "s1", count: "7" }));
    expect(trackTurn("s1")).toBe(1);
    expect(read("turn-count.json")).toEqual({ sessionId: "s1", count: 1 });
  });

  it("rebuilds from a torn file", () => {
    write("turn-count.json", '{"sessionId": "s1", "cou');
    expect(trackTurn("s1")).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/cache-validation.test.ts`
Expected: FAIL. In particular `rebuilds from a bare null document instead of throwing` fails with a `TypeError` reading `sessionId` of `null`, and `rebuilds when count is not a number` returns `"7"`-derived nonsense (`NaN`) rather than `1`.

- [ ] **Step 3: Validate in `cache-manager.ts`**

Replace the imports and `checkCache` body in `src/cache/cache-manager.ts`. `writeCache` and the `CacheEntry` interface stay exactly as they are; `node:fs` is no longer needed by this module.

```ts
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
```

Add the schema below the `CacheEntry` interface:

```ts
// The cast this replaces checked nothing at runtime (#92). JSON cannot encode
// NaN or Infinity, so v.number() is sufficient at this boundary.
const CacheEntrySchema = v.object({
  output: v.string(),
  timestamp: v.number(),
  sessionId: v.optional(v.string()),
  costUsd: v.optional(v.number()),
  terminalWidth: v.optional(v.number()),
});
```

Replace the body of `checkCache` (keeping every existing comment on the three key checks verbatim):

```ts
  const entry = readJsonValidated(getCachePath(), CacheEntrySchema);
  if (!entry) return null;

  // Require exact session match (both undefined also matches)
  if (entry.sessionId !== sessionId) return null;

  // A changed cumulative cost means fresh spend that daily accounting
  // must record via the full pipeline — never serve the cache across it.
  if (entry.costUsd !== costUsd) return null;

  // Layout depends on terminal width (compact.mode: "auto" collapses the
  // bar below a threshold), so a cached entry laid out for a different
  // width is wrong output, not just stale — a resize must miss even
  // though session and cost are unchanged. Exact match (both undefined
  // also matches) mirrors the cost check above.
  if (entry.terminalWidth !== terminalWidth) return null;

  // TTL check
  if (Date.now() - entry.timestamp > ttlMs) return null;

  return entry.output;
```

The `try`/`catch` and the `fs.existsSync` guard both go away — `readJsonValidated` absorbs them.

- [ ] **Step 4: Validate in `turn-tracker.ts`**

Replace the imports and `trackTurn` body in `src/data/turn-tracker.ts`. `node:fs` is no longer needed.

```ts
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";

interface TurnData {
  sessionId: string;
  count: number;
}

// `JSON.parse("null")` succeeds and yields null, which the old `as TurnData`
// cast then dereferenced outside the try block — throwing, and blanking the
// entire statusline over a four-byte cache file (#92).
const TurnDataSchema = v.object({
  sessionId: v.string(),
  count: v.number(),
});
```

Body of `trackTurn`, replacing the `try`/`catch` block:

```ts
  const filePath = getTurnPath();
  let data: TurnData = readJsonValidated(filePath, TurnDataSchema) ?? {
    sessionId: "",
    count: 0,
  };

  // Reset if different session
  if (data.sessionId !== sessionId) {
    data = { sessionId, count: 0 };
  }
```

Everything from `data.count++;` onward — including the no-lock comment — stays unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/cache-validation.test.ts src/__tests__/cache-manager.test.ts src/__tests__/statusline.test.ts`
Expected: PASS, including every pre-existing case in the other two files.

- [ ] **Step 6: Break what the test guards**

In `turn-tracker.ts`, change the schema's `count` to `v.unknown()`. Re-run: `rebuilds when count is not a number` goes RED. Restore. In `cache-manager.ts`, change `output: v.string()` to `output: v.unknown()`. Re-run: the non-string-output case goes RED. Restore and confirm green.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/cache/cache-manager.ts src/data/turn-tracker.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "fix: validate the statusline and turn-count caches on read (#92)

A turn-count.json containing the four bytes \"null\" made trackTurn throw and
rendered an empty statusline."
```

---

## Task 6: Validate the daily cost shards and the legacy store

**Files:**
- Modify: `src/data/daily-cost-tracker.ts`
- Test: `src/__tests__/cache-validation.test.ts` (extend)

**Interfaces:**
- Consumes: `readJsonValidated` from Task 1.
- Produces: `trackDailyCost(sessionId, costUsd, source, now?)` unchanged in signature. `SessionCostEntry` becomes `v.InferOutput<typeof ShardSchema>` — same shape, one source of truth.

Behaviour must not change for well-formed files. The existing tolerances (`baselineUsd` → `0`, missing `updatedAt` → `0`, absent `source` → legacy) are preserved via `v.fallback`.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cache-validation.test.ts`:

```ts
import { trackDailyCost } from "../data/daily-cost-tracker.js";

describe("daily cost shard validation", () => {
  function writeShard(sessionId: string, contents: unknown): void {
    const dir = path.join(tmpDir, "gccusage", "daily");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify(contents));
  }

  const NOW = new Date("2026-08-02T12:00:00");
  const TODAY = "2026-08-02";

  it("totals a well-formed shard from another session", () => {
    writeShard("other", {
      sessionId: "other",
      date: TODAY,
      costUsd: 2,
      baselineUsd: 0,
      source: "stdin",
      updatedAt: NOW.getTime(),
    });

    expect(trackDailyCost("mine", 1, "stdin", NOW)).toBeCloseTo(3);
  });

  // The shape that would put NaN on the bar: right keys, wrong types.
  it("skips a shard whose costUsd is a string", () => {
    writeShard("other", {
      sessionId: "other",
      date: TODAY,
      costUsd: "2.00",
      baselineUsd: 0,
      source: "stdin",
      updatedAt: NOW.getTime(),
    });

    const total = trackDailyCost("mine", 1, "stdin", NOW);
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBeCloseTo(1);
  });

  it("skips a bare null shard", () => {
    writeShard("other", null);
    expect(trackDailyCost("mine", 1, "stdin", NOW)).toBeCloseTo(1);
  });

  it("treats a shard with a non-numeric baseline as having none", () => {
    writeShard("other", {
      sessionId: "other",
      date: TODAY,
      costUsd: 2,
      baselineUsd: "nope",
      source: "stdin",
      updatedAt: NOW.getTime(),
    });

    expect(trackDailyCost("mine", 1, "stdin", NOW)).toBeCloseTo(3);
  });

  it("ignores a shard carrying an unrecognised source", () => {
    writeShard("mine", {
      sessionId: "mine",
      date: TODAY,
      costUsd: 5,
      baselineUsd: 0,
      source: "telepathy",
      updatedAt: NOW.getTime(),
    });

    // Unrecognised source is treated as absent, i.e. a legacy file: no
    // source-switch re-baseline, so the rise from 5 to 6 counts normally.
    const total = trackDailyCost("mine", 6, "stdin", NOW);
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBeCloseTo(6);
  });

  it("migrates a legacy store and drops its malformed entries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "gccusage", "daily-costs.json"),
      JSON.stringify({
        date: TODAY,
        sessions: [
          { sessionId: "good", costUsd: 2, baselineUsd: 0, updatedAt: NOW.getTime() },
          { sessionId: "bad", costUsd: "2", baselineUsd: 0, updatedAt: NOW.getTime() },
          null,
        ],
      }),
    );

    const total = trackDailyCost("mine", 1, "stdin", NOW);
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBeCloseTo(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/cache-validation.test.ts`
Expected: FAIL — `skips a shard whose costUsd is a string` and the legacy-migration case produce `NaN` or a wrong total, and the non-numeric-baseline case is already handled but must stay green.

- [ ] **Step 3: Replace the hand-rolled checks with schemas**

In `src/data/daily-cost-tracker.ts`, add `import * as v from "valibot";` and add `readJsonValidated` to the existing `../utils/atomic-json.js` import.

Replace the `SessionCostEntry` interface and the `LegacyEntry` interface with schemas. Derive the type from the schema so the two cannot drift:

```ts
export type CostSource = "stdin" | "calculated";

const CostSourceSchema = v.picklist(["stdin", "calculated"]);

/**
 * The shard schema replaces four hand-rolled `typeof` checks scattered through
 * this file (#92). `v.fallback` preserves each tolerance exactly: a shard
 * written before `baselineUsd` existed reads as 0, and one with no `updatedAt`
 * reads as 0 and is therefore pruned as stale, which is what the old
 * `entry.updatedAt ?? 0` did.
 */
const ShardSchema = v.object({
  sessionId: v.string(),
  date: v.string(), // local date the baseline belongs to
  costUsd: v.number(), // latest cumulative session cost
  baselineUsd: v.fallback(v.number(), 0), // cumulative cost at the start of `date`
  // Absent in legacy files, and an unrecognised value is treated the same way.
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.number(), 0),
});

type SessionCostEntry = v.InferOutput<typeof ShardSchema>;

const LegacyStoreSchema = v.object({
  date: v.fallback(v.optional(v.string()), undefined),
  sessions: v.fallback(v.array(v.unknown()), []),
});

const LegacyEntrySchema = v.object({
  sessionId: v.string(),
  costUsd: v.number(),
  baselineUsd: v.fallback(v.number(), 0),
  source: v.fallback(v.optional(CostSourceSchema), undefined),
  updatedAt: v.fallback(v.optional(v.number()), undefined),
});
```

Rewrite the body of `migrateLegacyStore`, keeping its doc comment. The `existsSync` guard is what preserves "no legacy file → return early" while still deleting an unparseable one:

```ts
  const legacyPath = getLegacyPath();
  if (!fs.existsSync(legacyPath)) return; // The common case.

  // A null result here means the file exists but carries nothing usable.
  // Fall through so it still gets deleted — retrying cannot help.
  const legacy = readJsonValidated(legacyPath, LegacyStoreSchema);
  const sessions = legacy?.sessions ?? [];
  const date = legacy?.date ?? dateStr(now);

  try {
    for (const raw of sessions) {
      const parsed = v.safeParse(LegacyEntrySchema, raw);
      if (!parsed.success) continue;
      const s = parsed.output;

      const target = shardPath(s.sessionId);
      // A shard already written by the new code is newer than the legacy file.
      if (fs.existsSync(target)) continue;

      const entry: SessionCostEntry = {
        sessionId: s.sessionId,
        date,
        costUsd: s.costUsd,
        baselineUsd: s.baselineUsd,
        source: s.source,
        updatedAt: s.updatedAt ?? now.getTime(),
      };
      writeJsonAtomic(target, entry);
    }
  } catch {
    // A shard write failed (disk full, permissions). Sessions after the failure
    // exist only in the legacy file, so keep it and retry on the next render —
    // deleting it here would drop their spend for the rest of the day. Already
    // migrated sessions are skipped by the existsSync check above.
    return;
  }

  try {
    fs.unlinkSync(legacyPath);
  } catch {
    // Already gone (a concurrent migration got there first).
  }
```

In `readEntries`, replace the per-shard `try`/`JSON.parse`/`typeof` block (currently lines 136-157) with:

```ts
    const entry = readJsonValidated(fullPath, ShardSchema);
    if (!entry) continue; // Unreadable shard: one session's data, not the whole day.

    if (now.getTime() - entry.updatedAt >= STALE_SESSION_MS) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Pruning is best effort; a stale entry contributes nothing anyway.
      }
      continue;
    }

    entries.push(entry);
```

The `?? 0` on `updatedAt` and the `baselineUsd` spread patch both go away — the schema fallbacks cover them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/cache-validation.test.ts src/__tests__/daily-cost-tracker.test.ts src/__tests__/pipeline.test.ts`
Expected: PASS. Every pre-existing case in `daily-cost-tracker.test.ts` must stay green — that file covers the restart, source-switch and midnight-rollover accounting rules, and none of them should shift.

- [ ] **Step 5: Break what the test guards**

Change `costUsd: v.number()` to `costUsd: v.unknown()` in `ShardSchema`. Re-run: `skips a shard whose costUsd is a string` goes RED with a `NaN` total. Restore. Change `LegacyEntrySchema`'s `costUsd` the same way. Re-run: the migration case goes RED. Restore and confirm green.

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/data/daily-cost-tracker.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "fix: validate daily cost shards and the legacy store on read (#92)"
```

---

## Task 7: Validate the pricing cache, per entry

**Files:**
- Modify: `src/cache/pricing-cache.ts`
- Test: `src/__tests__/cache-validation.test.ts` (extend)

**Interfaces:**
- Consumes: `readJsonValidated` (Task 1), `sanitisePricingTable` (Task 2).
- Produces: `loadPricingCacheEntry()` and `loadPricingCache(ttlMs)` unchanged in signature. Both now return `null` when nothing in the cached table survives bounds.

This is the one reader that does not discard whole-file on a bad value: a corrupted price drops one model. The **anchor is deliberately not re-run here** — see the spec's "one exception" section.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cache-validation.test.ts`:

```ts
import { loadPricingCacheEntry } from "../cache/pricing-cache.js";

describe("pricing cache validation", () => {
  const SANE = {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  };

  function writePricing(data: unknown, ageMs = 0): void {
    write("pricing.json", JSON.stringify({ timestamp: Date.now() - ageMs, data }));
  }

  it("loads a well-formed table", () => {
    writePricing({ "claude-x": SANE });
    expect(loadPricingCacheEntry()!.data["claude-x"]).toEqual(SANE);
  });

  it("drops a corrupted entry and keeps the rest of the table", () => {
    writePricing({
      "claude-x": SANE,
      "claude-broken": { ...SANE, inputCostPerToken: "3e-6" },
    });

    const entry = loadPricingCacheEntry()!;
    expect(entry.data["claude-x"]).toEqual(SANE);
    expect(entry.data["claude-broken"]).toBeUndefined();
  });

  it("returns null when the timestamp is not a number", () => {
    write("pricing.json", JSON.stringify({ timestamp: "now", data: { "claude-x": SANE } }));
    expect(loadPricingCacheEntry()).toBeNull();
  });

  it("returns null when nothing in the table survives", () => {
    writePricing({ "claude-broken": { inputCostPerToken: -1 } });
    expect(loadPricingCacheEntry()).toBeNull();
  });

  it("returns null for a bare null document", () => {
    write("pricing.json", "null");
    expect(loadPricingCacheEntry()).toBeNull();
  });

  // The anchor is a fetch-time check, not a read-time one: a price legitimately
  // cached before the snapshot was regenerated must still load.
  it("does not re-anchor cached entries against the snapshot", () => {
    writePricing({ "claude-haiku-4-5": SANE });
    expect(loadPricingCacheEntry()!.data["claude-haiku-4-5"]).toEqual(SANE);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/cache-validation.test.ts`
Expected: FAIL — the corrupted entry is returned intact, and the all-broken table yields an entry rather than `null`.

- [ ] **Step 3: Validate on read**

Rewrite the top of `src/cache/pricing-cache.ts`:

```ts
import * as path from "node:path";
import * as v from "valibot";
import { getCacheDir } from "../utils/paths.js";
import { readJsonValidated, writeJsonAtomic } from "../utils/atomic-json.js";
import { sanitisePricingTable } from "../data/pricing-validation.js";
import type { PricingTable } from "../types/pricing.js";

interface PricingCacheFile {
  timestamp: number;
  data: PricingTable;
}

// The envelope is validated as a whole; `data` is left as unknown values and
// filtered per entry below, so one corrupted price drops one model rather than
// the whole table (#92).
const PricingCacheSchema = v.object({
  timestamp: v.number(),
  data: v.record(v.string(), v.unknown()),
});
```

`node:fs` is no longer needed by this module. Replace the body of `loadPricingCacheEntry`, keeping its doc comment:

```ts
  const cache = readJsonValidated(getCachePath(), PricingCacheSchema);
  if (!cache) return null;

  // Bounds only, never the snapshot anchor: the anchor is about trusting the
  // feed, these entries already passed it at write time, and re-running it
  // would silently invalidate a legitimately cached price the day someone
  // regenerates the snapshot after a real price move.
  const data = sanitisePricingTable(cache.data);
  if (Object.keys(data).length === 0) return null;

  return { data, ageMs: Date.now() - cache.timestamp };
```

`loadPricingCache` and `savePricingCache` stay unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/__tests__/cache-validation.test.ts src/__tests__/pricing-fetcher.test.ts src/__tests__/pricing-render-path.test.ts src/__tests__/offline-render.test.ts`
Expected: PASS across all four files.

- [ ] **Step 5: Check for an import cycle**

`pricing-cache.ts` now imports `pricing-validation.ts`, which imports `fallback-pricing.ts` (types only) — and `pricing-fetcher.ts` imports both. No cycle, but confirm the bundle builds and runs:

```bash
npm run build
echo '{"session_id":"cycle-check","model":{"id":"claude-opus-4-5","display_name":"Opus"},"cost":{"total_cost_usd":1.5}}' | node dist/index.js
```
Expected: a rendered bar, not an empty line.

- [ ] **Step 6: Break what the test guards**

Change `sanitisePricingTable(cache.data)` to `cache.data as PricingTable`. Re-run: the corrupted-entry and nothing-survives cases go RED. Restore and confirm green.

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
npm run build
git add src/cache/pricing-cache.ts src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "fix: validate the pricing cache envelope and bound its entries (#92)"
```

---

## Task 8: End-to-end — no `NaN` reaches the bar

**Files:**
- Test: `src/__tests__/cache-validation.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Tasks 5-7.
- Produces: nothing. This is #92's stated acceptance criterion, asserted against the real render path.

The per-reader tests above prove each boundary discards bad input. This proves the composition: every cache file hostile at once, and the bar still renders correct output.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/cache-validation.test.ts`. The `vi.mock` call must sit at the top of the file with the other imports — vitest hoists it, so placing it here in the plan is for readability only.

The mock is file-wide, so it also applies to the Task 5-7 cases already in this file. That is safe: `cache-manager.ts`, `turn-tracker.ts`, `daily-cost-tracker.ts` and `pricing-cache.ts` none of them import `pricing-fetcher.js`. Re-run the whole file after adding it and confirm the earlier cases stay green.

```ts
// At the top of the file, alongside the existing imports:
import { vi } from "vitest";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

// Pricing normally comes from the network. Pin it so the render is
// deterministic; every other boundary (transcripts, the daily store, the
// caches under test) runs for real against the temp HOME/cache.
const PINNED_PRICING = {
  "claude-opus-4-5": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  // stale: false on purpose — true would spawn a real detached refresher.
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));
```

Then append the describe block. Note this needs `HOME` set as well as `XDG_CACHE_HOME`, per the house hermetic pattern — extend the existing `beforeEach`/`afterEach` to save, set and restore `process.env["HOME"]` to `tmpDir` too.

```ts
describe("no NaN survives a hostile cache directory (#92)", () => {
  it("renders a correct bar with every cache file corrupted", async () => {
    const stdin = {
      session_id: "hostile",
      model: { id: "claude-opus-4-5", display_name: "Opus" },
      cost: { total_cost_usd: 1.5 },
    };

    write("turn-count.json", "null");
    write("statusline-cache.json", JSON.stringify({ output: 42, timestamp: "soon" }));
    write("pricing.json", JSON.stringify({ timestamp: "soon", data: null }));
    fs.mkdirSync(path.join(tmpDir, "gccusage", "daily"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "gccusage", "daily", "ghost.json"),
      JSON.stringify({ sessionId: "ghost", date: "2026-08-02", costUsd: "9.99" }),
    );

    const output = await runStatusline(stdin, DEFAULT_SETTINGS);

    expect(output).not.toContain("NaN");
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("Infinity");
    // The real session cost still renders — degrading is not the same as
    // rendering nothing, which is what the null turn-count used to do.
    expect(output).toContain("$1.50");
    expect(output.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/__tests__/cache-validation.test.ts`
Expected: PASS — Tasks 5-7 already fixed every reader this exercises.

If it FAILS, that is a genuine finding: a boundary the per-reader tests missed. Debug it rather than weakening the assertion.

- [ ] **Step 3: Confirm the test is not vacuous**

This test passes without any new code being written in this task, so it must be shown to have teeth. In `src/data/turn-tracker.ts`, temporarily restore the old cast:

```ts
  let data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as TurnData;
```

Re-run. Expected: RED — the bar is empty and `$1.50` is absent, reproducing the original defect through the real render path. Restore and confirm green.

Repeat with `daily-cost-tracker.ts`'s `ShardSchema.costUsd` set to `v.unknown()`. Expected: RED on the `NaN` assertion. Restore and confirm green.

- [ ] **Step 4: Verify against the shipped bundle**

The in-process test proves the source. This proves what ships:

```bash
npm run build
D=$(mktemp -d) && mkdir -p "$D/gccusage"
echo 'null' > "$D/gccusage/turn-count.json"
echo '{"session_id":"abc","model":{"id":"claude-opus-4-5","display_name":"Opus"},"cost":{"total_cost_usd":1.5}}' \
  | XDG_CACHE_HOME="$D" node dist/index.js
```
Expected: a rendered bar containing `$1.50`. Before this plan, the same command produced empty output and exit 0.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm run typecheck:scripts && npm test
git add src/__tests__/cache-validation.test.ts
git add -f dist/index.js
git commit -m "test: assert no NaN reaches the bar from a hostile cache directory (#92)"
```

---

## Task 9: Ledger, branch, and PR

**Files:**
- Modify: `AUDIT.md` (local only — never staged)

- [ ] **Step 1: Confirm the full suite and a clean bundle**

```bash
npm run typecheck && npm run typecheck:scripts && npm test && npm run build
git status --short
```
Expected: tests green; `git status` shows only `?? AUDIT.md`. Any modification to `dist/index.js` at this point means a commit shipped a stale bundle — amend it before opening the PR.

- [ ] **Step 2: Update the local ledger**

Add two rows to the remediation log table in `AUDIT.md`, matching the existing format:

```markdown
| 2026-08-02 | SEC-001 | #91 | Closed by PR #NNN — pricing bounded (finite, input > 0, <= $1000/Mtok) inside `parseLitellmPricing`, and anchored to `FALLBACK_PRICING` (0.1x-10x) at the fetch boundary; rejection is per entry so one poisoned model falls through to the snapshot. `findPricing`'s fuzzy branch is now longest-key-wins, so upstream key ordering cannot swap a price. **Deliberately not done**: pinning `LITELLM_URL` to a commit SHA — it would freeze prices and make `refreshPricing` re-fetch an immutable file. **Accepted risk**: a legitimate >10x price move is ignored until `npm run pricing` regenerates the snapshot |
| 2026-08-02 | SEC-002 | #92 | Closed by PR #NNN — `readJsonValidated` in `atomic-json.ts` makes that module the single read-validate-write owner; a valibot schema per cache file, colocated with its owning module. Found and fixed a live defect the issue only implied: `turn-count.json` containing the four bytes `null` made `trackTurn` dereference `null` **outside** its try block, blanking the entire statusline (empty output, exit 0). The pricing cache is the one per-entry exception — bounds on read, never the anchor, which would invalidate legitimately cached prices whenever the snapshot is regenerated |
```

Replace `#NNN` with the real PR number once it exists.

- [ ] **Step 3: Push the branch and open the PR**

The work so far is on `main`. Move it to a branch first — this repo opens a PR per finding group.

```bash
git branch fix/cache-and-pricing-validation
git reset --hard origin/main
git checkout fix/cache-and-pricing-validation
git push -u origin fix/cache-and-pricing-validation
```

Then open the PR with `gh pr create`, body covering: what each issue was, the two-part fix, the reproduced blank-bar defect with its before/after command output, the deliberate non-goal (no URL pin) and the accepted risk (>10x price move), and `Closes #91` / `Closes #92`. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 4: Confirm CI is green**

Run: `gh pr checks --watch`
Expected: all jobs pass, including `bundle-drift` — a red `bundle-drift` means a commit staged source without its rebuilt `dist/index.js`.
