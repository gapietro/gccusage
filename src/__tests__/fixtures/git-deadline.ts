import { afterAll, beforeAll } from "vitest";

/**
 * The render-time git deadline for tests that assert on real `git-branch` /
 * `git-changes` output (#146). Production gives each `git` call 2000ms
 * (`src/utils/git.ts`), and a widget whose call times out drops its segment —
 * the correct runtime behaviour, but the wrong thing for a test that exists to
 * measure that segment. Measured across two local `npm run coverage` runs:
 * `git status --porcelain` took 46ms idle but ~200-240ms median and up to 1.1s
 * under suite load, and one local coverage run lost `git-changes` outright.
 * Forcing `git status` past 2s reproduced that failure byte for byte.
 *
 * Set unconditionally within its scope, NOT `??=`: a value left in a
 * developer's shell or in CI would otherwise reintroduce the race this exists
 * to remove. It is mutated on `process.env` itself because the widgets'
 * `execSync` reads the real environment at render time (the same reason
 * `git-repo-fixture.ts` deletes `GIT_CONFIG_COUNT` there).
 *
 * Callers must give those tests a Vitest timeout above this
 * (`GIT_FIXTURE_TEST_TIMEOUT_MS`), so a git that really hangs fails as a named
 * timeout rather than as a silently missing segment. `execSync` is
 * synchronous, so Vitest can only report that once the capped calls have
 * returned: a test making N git calls fails after up to N × 20s, not at 60s.
 *
 * Scoped by `useGitFixtureTimeout`, never set at import: a first version set
 * it when its module loaded, which raised the deadline for EVERY test in an
 * importing file. Several `renderer.test.ts` tests render the default layout
 * with no `cwd`, so their git widgets incidentally run against the checkout
 * itself, on Vitest's 5s default; with git slowed to 2.5s per call they went
 * from passing under the 2s production cap to timing out under 20s.
 */
export const GIT_FIXTURE_TIMEOUT_MS = 20_000;

/** Vitest timeout for any test that asserts on real git widget output. */
export const GIT_FIXTURE_TEST_TIMEOUT_MS = 60_000;

const GIT_TIMEOUT_ENV = "GCCUSAGE_GIT_TIMEOUT_MS";

/**
 * Call inside a `describe` whose tests assert on real git widget output:
 * raises the git deadline for that block only and restores whatever was there
 * afterwards. Pair it with `{ timeout: GIT_FIXTURE_TEST_TIMEOUT_MS }` on the
 * same `describe`.
 */
export function useGitFixtureTimeout(): void {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env[GIT_TIMEOUT_ENV];
    process.env[GIT_TIMEOUT_ENV] = String(GIT_FIXTURE_TIMEOUT_MS);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env[GIT_TIMEOUT_ENV];
    else process.env[GIT_TIMEOUT_ENV] = previous;
  });
}
