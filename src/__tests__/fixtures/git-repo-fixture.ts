import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Every `git` invocation in `makeDeterministicGitRepo` uses this environment
 * instead of inheriting `process.env` unmodified.
 *
 * `default-layout-width.test.ts` fix-round-1 review reproduced two failures
 * this test shipped with: a developer with `commit.gpgsign=true` in their
 * GLOBAL git config gets `git commit` prompting/failing for a signing key
 * that doesn't exist here; a developer with a global `core.hooksPath`
 * pointing at a failing hook gets the same commit failure. Both are real,
 * common developer-machine settings that have nothing to do with this repo.
 *
 * Rather than patch each setting as it's discovered (`-c commit.gpgsign=false`
 * for the first, `-c core.hooksPath=`/`--no-verify` for the second, and then
 * whatever the NEXT one turns out to be — `credential.helper`,
 * `commit.template`, `url.*.insteadOf`, `init.defaultBranch`,
 * `safe.directory`, aliases, ...), this disables the entire global and
 * system config levels for every git call this module makes.
 * `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` are git's
 * own documented mechanism (git-config(1), ENVIRONMENT VARIABLES) for
 * skipping the corresponding config level entirely — cleaner than an
 * open-ended list of per-flag overrides, and it closes the whole class of
 * "some developer's global config" defect at once, not just the two
 * instances a reviewer happened to reproduce.
 *
 * `-c commit.gpgsign=false --no-verify` are still passed on the commit
 * itself as a second, redundant layer directly against the two failures
 * that were actually reproduced — belt-and-suspenders, not load-bearing,
 * since the env-level isolation above already prevents both.
 *
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` only cover the CONFIG LEVELS.
 * `core.excludesFile` is a PATH FALLBACK, not a config level: unset, git
 * still reads `$XDG_CONFIG_HOME/git/ignore` (or `~/.config/git/ignore`) even
 * with both config levels pointed at /dev/null. Final review reproduced
 * this: with `*.txt` in that ignore file, untracked fixtures become
 * invisible to `git status`, `git-changes` emits nothing, and callers'
 * assertions fail. `makeDeterministicGitRepo` closes this two ways:
 * `XDG_CONFIG_HOME` is pointed at the throwaway repo's own directory (which
 * never contains a `git/` subdirectory, so the fallback path resolves to
 * nothing on disk — and is removed by the same `rmSync` that cleans up the
 * repo, unlike a separately mkdtemp'd directory), and
 * `core.excludesFile=/dev/null` is set in the repo's LOCAL config as a
 * second, explicit block of the same hole.
 *
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` inject
 * config directly via environment variables and take precedence over EVERY
 * file-based config level, local included — a known open hole from an
 * earlier review round. That precedence is exactly why deleting it only from
 * a locally-scoped copy of `process.env` (as a naive fix would) is not
 * enough: `getGitBranch`/`getGitChanges` (`src/utils/git.ts`) call
 * `execSync` with no `env` override, so at RENDER time — when
 * `renderStatusline` invokes those widgets against the repo below — they
 * inherit the REAL `process.env` of the test process, not any sanitized copy
 * scoped to `makeDeterministicGitRepo`. A hostile `GIT_CONFIG_COUNT` in the
 * ambient environment would still poison that read even after the repo's own
 * local `core.excludesFile` is set. So `GIT_CONFIG_COUNT` is deleted from
 * `process.env` itself, once, before `GIT_ENV` is derived from it — the only
 * way to make both the construction calls AND the later render-time widget
 * calls agree it doesn't exist. (`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` need
 * no equivalent treatment: without a `COUNT`, git doesn't look for them at
 * all, at any count.)
 */
delete process.env.GIT_CONFIG_COUNT;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/**
 * Build the exact env each `git` call in `makeDeterministicGitRepo` runs
 * with: the base `GIT_ENV` above, plus `XDG_CONFIG_HOME` pointed at this
 * call's own throwaway repo directory — see the `core.excludesFile`
 * paragraph on `GIT_ENV`. Per-repo (not a shared module-level constant)
 * so it is removed by the same `rmSync` that cleans up `dir`.
 */
function gitEnvFor(dir: string): NodeJS.ProcessEnv {
  return { ...GIT_ENV, XDG_CONFIG_HOME: dir };
}

/**
 * Build a real, throwaway git repository so `git-branch`/`git-changes`
 * genuinely execute their real code path (they shell out to `git` against
 * `stdin.cwd` — see `src/utils/git.ts`) instead of silently returning null
 * against a nonexistent directory, which is exactly how the brief's first
 * draft of `default-layout-width.test.ts`'s "busiest bar" test passed
 * vacuously: it never measured two of the six segments it claimed to.
 *
 * The branch name and change set are hardcoded, not read from whatever repo
 * happens to contain this checkout — a real git developer's actual branch
 * name and working-tree state vary per machine and per moment, and a test
 * that depended on either would be flaky (or worse, silently vacuous again
 * on a machine/branch combination that happens to produce short output).
 * `worktree-terminal-width-67` (26 characters) and exactly two untracked
 * files are the fixed values `default-layout-width.test.ts`'s
 * `SUPPORTED_WIDTH` comment's "88 columns, 26 character branch name" figure
 * was measured against; other callers reuse the same fixed repo rather than
 * inventing their own branch name/change set.
 *
 * The whole body runs inside a try/finally around the temp dir itself: if
 * any git call here throws (as it did during fix-round-1 review, under a
 * hostile global git config), the mkdtemp'd directory is still removed
 * before the error propagates. Callers' own try/finally only guards cleanup
 * for a repo that was successfully returned — it can't reach a failure that
 * happens during construction, which is exactly how three
 * `gccusage-width-fixture-*` directories were left behind in $TMPDIR during
 * that review.
 */
export function makeDeterministicGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gccusage-width-fixture-"));
  try {
    const env = gitEnvFor(dir);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "ignore"], env });

    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    // Belt-and-suspenders against the excludesFile path-fallback documented
    // on GIT_ENV above: block it in this repo's own LOCAL config too, not
    // just via the XDG_CONFIG_HOME redirect.
    git(["config", "core.excludesFile", "/dev/null"]);
    git(["checkout", "-q", "-b", "worktree-terminal-width-67"]);
    // A commit is required: with zero commits HEAD is unborn and
    // `git rev-parse --abbrev-ref HEAD` (what getGitBranch runs) fails,
    // which getGitBranch treats identically to "not a git repo" (null).
    writeFileSync(path.join(dir, "README.md"), "fixture\n");
    git(["add", "README.md"]);
    git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init", "--no-verify"]);
    // Two untracked files: deterministic "+2" from git-changes.
    writeFileSync(path.join(dir, "a.txt"), "a\n");
    writeFileSync(path.join(dir, "b.txt"), "b\n");
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
