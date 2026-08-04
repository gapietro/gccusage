import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache, writeCache } from "../cache/cache-manager.js";
import { computeCacheKey } from "../cache/cache-key.js";
import { trackDailyCost } from "../data/daily-cost-tracker.js";
import { loadPricingCacheEntry, savePricingCache, PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";
import { loadBlockCache } from "../cache/block-cache.js";
import { runStatusline } from "../statusline.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { getTerminalWidth } from "../utils/terminal.js";

// Pricing normally comes from the network. Pin it so the render is
// deterministic; every other boundary (transcripts, the daily store, the
// caches under test) runs for real against the temp HOME/cache.
const PINNED_PRICING = {
  "claude-opus-4-5": {
    inputCostPerToken: 1 / 1_000_000,
    outputCostPerToken: 0,
    cacheCreationCostPerToken: 0,
    cacheCreation1hCostPerToken: 2 / 1_000_000,
    cacheReadCostPerToken: 0,
  },
};

vi.mock("../data/pricing-fetcher.js", () => ({
  fetchPricing: vi.fn(async () => PINNED_PRICING),
  // stale: false on purpose — true would spawn a real detached refresher.
  getPricingForRender: vi.fn(() => ({ pricing: PINNED_PRICING, stale: false })),
}));

/**
 * Every cache file used to be read with `JSON.parse(raw) as SomeType`, a cast
 * that checks nothing at runtime (#92). Verified against the shipped bundle
 * before this change: a turn-count.json containing the four bytes "null"
 * produced an empty statusline and exit 0 — the whole bar, gone.
 */

let tmpDir: string;
let originalXdg: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cachevalid-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "gccusage"), { recursive: true });
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
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
    writeCache("bar-output", "k1");
    expect(checkCache(HOUR, "k1")).toBe("bar-output");
  });

  it("discards an entry whose output is not a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: 42, timestamp: Date.now(), key: "k1" }),
    );
    expect(checkCache(HOUR, "k1")).toBeNull();
  });

  it("discards an entry whose timestamp is a string", () => {
    write(
      "statusline-cache.json",
      JSON.stringify({ output: "x", timestamp: String(Date.now()), key: "k1" }),
    );
    expect(checkCache(HOUR, "k1")).toBeNull();
  });

  it("discards a bare null document", () => {
    write("statusline-cache.json", "null");
    expect(checkCache(HOUR, "k1")).toBeNull();
  });

  it("discards a torn file", () => {
    write("statusline-cache.json", '{"output": "x", "timest');
    expect(checkCache(HOUR, "k1")).toBeNull();
  });
});

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

    // Assert on what migration itself wrote to disk, not just the end-to-end
    // total: the malformed entry must never be migrated to a shard at all,
    // not merely excluded later by a second, independent validation pass.
    expect(fs.existsSync(path.join(tmpDir, "gccusage", "daily", "bad.json"))).toBe(false);
  });

  // root bypasses permission bits entirely, which would make this vacuous.
  const isRoot = process.getuid?.() === 0;

  (isRoot ? it.skip : it)(
    "keeps an unreadable legacy store in place instead of deleting it",
    () => {
      const legacyPath = path.join(tmpDir, "gccusage", "daily-costs.json");
      fs.writeFileSync(
        legacyPath,
        JSON.stringify({
          date: TODAY,
          sessions: [{ sessionId: "good", costUsd: 2, baselineUsd: 0, updatedAt: NOW.getTime() }],
        }),
      );
      fs.chmodSync(legacyPath, 0o000);

      try {
        // A transient read failure (EACCES here) must not be treated the
        // same as malformed JSON: unlike a genuinely unparseable file,
        // retrying an unreadable one might succeed later, so it must survive
        // this call rather than be migrated-and-deleted.
        trackDailyCost("mine", 1, "stdin", NOW);
        expect(fs.existsSync(legacyPath)).toBe(true);
      } finally {
        // Restore permissions so tmpdir cleanup in afterEach can't fail —
        // guarded because the behaviour under test governs whether the file
        // still exists to chmod back.
        if (fs.existsSync(legacyPath)) fs.chmodSync(legacyPath, 0o644);
      }
    },
  );
});

