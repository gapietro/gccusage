import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";

// A real EventEmitter, not a bare `{ unref }`: the production code attaches an
// `error` listener (REL-006), and against a fake with no `on` that call would
// throw inside the outer try, be swallowed, skip `unref()` — and leave every
// test here green.
const spawnMock = vi.fn(
  (_command: string, _args: readonly string[], _options: Record<string, unknown>) =>
    Object.assign(new EventEmitter(), { unref: vi.fn() }),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:os", async (importOriginal) =>
  (await import("./helpers/no-passwd.js")).mockOsModule(importOriginal),
);
const { noPasswd } = await import("./helpers/no-passwd.js");

const { maybeSpawnPricingRefresh, REFRESH_BACKOFF_MS } = await import("../data/pricing-refresh.js");
const { getPricingForRender } = await import("../data/pricing-fetcher.js");
const { PRICING_CACHE_VERSION } = await import("../cache/pricing-cache.js");

/**
 * The backoff stamp is written by the PARENT before spawning, deliberately.
 * Child-side backoff fails open in exactly the case this feature exists for:
 * a child killed mid-fetch on a blackholed network never reaches its own
 * stamp write, so every subsequent prompt would spawn another one.
 */

let tmpDir: string;
let originalXdg: string | undefined;

function stampPath(): string {
  return path.join(tmpDir, "gccusage", "pricing-refresh-attempt.json");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-refresh-"));
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["XDG_CACHE_HOME"] = tmpDir;
  spawnMock.mockClear();
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeStamp(ageMs: number): void {
  fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
  fs.writeFileSync(stampPath(), JSON.stringify({ timestamp: Date.now() - ageMs }));
}

describe("maybeSpawnPricingRefresh", () => {
  it("does not spawn when the pricing cache is fresh", () => {
    maybeSpawnPricingRefresh(false);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns a detached, unref'd child when stale and outside the backoff", () => {
    maybeSpawnPricingRefresh(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0]!;
    expect(args).toContain("refresh-pricing");
    // Detached + ignored stdio is what stops the child holding the parent's
    // event loop open — the entire point of the fix.
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  });

  it("writes the attempt stamp before spawning, not after the fetch", () => {
    maybeSpawnPricingRefresh(true);

    expect(fs.existsSync(stampPath())).toBe(true);
  });

  it("does not spawn again within the backoff window", () => {
    writeStamp(REFRESH_BACKOFF_MS / 2);

    maybeSpawnPricingRefresh(true);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns again once the backoff window has passed", () => {
    writeStamp(REFRESH_BACKOFF_MS * 2);

    maybeSpawnPricingRefresh(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("spawns when the stamp timestamp is Infinity, instead of latching the backoff on", () => {
    // Written as a raw string on purpose: `JSON.stringify({ timestamp: Infinity })`
    // emits `null`, so building this through the writer cannot reproduce it.
    // `JSON.parse` turns an out-of-range literal into `Infinity`, which a bare
    // `typeof === "number"` guard admits — and `Date.now() - Infinity` is
    // `-Infinity`, forever inside the backoff window (#133).
    fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
    fs.writeFileSync(stampPath(), '{"timestamp":1e400}');

    maybeSpawnPricingRefresh(true);

    // The stamp is only rewritten AFTER this check, so a latched backoff is
    // permanent: the file causing the wrong answer gates its own repair.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["1 day in the future", () => String(Date.now() + 24 * 60 * 60 * 1000)],
    ["9e15", () => "9e15"],
  ])("spawns when the stamp timestamp is %s, instead of latching the backoff on", (_label, stamp) => {
    // COR-006: `v.finite()` closed #133 for 1e400 only. A finite future stamp
    // (a clock set backwards, a restored VM snapshot) still gave a negative
    // age, inside the backoff window until the clock caught up — for 9e15,
    // for ~285,000 years.
    fs.mkdirSync(path.dirname(stampPath()), { recursive: true });
    fs.writeFileSync(stampPath(), `{"timestamp":${stamp()}}`);

    maybeSpawnPricingRefresh(true);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("never throws when the cache directory cannot be written", () => {
    process.env["XDG_CACHE_HOME"] = path.join(tmpDir, "nonexistent-file", "nope");
    fs.writeFileSync(path.join(tmpDir, "nonexistent-file"), "not a directory");

    // A statusline must render regardless; a refresh is best-effort.
    expect(() => maybeSpawnPricingRefresh(true)).not.toThrow();
  });

  it("swallows a spawn failure instead of crashing the render (REL-006)", () => {
    maybeSpawnPricingRefresh(true);

    const child = spawnMock.mock.results[0]!.value as EventEmitter & { unref: () => void };
    // `spawn` reports EAGAIN/ENOENT by emitting `error` on a later tick, after
    // this function has returned, so its try/catch cannot see it. An emitter
    // with no `error` listener throws on emit — in production that is an
    // uncaught exception: exit 1 and a stack trace, outside GCCUSAGE_DEBUG.
    const err = Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
    expect(() => child.emit("error", err)).not.toThrow();
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("never spawns, and writes nothing, when there is no cache dir (SEC-004)", () => {
    // No home and no XDG_CACHE_HOME: the child would have nowhere to save
    // prices, and with nowhere to write the stamp there is no backoff — every
    // render would spawn another refresher. The old tmpdir fallback instead
    // wrote the stamp into the shared tmpdir.
    const originalHome = process.env["HOME"];
    const originalTmpdir = process.env["TMPDIR"];
    delete process.env["XDG_CACHE_HOME"];
    process.env["HOME"] = "";
    process.env["TMPDIR"] = tmpDir;
    noPasswd.on = true;
    try {
      maybeSpawnPricingRefresh(true);
    } finally {
      noPasswd.on = false;
      if (originalHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = originalHome;
      if (originalTmpdir === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = originalTmpdir;
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

/**
 * COR-006 end to end: `pricing.json` itself carrying an untrusted timestamp.
 * The bug was never the read alone: a negative age reported the table fresh,
 * `stale: false` meant no refresher was ever spawned, and the refresher is the
 * only thing that rewrites `pricing.json`. The file causing the wrong answer
 * gated its own repair, which is #133's shape, so these assert the spawn
 * rather than the read. The two calls are composed exactly as pipeline.ts
 * composes them.
 */
describe("a pricing cache with an untrusted timestamp (COR-006)", () => {
  const RATES =
    '{"inputCostPerToken":1e-6,"outputCostPerToken":2e-6,"cacheCreationCostPerToken":1e-6,' +
    '"cacheCreation1hCostPerToken":2e-6,"cacheReadCostPerToken":1e-7}';

  function writePricing(stamp: string): void {
    // Raw text: `JSON.stringify(Infinity)` is `null` (#133).
    const file = path.join(tmpDir, "gccusage", "pricing.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `{"version":${PRICING_CACHE_VERSION},"timestamp":${stamp},"data":{"claude-stamp-test":${RATES}}}`,
    );
  }

  function renderOnce(): void {
    maybeSpawnPricingRefresh(getPricingForRender(24 * 60 * 60 * 1000).stale);
  }

  it("does not spawn for a table stamped now (control: the raw fixture is fresh)", () => {
    writePricing(String(Date.now()));
    renderOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ["1e400", () => "1e400"],
    ["9e15", () => "9e15"],
    ["1 day in the future", () => String(Date.now() + 24 * 60 * 60 * 1000)],
  ])("spawns the refresher for a pricing.json timestamp of %s", (_label, stamp) => {
    writePricing(stamp());
    renderOnce();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  // PR #155 review: while that refresh is in flight, render with the cached
  // prices rather than FALLBACK_PRICING — only the stamp is suspect. 1e400 is
  // excluded because it fails the schema and the envelope is rejected whole.
  it.each([
    ["9e15", () => "9e15"],
    ["1 day in the future", () => String(Date.now() + 24 * 60 * 60 * 1000)],
  ])("renders with the cached prices AND spawns the refresher for a timestamp of %s", (_label, stamp) => {
    writePricing(stamp());

    const { pricing, stale } = getPricingForRender(24 * 60 * 60 * 1000);
    maybeSpawnPricingRefresh(stale);

    expect(Object.hasOwn(pricing, "claude-stamp-test")).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
