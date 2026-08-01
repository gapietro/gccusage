import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { contextFromFixture } from "./fixtures/context-from-fixture.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };
import lowFixture from "./fixtures/real-payloads/fable5-1m-low.json" with { type: "json" };
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

/**
 * The width the default two-line layout is pinned against.
 *
 * This is a MEASURED figure, not the "one column above the compact
 * threshold" guess the first draft of this test used — see
 * .superpowers/sdd/2026-08-01-terminal-width/task-5-report.md for the full
 * measurement. Rendering against real payload fixtures (which don't include
 * a real git repo) showed line 1 at 70-72 columns and line 2 at 29-49
 * columns across the three fixtures. But `git-branch`/`git-changes` don't
 * read the stdin payload at all — they shell out to real `git` against
 * `stdin.cwd` (`src/utils/git.ts`) — so a fixture whose recorded `cwd`
 * doesn't exist on disk makes both widgets silently emit nothing. Rendering
 * against a REAL (synthetic, deterministic) git repo instead, so those two
 * widgets genuinely execute, measures line 2 at 79 columns with vim-mode
 * OFF — that is the realistic worst case this constant means to pin.
 *
 * The value is 80, not 79, for a reason that cost a failed test run to find:
 * `DEFAULT_SETTINGS.compact` is `{ mode: "auto", threshold: 80 }`, and
 * `shouldCompact` collapses the ENTIRE bar to a single compacted line
 * whenever `terminalWidth < threshold` (`src/render/renderer.ts`). 79 is
 * below that threshold, so rendering at 79 does not measure line 2 of the
 * full two-line layout at all — it silently switches to `renderCompact()`
 * and reports an empty second line. 80 is the tightest width that (a) stays
 * at or above the compact threshold, so this test keeps exercising the full
 * two-line layout `renderFull` produces, and (b) is still large enough that
 * the realistic non-vim worst case (79 columns) fits without truncating.
 *
 * What this DOES promise: none of the three real-payload fixtures, and the
 * deterministic busiest-bar case with vim-mode OFF, truncate at this width.
 *
 * What this does NOT promise: `project` (basename of `workspace.project_dir`)
 * and `git-branch` are UNBOUNDED strings — sized by whatever the real
 * directory/branch names are on the machine running gccusage, and neither
 * widget truncates or elides its own text (the schema's `maxWidth` field is
 * declared but not implemented anywhere in `src/widgets/`). With vim-mode ON
 * and a 26-character branch name — reproduced deterministically below —
 * line 2 grows to 88 columns and DOES truncate at this width. That is a
 * known, accepted limitation (unbounded `project`/`git-branch` growth is
 * filed as its own follow-up issue), not a regression this test exists to
 * catch: this test pins a realistic worst case, not a guarantee for every
 * terminal + vim-mode + branch-name combination.
 */
const SUPPORTED_WIDTH = 80;

const fixtures: RealPayloadFixture[] = [
  midFixture as unknown as RealPayloadFixture,
  lowFixture as unknown as RealPayloadFixture,
  earlyFixture as unknown as RealPayloadFixture,
];

