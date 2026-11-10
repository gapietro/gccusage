import { rmSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderStatusline } from "../render/renderer.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { contextFromFixture } from "./fixtures/context-from-fixture.js";
import type { RealPayloadFixture } from "./fixtures/real-payloads/fixture-types.js";
import { stripAnsi, visibleLength } from "../utils/terminal.js";
import { displayWidth } from "../utils/display-width.js";
import { makeDeterministicGitRepo } from "./fixtures/git-repo-fixture.js";
import midFixture from "./fixtures/real-payloads/opus5-1m-mid.json" with { type: "json" };
import lowFixture from "./fixtures/real-payloads/fable5-1m-low.json" with { type: "json" };
import earlyFixture from "./fixtures/real-payloads/opus5-1m-early.json" with { type: "json" };

/**
 * The width the default two-line layout is pinned against.
 *
 * This is a MEASURED figure, not the "one column above the compact
 * threshold" guess the first draft of this test used — see
 * .superpowers/sdd/2026-08-01-terminal-width/task-5-report.md for the full
 * measurement. Re-measured for #139, which added `effort` to line 1 after
 * `model` and moved `burn-rate` from line 1 to line 2 after `today-spend`:
 * rendering against real payload fixtures (which don't include a real git
 * repo, and which all record `effort: high`) shows line 1 at 66-67 columns
 * and line 2 at 40-52 columns across the three fixtures. But
 * `git-branch`/`git-changes` don't read the stdin payload at all — they
 * shell out to real `git` against `stdin.cwd` (`src/utils/git.ts`) — so a
 * fixture whose recorded `cwd` doesn't exist on disk makes both widgets
 * silently emit nothing. Rendering against a REAL (synthetic,
 * deterministic) git repo instead, so those two widgets genuinely execute,
 * measures line 2's natural width at 91 columns with vim-mode OFF and 100
 * with it ON — the realistic worst cases this constant is pinned against.
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
 * the busiest realistic line 2 can be brought within it by shrinking.
 *
 * What this DOES promise: at this width the default bar keeps EVERY segment.
 * The three real-payload fixtures fit outright, with no `…` anywhere. The
 * deterministic busiest bar (both vim-mode off and on, and with a 42-character
 * branch name) does not fit naturally, so the renderer's shrink pass elides
 * the two `shrinkable` segments — `project` and `git-branch` — mid-text
 * rather than letting the tail truncation cut whole segments off the end of
 * the line. Shrinking those two names is the accepted cost of #139 moving
 * `burn-rate` onto line 2; the tests below assert every segment survives.
 *
 * What this does NOT promise: every `project`/`git-branch` name stays
 * readable. Both are unbounded strings, so the more columns the other
 * segments need, the more of those two names is elided.
 */
const SUPPORTED_WIDTH = 80;

const fixtures: RealPayloadFixture[] = [
  midFixture as unknown as RealPayloadFixture,
  lowFixture as unknown as RealPayloadFixture,
  earlyFixture as unknown as RealPayloadFixture,
];