describe("pricing cache validation", () => {
  const SANE = {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheCreation1hCostPerToken: 6 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  };

  function writePricing(data: unknown, ageMs = 0): void {
    write(
      "pricing.json",
      JSON.stringify({ version: PRICING_CACHE_VERSION, timestamp: Date.now() - ageMs, data }),
    );
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
    write(
      "pricing.json",
      JSON.stringify({
        version: PRICING_CACHE_VERSION,
        timestamp: "now",
        data: { "claude-x": SANE },
      }),
    );
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
  //
  // This fixture must sit OUTSIDE anchorToSnapshot's [1/10, 10] deviation band
  // around FALLBACK_PRICING's "claude-haiku-4-5" entry (inputCostPerToken
  // 1e-6), not inside it: an in-band value passes through anchorToSnapshot
  // unchanged (src/data/pricing-validation.ts, "if within deviation, pass
  // through"), so the test would go on passing even if the anchor were
  // mistakenly wired into the read path. ANCHOR_OUTLIER is ~20x the snapshot
  // on every field — the anchor would drop it, this test would not — while
  // staying far under MAX_COST_PER_TOKEN (1e-3) so it still clears
  // sanitisePricingTable's bounds check on its own. Do not "simplify" these
  // back toward SANE.
  const ANCHOR_OUTLIER = {
    inputCostPerToken: 20e-6,
    outputCostPerToken: 100e-6,
    cacheCreationCostPerToken: 25e-6,
    cacheCreation1hCostPerToken: 40e-6,
    cacheReadCostPerToken: 2e-6,
  };

  it("does not re-anchor cached entries against the snapshot", () => {
    writePricing({ "claude-haiku-4-5": ANCHOR_OUTLIER });
    expect(loadPricingCacheEntry()!.data["claude-haiku-4-5"]).toEqual(ANCHOR_OUTLIER);
  });
});

// A pre-tier cache carries no version at all. #103 added the above-200k tier
// to every parser and to FALLBACK_PRICING; a pre-version file merged whole
// over that snapshot would shadow the new tier for up to the cache's full TTL
// (24h default) — the exact under-count #103 exists to fix, silently
// reintroduced by upgrading. Rejecting on read degrades to FALLBACK_PRICING,
// which now HAS the tiers, so the degradation is strictly better than the
// shadow it replaces.
describe("pricing cache version validation", () => {
  const SANE = {
    inputCostPerToken: 3 / 1_000_000,
    outputCostPerToken: 15 / 1_000_000,
    cacheCreationCostPerToken: 3.75 / 1_000_000,
    cacheCreation1hCostPerToken: 6 / 1_000_000,
    cacheReadCostPerToken: 0.3 / 1_000_000,
  };

  // The load-bearing assertion: a cache file in the shape written by the OLD
  // parser (no `version` field at all) must be rejected, not merely ignored.
  it("rejects a pre-version cache file", () => {
    write("pricing.json", JSON.stringify({ timestamp: Date.now(), data: { "claude-x": SANE } }));
    expect(loadPricingCacheEntry()).toBeNull();
  });

  it("rejects a cache file whose version does not match", () => {
    write(
      "pricing.json",
      JSON.stringify({
        version: PRICING_CACHE_VERSION + 1,
        timestamp: Date.now(),
        data: { "claude-x": SANE },
      }),
    );
    expect(loadPricingCacheEntry()).toBeNull();
  });

  it("round-trips through savePricingCache", () => {
    savePricingCache({ "claude-x": SANE });
    const entry = loadPricingCacheEntry();
    expect(entry).not.toBeNull();
    expect(entry!.data["claude-x"]).toEqual(SANE);
  });

  // The existing "version does not match" test uses PRICING_CACHE_VERSION + 1,
  // which is version-RELATIVE: it keeps passing after any bump without ever
  // proving the bump did its job. This pins the literal old version.
  //
  // The entry is deliberately given cacheCreation1hCostPerToken — a shape
  // COST_KEYS bounds would accept on its own — so the only thing that can
  // reject this fixture is the envelope's version literal. Without that field
  // the bounds check rejects the entry independently of the envelope, and
  // reverting PRICING_CACHE_VERSION to 1 would no longer turn this test red
  // (confirmed: that was the exact vacuity found in the first pass). A
  // realistic pre-#118 file — entry missing the field, as an old parser would
  // actually have written — is still rejected by BOTH layers; that
  // belt-and-suspenders behavior is what made the original fixture blind to
  // this specific mutation.
  it("rejects a v1 cache envelope even when its entries are otherwise valid", () => {
    write(
      "pricing.json",
      JSON.stringify({
        version: 1,
        timestamp: Date.now(),
        data: {
          "claude-opus-5": {
            inputCostPerToken: 0.000005,
            outputCostPerToken: 0.000025,
            cacheCreationCostPerToken: 0.00000625,
            cacheCreation1hCostPerToken: 0.00001,
            cacheReadCostPerToken: 0.0000005,
          },
        },
      }),
    );
    expect(loadPricingCacheEntry()).toBeNull();
  });
});

describe("pricing cache tier validation (#103)", () => {
  it("keeps a cached model whose tier is malformed, minus the tier", () => {
    write(
      "pricing.json",
      JSON.stringify({
        version: PRICING_CACHE_VERSION,
        timestamp: Date.now(),
        data: {
          "claude-opus-4-5": {
            inputCostPerToken: 0.000005,
            outputCostPerToken: 0.000025,
            cacheCreationCostPerToken: 0.00000625,
            cacheCreation1hCostPerToken: 0.00001,
            cacheReadCostPerToken: 0.0000005,
            // Premium below standard: not a price.
            above200k: {
              inputCostPerToken: 0.0000001,
              outputCostPerToken: 0.0000002,
              cacheCreationCostPerToken: 0.0000003,
              cacheCreation1hCostPerToken: 0.0000002,
              cacheReadCostPerToken: 0.0000004,
            },
          },
        },
      }),
    );

    const entry = loadPricingCacheEntry();

    expect(entry!.data["claude-opus-4-5"]).toBeDefined();
    expect(entry!.data["claude-opus-4-5"]!.inputCostPerToken).toBe(0.000005);
    expect(entry!.data["claude-opus-4-5"]!.above200k).toBeUndefined();
  });
});

describe("block cache validation", () => {
  function writeBlockCache(contents: string): void {
    const dir = path.join(tmpDir, "gccusage", "blocks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "current.json"), contents);
  }

  it("loads a well-formed cache", () => {
    writeBlockCache(JSON.stringify({ blockStartTime: Date.now() }));
    expect(loadBlockCache()).not.toBeNull();
  });

  // The shape that would put NaN into the block-timer widget's arithmetic:
  // right key, wrong type.
  it("rebuilds when blockStartTime is not a number", () => {
    writeBlockCache(JSON.stringify({ blockStartTime: "not-a-number" }));
    expect(loadBlockCache()).toBeNull();
  });

  it("rebuilds from a bare null document", () => {
    writeBlockCache("null");
    expect(loadBlockCache()).toBeNull();
  });
});

describe("no NaN survives a hostile cache directory (#92)", () => {
  it("renders a correct bar with the turn counter, statusline cache, and daily shard all corrupted", async () => {
    const stdin = {
      session_id: "hostile",
      model: { id: "claude-opus-4-5", display_name: "Opus" },
      cost: { total_cost_usd: 1.5 },
    };

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

    // The key gate in checkCache must clear so only the schema can reject
    // this entry — otherwise the gate rejects it for a reason unrelated to
    // validation and this leg proves nothing (the daily-shard fixture below
    // had exactly that problem before its updatedAt was added). The key is
    // built from this test's own stdin and the real getTerminalWidth(), so
    // it matches whatever this process resolves (undefined under vitest: no
    // TTY, no COLUMNS) instead of a guessed number. `output` and `timestamp`
    // are the wrong-typed fields: a validated reader rejects this envelope
    // outright; the old unchecked cast lets `Date.now() - "soon"` (NaN)
    // through the TTL check — NaN comparisons are always false, so it reads
    // as "not expired" — and serves `output: 42` verbatim in place of the
    // real bar.
    write(
      "statusline-cache.json",
      JSON.stringify({
        output: 42,
        timestamp: "soon",
        key: computeCacheKey(stdin, getTerminalWidth()),
      }),
    );

    // pricing.json is deliberately NOT part of this fixture. The file-wide
    // vi.mock("../data/pricing-fetcher.js", ...) above replaces the module
    // wholesale, and the only caller of loadPricingCacheEntry is that
    // module's getPricingForRender — so a corrupted pricing.json here would
    // never be read by anything runStatusline touches in this test; the
    // write would be dead weight. That boundary is already covered directly
    // by describe("pricing cache validation", ...) above, including the
    // anchor-invariant test — do not re-add it here.
    fs.mkdirSync(path.join(tmpDir, "gccusage", "daily"), { recursive: true });
    // `updatedAt` must be fresh (same clock runStatusline's own `new Date()`
    // uses) or the shard is pruned as stale before its `costUsd` is ever
    // read — masking the sabotage this fixture exists to catch. `date` must
    // match today for the same reason: a shard filed under yesterday never
    // reaches the total. `costUsd` must be a wrong-typed value that does NOT
    // coerce under `-` (unlike "9.99", which silently becomes the number
    // 9.99) — "not-a-number" reaches `Math.max(0, e.costUsd - e.baselineUsd)`
    // as `NaN` exactly when `ShardSchema.costUsd` fails to reject it.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fs.writeFileSync(
      path.join(tmpDir, "gccusage", "daily", "ghost.json"),
      JSON.stringify({ sessionId: "ghost", date: today, costUsd: "not-a-number", updatedAt: now.getTime() }),
    );

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

    expect(output).not.toContain("NaN");
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("Infinity");
    // The real session cost still renders — degrading is not the same as
    // rendering nothing, which is what the null turn-count used to do.
    expect(output).toContain("$1.50");
  });
});