/**
 * Every `git` invocation in `makeDeterministicGitRepo` uses this environment
 * instead of inheriting `process.env` unmodified.
 *
 * Fix-round-1 review reproduced two failures this test shipped with: a
 * developer with `commit.gpgsign=true` in their GLOBAL git config gets
 * `git commit` prompting/failing for a signing key that doesn't exist here;
 * a developer with a global `core.hooksPath` pointing at a failing hook gets
 * the same commit failure. Both are real, common developer-machine settings
 * that have nothing to do with this repo.
 *
 * Rather than patch each setting as it's discovered (`-c commit.gpgsign=false`
 * for the first, `-c core.hooksPath=`/`--no-verify` for the second, and then
 * whatever the NEXT one turns out to be — `credential.helper`,
 * `commit.template`, `url.*.insteadOf`, `init.defaultBranch`,
 * `safe.directory`, aliases, ...), this disables the entire global and
 * system config levels for every git call this test makes.
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
 * this: with `*.txt` in that ignore file, the two untracked fixtures below
 * (`a.txt`/`b.txt`) become invisible to `git status`, `git-changes` emits
 * nothing, and two of this file's tests fail. `makeDeterministicGitRepo`
 * closes this two ways: `XDG_CONFIG_HOME` is pointed at the throwaway repo's
 * own directory (which never contains a `git/` subdirectory, so the
 * fallback path resolves to nothing on disk — and is removed by the same
 * `rmSync` that cleans up the repo, unlike a separately mkdtemp'd
 * directory), and `core.excludesFile=/dev/null` is set in the repo's LOCAL
 * config as a second, explicit block of the same hole.
 *
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` inject
 * config directly via environment variables and take precedence over EVERY
 * file-based config level, local included — a known open hole from an
 * earlier review round. That precedence is exactly why deleting it only from
 * a locally-scoped copy of `process.env` (as a naive fix would) is not
 * enough: `getGitBranch`/`getGitChanges` (`src/utils/git.ts`) call
 * `execSync` with no `env` override, so at RENDER time — when
 * `renderStatusline` invokes those widgets against the repo below — they
 * inherit the REAL `process.env` of this test process, not any sanitized
 * copy scoped to `makeDeterministicGitRepo`. A hostile `GIT_CONFIG_COUNT` in
 * the ambient environment would still poison that read even after the
 * repo's own local `core.excludesFile` is set. So `GIT_CONFIG_COUNT` is
 * deleted from `process.env` itself, once, before `GIT_ENV` is derived from
 * it — the only way to make both the construction calls AND the later
 * render-time widget calls agree it doesn't exist. (`GIT_CONFIG_KEY_n`/
 * `GIT_CONFIG_VALUE_n` need no equivalent treatment: without a `COUNT`, git
 * doesn't look for them at all, at any count.)
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
 * `stdin.cwd` — see the SUPPORTED_WIDTH comment above) instead of silently
 * returning null against a nonexistent directory, which is exactly how the
 * brief's first draft of the "busiest bar" test passed vacuously: it never
 * measured two of the six segments it claimed to.
 *
 * The branch name and change set are hardcoded, not read from whatever repo
 * happens to contain this checkout — a real git developer's actual branch
 * name and working-tree state vary per machine and per moment, and a test
 * that depended on either would be flaky (or worse, silently vacuous again
 * on a machine/branch combination that happens to produce short output).
 * `worktree-terminal-width-67` (26 characters) and exactly two untracked
 * files are the fixed values the SUPPORTED_WIDTH comment's "88 columns, 26
 * character branch name" figure was measured against.
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
function makeDeterministicGitRepo(): string {
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

describe("default layout width against real payloads", () => {
  it.each(fixtures.map((fx) => [fx.name, fx] as const))(
    "renders %s without truncating on a supported terminal",
    (_name, fx) => {
      const context = contextFromFixture(fx, "/home/testuser");
      const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);

      for (const line of stripAnsi(output).split("\n")) {
        expect(line).not.toContain("…");
      }
    },
  );

  describe("busiest realistic bar (deterministic git repo, all six line-2 segments)", () => {
    // vim-mode only appears when vim mode is enabled, and it is the segment
    // that pushed line 2 over the edge in #66. Force it on, and point
    // `stdin.cwd` at a real repo (see makeDeterministicGitRepo) so
    // git-branch/git-changes render for real rather than silently dropping
    // out — the vacuous-pass failure mode this describe block exists to
    // close. `workspace.project_dir` is set independently of `cwd`: the
    // `project` widget only ever reads its basename as a string (#59), so it
    // does not need to be a real path, which keeps the project name under
    // our control without needing the temp repo to live at that name.
    //
    // The basename below, "demo-project-repo", is deliberately NOT a
    // substring of the branch name "worktree-terminal-width-67" (nor vice
    // versa) — fix-round-1 review found the original name
    // ("terminal-width-67") WAS a substring of the branch, so the presence
    // assertion for `project` kept passing even after the reviewer deleted
    // `workspace.project_dir` entirely and the project segment vanished from
    // line 2: `toContain("terminal-width-67")` was silently being satisfied
    // by the git-branch text instead. It is the same length (17 characters)
    // as the original so the documented 88/79-column pins are unaffected.
    function buildBusiestContext(vimEnabled: boolean, repoDir: string) {
      const fx = midFixture as unknown as RealPayloadFixture;
      const base = contextFromFixture(fx, "/home/testuser");
      return {
        ...base,
        stdin: {
          ...base.stdin,
          cwd: repoDir,
          workspace: {
            ...base.stdin.workspace,
            project_dir: "/home/testuser/projects/demo-project-repo",
            current_dir: repoDir,
          },
          ...(vimEnabled ? { vim: { mode: "NORMAL" } } : {}),
        },
      } as typeof base;
    }

    it("renders all six segments — guards against the vacuous pass this test replaces", () => {
      const repoDir = makeDeterministicGitRepo();
      try {
        const context = buildBusiestContext(true, repoDir);
        // Render unconstrained (no truncation possible) so this assertion
        // can never pass merely because truncation hid a missing segment.
        const natural = renderStatusline({ ...context, terminalWidth: undefined }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(natural).split("\n")[1] ?? "";

        // Assert every segment this case exists to measure actually
        // rendered, BEFORE asserting anything about width. If a widget ever
        // silently drops out again (as git-branch/git-changes did against a
        // nonexistent fixture cwd), this fails loudly instead of quietly
        // measuring a shorter bar.
        expect(line2).toContain("demo-project-repo"); // project
        expect(line2).toContain("worktree-terminal-width-67"); // git-branch
        expect(line2).toContain("+2"); // git-changes
        expect(line2).toContain("+649 -66"); // lines-changed
        expect(line2).toContain("Today: $609"); // today-spend
        expect(line2).toContain("NORMAL"); // vim-mode

        // Pin the deterministic natural width itself as a regression guard:
        // if this ever drifts, SUPPORTED_WIDTH's documentation is stale.
        expect(visibleLength(line2)).toBe(88);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("truncates with vim-mode on and a 26-character branch name — accepted, not a regression", () => {
      const repoDir = makeDeterministicGitRepo();
      try {
        const context = buildBusiestContext(true, repoDir);
        const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(output).split("\n")[1] ?? "";

        // This is the known, accepted limitation documented on
        // SUPPORTED_WIDTH above: unbounded project/git-branch length plus
        // vim-mode pushes line 2 past the pinned width. Asserting the
        // truncation here (rather than asserting it away) keeps the
        // trade-off visible and tested instead of silently encoded.
        expect(line2).toContain("…");
        expect(visibleLength(line2)).toBe(SUPPORTED_WIDTH);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("does not truncate with vim-mode off — the realistic worst case SUPPORTED_WIDTH pins", () => {
      const repoDir = makeDeterministicGitRepo();
      try {
        const context = buildBusiestContext(false, repoDir);
        const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(output).split("\n")[1] ?? "";

        expect(line2).not.toContain("…");
        expect(visibleLength(line2)).toBe(79);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