// `makeDeterministicGitRepo` (below, via import) builds a real, throwaway git
// repository so `git-branch`/`git-changes` genuinely execute their real code
// path (they shell out to `git` against `stdin.cwd` — see the SUPPORTED_WIDTH
// comment above) instead of silently returning null against a nonexistent
// directory, which is exactly how the brief's first draft of the "busiest
// bar" test below passed vacuously: it never measured two of the six segments
// it claimed to. It lives in `./fixtures/git-repo-fixture.ts`, not here, so
// `src/__tests__/renderer.test.ts` can reuse the exact same construction
// (and the git-env hardening it carries) for its own git-branch shrink
// coverage instead of duplicating it.

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

  it.each(fixtures.map((fx) => [fx.name, fx] as const))(
    "renders the recorded effort level as its own line-1 segment for %s (#139)",
    (_name, fx) => {
      const context = contextFromFixture(fx, "/home/testuser");
      const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
      const line1 = stripAnsi(output).split("\n")[0] ?? "";

      // Every recorded fixture carries `effort: { level: "high" }`. Match the
      // whole powerline segment — separator, padded text, separator — so the
      // assertion can't be satisfied by "high" appearing inside other text.
      expect(context.stdin.effort?.level).toBe("high");
      expect(line1).toContain("\u25B6 high \u25B6");
      // Measured with effort on line 1 and burn-rate moved to line 2.
      expect(visibleLength(line1)).toBeLessThanOrEqual(67);
    },
  );

  describe("busiest realistic bar (deterministic git repo, all seven line-2 segments)", () => {
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
    // as the original so the documented 100/91-column pins are unaffected.
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

    it("renders all seven segments — guards against the vacuous pass this test replaces", () => {
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
        expect(line2).toContain("$13.27/hr"); // burn-rate (#139)
        expect(line2).toContain("NORMAL"); // vim-mode

        // Pin the deterministic natural width itself as a regression guard:
        // if this ever drifts, SUPPORTED_WIDTH's documentation is stale.
        expect(visibleLength(line2)).toBe(100);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("shrinks with vim-mode on and a 26-character branch name — accepted, every segment present", () => {
      const repoDir = makeDeterministicGitRepo();
      try {
        const context = buildBusiestContext(true, repoDir);
        const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(output).split("\n")[1] ?? "";

        // The accepted cost documented on SUPPORTED_WIDTH: the natural 100
        // columns are brought to exactly the pinned width by eliding
        // project and git-branch mid-text, not by cutting the tail.
        expect(line2).toContain("…");
        expect(visibleLength(line2)).toBe(SUPPORTED_WIDTH);
        expect(line2).toContain("demo-proje"); // project, shrunk not dropped
        expect(line2).toContain("worktree-te"); // git-branch, shrunk not dropped
        expect(line2).toContain("+2"); // git-changes
        expect(line2).toContain("+649 -66"); // lines-changed
        expect(line2).toContain("Today: $609"); // today-spend
        expect(line2).toContain("$13.27/hr"); // burn-rate
        expect(line2).toContain("NORMAL"); // vim-mode — the line's last
        // segment, so the first casualty of a tail truncation.
        expect(line2.trimEnd().endsWith("…")).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("fits at SUPPORTED_WIDTH with vim-mode off by shrinking, every segment present", () => {
      const repoDir = makeDeterministicGitRepo();
      try {
        const context = buildBusiestContext(false, repoDir);
        const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(output).split("\n")[1] ?? "";

        // Natural width is 91 with burn-rate on line 2 (#139), so even
        // without vim-mode the shrink pass has to elide project/git-branch.
        expect(visibleLength(line2)).toBe(SUPPORTED_WIDTH);
        expect(line2).toContain("demo-proje"); // project, shrunk not dropped
        expect(line2).toContain("worktree-te"); // git-branch, shrunk not dropped
        expect(line2).toContain("+2"); // git-changes
        expect(line2).toContain("+649 -66"); // lines-changed
        expect(line2).toContain("Today: $609"); // today-spend
        expect(line2).toContain("$13.27/hr"); // burn-rate — the line's last
        // segment here, so the first casualty of a tail truncation.
        expect(line2.trimEnd().endsWith("…")).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("fits a much longer branch name by shrinking rather than truncating", () => {
      // 42 characters — deliberately longer than the 26-character branch
      // used above. This one pushes the natural width to 116 columns
      // (vim-mode on, burn-rate on line 2), well past what a single
      // segment's shrink floor alone
      // could satisfy if the shrink pass were merely cosmetic, so it forces
      // real trimming rather than passing by coincidence.
      const repoDir = makeDeterministicGitRepo("feature/an-extremely-long-branch-name-here");
      try {
        const context = buildBusiestContext(true, repoDir);
        const output = renderStatusline({ ...context, terminalWidth: SUPPORTED_WIDTH }, DEFAULT_SETTINGS);
        const line2 = stripAnsi(output).split("\n")[1] ?? "";

        // Fits...
        expect(visibleLength(line2)).toBeLessThanOrEqual(SUPPORTED_WIDTH);
        // ...every segment this case exists to measure is still present —
        // shrinking, not silent loss, produced the fit. A width-only
        // assertion can't distinguish this from truncateAnsi cutting the
        // tail; the presence checks below are what would fail if shrinking
        // were removed and the raw truncateAnsi backstop took over instead
        // (verified directly in Step 3 of this task's report).
        expect(line2).toContain("demo-proje"); // project, shrunk too since #139
        expect(line2).toContain("feature/an-"); // git-branch, shrunk not dropped
        expect(line2).toContain("+2"); // git-changes
        expect(line2).toContain("+649 -66"); // lines-changed
        expect(line2).toContain("Today: $609"); // today-spend
        expect(line2).toContain("$13.27/hr"); // burn-rate
        expect(line2).toContain("NORMAL"); // vim-mode — the line's last
        // segment, so the first casualty of a tail truncation.
        // ...and the loss was taken inside a segment, not off the line's end.
        expect(line2).toContain("…");
        expect(line2.trimEnd().endsWith("…")).toBe(false);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe("wide characters (issue #86)", () => {
    // The issue's exact reproduction: a project directory named with 17 CJK
    // glyphs. String.length reports 17, the terminal draws 34 columns, so the
    // bar overflowed a 45-column terminal by 7 without ever registering that
    // it had. `compact.mode: "never"` keeps the full two-line layout rather
    // than collapsing to the single compacted line at this width.
    const CJK_PROJECT = "日本語プロジェクト名前テストの長い";
    const NARROW_WIDTH = 45;

    function cjkContext() {
      const fx = midFixture as unknown as RealPayloadFixture;
      const base = contextFromFixture(fx, "/home/testuser");
      return {
        ...base,
        stdin: {
          ...base.stdin,
          workspace: {
            ...base.stdin.workspace,
            project_dir: `/home/testuser/projects/${CJK_PROJECT}`,
          },
        },
      } as typeof base;
    }

    it("measures the CJK project name at two columns per glyph", () => {
      expect(CJK_PROJECT.length).toBe(17);
      expect(visibleLength(CJK_PROJECT)).toBe(34);
    });

    it("keeps every line within the terminal width", () => {
      const settings = {
        ...DEFAULT_SETTINGS,
        compact: { ...DEFAULT_SETTINGS.compact, mode: "never" as const },
      };
      const output = renderStatusline(
        { ...cjkContext(), terminalWidth: NARROW_WIDTH },
        settings,
      );

      const lines = stripAnsi(output).split("\n");
      // Guard against a vacuous pass: the project segment must actually be
      // present (possibly truncated), or this asserts nothing about CJK at all.
      expect(lines.some((line) => line.includes(CJK_PROJECT.slice(0, 2)))).toBe(true);

      for (const line of lines) {
        // Deliberately `displayWidth`, not `visibleLength`: the renderer's
        // own truncation/shrink decisions are made using `visibleLength`, so
        // if it were ever broken (as it was pre-fix — plain UTF-16 length),
        // asserting with `visibleLength` here would check the broken
        // renderer's output against the same broken ruler and pass no
        // matter how many columns the line actually occupies. Only
        // `displayWidth` (the ground truth for terminal columns) is
        // independent of that decision. Post-fix the two agree exactly
        // (`visibleLength` IS `displayWidth(stripAnsi(...))`), but this
        // assertion must not be "simplified" back to `visibleLength` — that
        // would silently turn this guard vacuous again.
        expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
      }
    });
  });
});
