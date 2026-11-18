import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPricingForRender, parseLitellmPricing } from "../data/pricing-fetcher.js";
import { anchorToSnapshot, sanitisePricingTable } from "../data/pricing-validation.js";
import { loadPricingCacheEntry, savePricingCache } from "../cache/pricing-cache.js";
import { findPricing } from "../data/cost-calculator.js";

/**
 * SEC-005: the pricing tables are dictionaries keyed by the LiteLLM feed and
 * by the cache file, and were plain `{}` objects. `parseLitellmPricing` takes
 * the model id as `key.split("/").pop()`, so a feed key `claude-x/__proto__`
 * made `table["__proto__"] = sane` REPLACE the table's prototype instead of
 * adding an entry. Inert today only because every reader uses `Object.hasOwn`
 * (#143) — a guard on reads alone, which the next reader has to remember.
 *
 * The rule now: every table is a null-prototype dictionary, so no key can
 * reach a prototype; and the three names valibot's `v.record` refuses on the
 * cache read (`__proto__`, `prototype`, `constructor`) are dropped at the feed
 * too, so a freshly fetched table and its cache round-trip hold the same keys.
 * `toString` is an ordinary key under that rule and survives as own data.
 */

const RATES = { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 };

/** Built with JSON.parse so `__proto__` is an own key, as it is off the wire. */
const FEED = JSON.parse(
  JSON.stringify({
    "claude-x/__proto__": RATES,
    "claude-x/constructor": RATES,
    "claude-x/toString": RATES,
    "claude-x/prototype": RATES,
    "claude-real": RATES,
  }),
) as Record<string, unknown>;

let tmpDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-proto-table-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pricing tables keyed by the feed (SEC-005)", () => {
  it("builds the fixture it claims to (control)", () => {
    expect(Object.hasOwn(FEED, "claude-x/__proto__")).toBe(true);
    expect(Object.keys(FEED)).toHaveLength(5);
  });

  it("does not let a feed model id replace the parsed table's prototype", () => {
    const table = parseLitellmPricing(FEED);
    expect(Object.getPrototypeOf(table)).toBeNull();
  });

  it("drops the names v.record refuses and keeps every other key as own data", () => {
    const table = parseLitellmPricing(FEED);

    for (const reserved of ["__proto__", "constructor", "prototype"]) {
      expect(Object.hasOwn(table, reserved), reserved).toBe(false);
    }
    // An ordinary key on a null-prototype table: own data, nothing inherited.
    expect(Object.hasOwn(table, "toString")).toBe(true);
    expect(findPricing("toString", table)).not.toBeNull();
    // The provider-qualified raw keys are ordinary strings and are kept.
    expect(Object.hasOwn(table, "claude-x/__proto__")).toBe(true);
    expect(Object.hasOwn(table, "claude-real")).toBe(true);
  });

  it("holds the same keys after a round-trip through the cache file", () => {
    const fetched = anchorToSnapshot(parseLitellmPricing(FEED));
    savePricingCache(fetched);

    const cached = loadPricingCacheEntry()!.data;

    expect(Object.keys(cached).sort()).toEqual(Object.keys(fetched).sort());
    expect(Object.getPrototypeOf(cached)).toBeNull();
  });

  it("builds every derived table without a prototype", () => {
    const parsed = parseLitellmPricing(FEED);
    savePricingCache(anchorToSnapshot(parsed));

    expect(Object.getPrototypeOf(anchorToSnapshot(parsed))).toBeNull();
    expect(Object.getPrototypeOf(sanitisePricingTable(FEED))).toBeNull();
    expect(Object.getPrototypeOf(getPricingForRender(60_000).pricing)).toBeNull();
  });

  it("drops a raw __proto__ entry handed to sanitisePricingTable instead of adopting it", () => {
    const sane = parseLitellmPricing({ "claude-real": RATES })["claude-real"];
    const raw = JSON.parse(`{"__proto__":${JSON.stringify(sane)},"claude-real":${JSON.stringify(sane)}}`) as Record<
      string,
      unknown
    >;

    const table = sanitisePricingTable(raw);

    expect(Object.getPrototypeOf(table)).toBeNull();
    expect(Object.hasOwn(table, "__proto__")).toBe(false);
    expect(Object.keys(table)).toEqual(["claude-real"]);
  });
});
