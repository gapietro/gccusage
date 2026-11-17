import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCache } from "../cache/cache-manager.js";
import { loadPricingCache, loadPricingCacheEntry, PRICING_CACHE_VERSION } from "../cache/pricing-cache.js";
import { loadBlockCache } from "../cache/block-cache.js";
import { detectBlock } from "../data/block-tracker.js";
import { getPricingForRender } from "../data/pricing-fetcher.js";
import { BLOCK_DURATION_MS } from "../types/block-metrics.js";

/**
 * COR-006: every cache computes its age as `now - stored`. A stored stamp in
 * the future makes that negative, and a negative age passed every "younger
 * than the TTL" check, so the entry read as fresh — forever, for `1e400`
 * (`JSON.parse` overflows it to `Infinity`) or `9e15`, and until the clock
 * caught up for a clock set backwards or a restored VM snapshot.
 *
 * Every fixture is raw text: `JSON.stringify(Infinity)` is `null`, which the
 * schemas already rejected, so a fixture built through the writer would pass
 * before the fix for the wrong reason (#133).
 *
 * The pricing half of this, where the stale read must also trigger the
 * refresher, lives in pricing-refresh.test.ts beside the spawn mock.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * `1e400` is the overflow, `9e15` a safe integer the schema cannot reject,
 * and the third a plausible clock-set-backwards stamp. Built per call so the
 * +1 day value is relative to the test's own clock.
 */
function untrustedStamps(): [string, string][] {
  return [
    ["1e400", "1e400"],
    ["9e15", "9e15"],
    ["1 day in the future", String(Date.now() + DAY)],
  ];
}

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-stamps-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "gccusage", "blocks"), { recursive: true });
  // The render-path pricing read must never fetch (#84); throw if it tries.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network request");
    }),
  );
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writeRaw(relPath: string, contents: string): void {
  fs.writeFileSync(path.join(tmpDir, "gccusage", relPath), contents);
}

describe("statusline cache timestamp (COR-006)", () => {
  const TTL = 5000;

  function writeEntry(stamp: string): void {
    writeRaw("statusline-cache.json", `{"output":"old-bar","timestamp":${stamp},"key":"k"}`);
  }

  it("serves an entry stamped now (control: the raw fixture is well-formed)", () => {
    writeEntry(String(Date.now()));
    expect(checkCache(TTL, "k")).toBe("old-bar");
  });

  it.each(untrustedStamps())("misses on a timestamp of %s instead of serving the old bar", (_label, stamp) => {
    writeEntry(stamp);
    expect(checkCache(TTL, "k")).toBeNull();
  });
});

describe("pricing cache timestamp (COR-006)", () => {
  const TTL = 60_000;
  const MODEL = "claude-stamp-test";
  const RATES =
    '{"inputCostPerToken":1e-6,"outputCostPerToken":2e-6,"cacheCreationCostPerToken":1e-6,' +
    '"cacheCreation1hCostPerToken":2e-6,"cacheReadCostPerToken":1e-7}';

  function writePricing(stamp: string): void {
    writeRaw(
      "pricing.json",
      `{"version":${PRICING_CACHE_VERSION},"timestamp":${stamp},"data":{"${MODEL}":${RATES}}}`,
    );
  }

  it("reads a table stamped now as fresh (control: the raw fixture is well-formed)", () => {
    writePricing(String(Date.now()));
    expect(loadPricingCacheEntry()).not.toBeNull();
    expect(getPricingForRender(TTL).stale).toBe(false);
  });

  it("misses on a timestamp of 1e400", () => {
    // Null, not an entry with an absurd age: the schema rejects the file.
    writePricing("1e400");
    expect(loadPricingCacheEntry()).toBeNull();
  });

  it.each(untrustedStamps())("reports the render table stale for a timestamp of %s", (_label, stamp) => {
    writePricing(stamp);
    expect(getPricingForRender(TTL).stale).toBe(true);
  });

  it.each(untrustedStamps())("does not serve the CLI a cached table stamped %s", (_label, stamp) => {
    // `fetchPricing`'s cache gate, the second consumer of the same stamp.
    writePricing(stamp);
    expect(loadPricingCache(TTL)).toBeNull();
  });
});

describe("block cache timestamp (COR-006)", () => {
  const SESSION_AGE = 10 * 60 * 1000;

  function writeBlock(stamp: string): void {
    writeRaw(path.join("blocks", "current.json"), `{"blockStartTime":${stamp}}`);
  }

  it("loads a block started now (control: the raw fixture is well-formed)", () => {
    writeBlock(String(Date.now()));
    expect(loadBlockCache()).not.toBeNull();
  });

  it.each(untrustedStamps())("misses on a blockStartTime of %s", (_label, stamp) => {
    writeBlock(stamp);
    expect(loadBlockCache()).toBeNull();
  });

  it.each(untrustedStamps())(
    "derives the block from the session start, not a blockStartTime of %s",
    (_label, stamp) => {
      // The symptom was `Block: ?` permanently: an Infinity start gave an
      // elapsed of -Infinity, which passed `elapsed < BLOCK_DURATION_MS`.
      writeBlock(stamp);
      const sessionStart = Date.now() - SESSION_AGE;

      const block = detectBlock(sessionStart);

      expect(block).not.toBeNull();
      expect(block!.blockStartTime).toBe(sessionStart);
      expect(block!.elapsedMs).toBeGreaterThanOrEqual(SESSION_AGE);
      expect(block!.remainingMs).toBeLessThanOrEqual(BLOCK_DURATION_MS - SESSION_AGE);
    },
  );

  it("returns no block for a session start in the future, and never saves one", () => {
    // The session-start fallback computed `now - sessionStartTime` raw, and a
    // negative elapsed always passed `elapsed < BLOCK_DURATION_MS`: the block
    // came back with elapsedMs -1h and remainingMs 6h, longer than the whole
    // window. It was also SAVED, so every render had `loadBlockCache` reject
    // and unlink the file and this path write it back (PR #155 review).
    const blockFile = path.join(tmpDir, "gccusage", "blocks", "current.json");
    const futureStart = Date.now() + 60 * 60 * 1000;

    expect(detectBlock(futureStart)).toBeNull();
    expect(fs.existsSync(blockFile)).toBe(false);

    expect(detectBlock(futureStart)).toBeNull();
    expect(fs.existsSync(blockFile)).toBe(false);
  });
});
