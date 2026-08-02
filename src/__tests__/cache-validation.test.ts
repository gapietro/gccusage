import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache, writeCache } from "../cache/cache-manager.js";
import { trackTurn } from "../data/turn-tracker.js";
import { trackDailyCost } from "../data/daily-cost-tracker.js";
import { loadPricingCacheEntry } from "../cache/pricing-cache.js";
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
});

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
    cacheReadCostPerToken: 2e-6,
  };

  it("does not re-anchor cached entries against the snapshot", () => {
    writePricing({ "claude-haiku-4-5": ANCHOR_OUTLIER });
    expect(loadPricingCacheEntry()!.data["claude-haiku-4-5"]).toEqual(ANCHOR_OUTLIER);
  });
});

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
