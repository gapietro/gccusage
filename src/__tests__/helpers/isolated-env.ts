import * as path from "node:path";

/**
 * The environment for a test that spawns the shipped bundle (TEST-004): the
 * developer's environment with every location the bundle reads or writes
 * moved under `dir`.
 *
 * Setting HOME alone is not isolation. The bundle resolves its cache and
 * config directories from `XDG_CACHE_HOME` / `XDG_CONFIG_HOME` before HOME,
 * so a developer who exports either had every such test reading and writing
 * their real directories. `setup` is the sharpest case: its legacy turn-store
 * cleanup `rmSync`s inside the cache directory. Three files spread
 * `process.env` and overrode only HOME.
 *
 * So the inherited `XDG_*` and `GCCUSAGE_*` variables are dropped rather than
 * overridden one by one: a future variable the bundle starts reading cannot
 * leak in, and a developer's `GCCUSAGE_DEBUG` or timeout setting cannot change
 * what a test observes. A test that needs one sets it explicitly after the
 * spread.
 *
 * Spread `suppressPricingRefresh(...).env` AFTER this, never before: that
 * helper owns `XDG_CACHE_HOME`, because its stamp is seeded at that path (see
 * pricing-refresher.ts). The `cache` default here is only for spawns with no
 * refresher suppression.
 */
export function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("XDG_") || key.startsWith("GCCUSAGE_")) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
  };
}
