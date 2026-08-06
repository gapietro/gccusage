import { expect } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PRICING_REFRESH_STAMP_FILE } from "../../data/pricing-refresh.js";

/**
 * Shared suppression for the detached pricing refresher (#122, TEST-002).
 *
 * `maybeSpawnPricingRefresh` spawns a child that is `detached`, `unref`'d and
 * stdio-ignored. It returns no pid, so nothing in a test can await or kill it,
 * and it writes into the cache directory the spawning test is about to delete.
 * Seeding a recent attempt stamp makes the parent return *before* the spawn,
 * which is the only way to bound that child from a test.
 *
 * The failure it prevents is mostly invisible from inside the suite: a write
 * landing during `rmSync`'s walk raises `ENOTEMPTY`, and a write landing after
 * it silently recreates the directory. The second mode leaves a directory
 * containing nothing but `cache/gccusage/pricing.json` — the stamp is absent
 * not because the refresher never ran, but because `rmSync` deleted it and the
 * grandchild rebuilt the tree around its own write. Reading "no stamp" as "no
 * refresher" is the trap; the residue is the evidence.
 *
 * #122 fixed one file this way. This module exists so the next test that
 * spawns the bundle inherits the fix instead of rediscovering it — that
 * missing seam is why three more files leaked for two weeks.
 */

/**
 * A URL on a port that was bound and then released, so connecting to it is
 * refused immediately.
 *
 * Defence in depth behind the stamp: a refresher that somehow escapes
 * suppression fails fast and writes nothing, and — just as important — never
 * reaches the live LiteLLM feed. Tests were making real outbound requests, one
 * per spawn, because every test gets a fresh cache directory and therefore
 * always missed the backoff.
 *
 * An unroutable address would also fail, but slowly and only on some networks;
 * a refused port fails the same way everywhere, including offline CI.
 */
export async function reserveRefusedUrl(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return `http://127.0.0.1:${port}/pricing.json`;
}

export interface RefresherSuppression {
  /**
   * Spread into the spawned child's `env`.
   *
   * The helper owns `XDG_CACHE_HOME` rather than letting the caller set it
   * alongside, because the stamp path is derived from it: if a test seeded one
   * directory and pointed the child at another, the seed would land where
   * nothing reads it and `assertNotSpawned` would pass while a refresher ran
   * on every render. That is not hypothetical — seeding the wrong directory
   * was sabotage-tested against the earlier two-argument shape and the suite
   * stayed green. Returning both keys together makes the divergence
   * unexpressible instead of merely discouraged.
   */
  env: { XDG_CACHE_HOME: string; GCCUSAGE_PRICING_URL: string };
  /** Where the stamp was written, for a test that needs to assert on it. */
  stampPath: string;
  /**
   * Fails if any render spawned a refresher. The parent rewrites the stamp
   * immediately before spawning, so a changed stamp is a spawn that happened —
   * detected deterministically rather than as an intermittent teardown error.
   */
  assertNotSpawned(): void;
}

/**
 * Seed the backoff stamp inside `xdgCacheHome` so no refresher is spawned, and
 * hand back the env that points the child at that same directory.
 *
 * `xdgCacheHome` is the value the child will see, not a temp-dir root: the two
 * are not the same across this suite — `concurrency` uses the temp dir itself
 * while the stdin and width tests use a `cache/` subdirectory.
 */
export function suppressPricingRefresh(
  xdgCacheHome: string,
  refusedPricingUrl: string,
): RefresherSuppression {
  const stampPath = path.join(xdgCacheHome, "gccusage", PRICING_REFRESH_STAMP_FILE);
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  const seeded = JSON.stringify({ timestamp: Date.now() });
  fs.writeFileSync(stampPath, seeded);

  return {
    env: { XDG_CACHE_HOME: xdgCacheHome, GCCUSAGE_PRICING_URL: refusedPricingUrl },
    stampPath,
    assertNotSpawned(): void {
      expect(
        fs.readFileSync(stampPath, "utf-8"),
        "a detached pricing refresher was spawned into the temp dir this test deletes",
      ).toBe(seeded);
    },
  };
}
