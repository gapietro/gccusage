# Add a linter to the toolchain

Issue #98 (audit MAINT-001, P3). The last open audit finding other than #133.

## Problem

There is no linter or formatter in the toolchain — no ESLint, Biome, Prettier
or oxlint config, and no such devDependency. Style consistency has been held by
hand and holds up well; this is not a code-quality complaint. The gap is that a
class of defect a linter catches for free has nothing watching for it, and the
standard is unenforceable on any contribution that is not hand-reviewed.

Two parts of the issue's evidence no longer hold, and the fix should say so
rather than quietly inherit them:

- The `eslint-disable-next-line no-control-regex` comment it cites at
  `src/utils/terminal.ts:36` is **gone**. It disappeared in #116, when the SGR
  regex was replaced by the full ECMA-48 grammar. The underlying condition
  survives — the rule still fires at `terminal.ts:179` — so the suppression is
  genuinely needed. It just has nothing to write itself against today.
- "Unsafe `any` flows" is already satisfied: there are **zero** occurrences of
  `: any`, `as any` or `<any>` in non-test `src/`. Type-aware linting, which is
  what would be required to catch that class, buys close to nothing here on top
  of `strict` TypeScript.

## Tool choice

Measured on the tree at `b8b0284`, rather than argued from reputation:

| Tool | Findings out of the box |
| --- | --- |
| oxlint, default (`correctness`) | 5 tree-wide |
| oxlint, `correctness` + `suspicious` | 38 tree-wide, 6 in non-test `src/` |
| Biome | 498 (12 errors, 234 warnings, 252 infos) |

oxlint at `correctness` + `suspicious`. One Rust binary, no plugin graph, whole
tree in well under a second. Biome would need a large suppression config before
it reached green, and a rule set nobody can see the bottom of is one that gets
disabled the first time it is inconvenient.

The `pedantic` tier is deliberately **not** enabled. It produces 359 findings,
80 of them `no-inline-comments`. This codebase's inline comments carry its
design rationale — that tier would fight the house style rather than enforce
it.

No formatter. The acceptance criteria asks only for `npm run lint`.
Auto-formatting ~19.4k lines across 142 files would rewrite nearly every file
and destroy `git blame` on a codebase whose comments are its documentation, to
settle a question nobody is currently getting wrong.

## Two rules off, with reasons

Both are `unicorn` style rules that misfire on this codebase's idioms. Turning
them off in config, with the reason written down, is honest; leaving them on
and sprinkling 32 inline suppressions is not.

- **`unicorn/no-array-sort`** (18 hits) — prefers `toSorted()` because `sort()`
  mutates. It cannot tell a freshly-allocated array from a shared one. At the
  only production site it flags, `cache-key.ts:33`, the array comes straight
  out of `Object.entries().filter()` and no other reference to it exists; the
  rewrite would be a semantic no-op. A rule that is wrong at its only
  load-bearing site is not earning its noise.
- **`unicorn/consistent-function-scoping`** (14 hits) — wants helpers hoisted
  out of the scope they are used in. 13 of the 14 are test helpers placed
  beside the test they serve, which is deliberate and worth keeping.

## Scope

The whole tree: `src/` including its 54 test files, and `scripts/`. `dist/`,
`coverage/` and `node_modules/` are ignored.

Linting tests is the point rather than an afterthought here. This repo's own
history records seven distinct ways a test in it has asserted nothing.

## Changes

Genuine findings, fixed:

- `src/data/daily-cost-tracker.ts:135` — `for (const raw of sessions)` shadows
  an outer `raw` holding the contents of the legacy file. Two unrelated
  meanings of one name in one function. Rename the inner one.
- `src/cli.ts:159,166` — re-throws inside `catch (err)` drop the cause chain.
  The message already interpolates `messageOf(err)`, so a human loses nothing,
  but a programmatic reader does. Add `{ cause: err }`.
- `src/__tests__/renderer.test.ts:953` — one `no-useless-escape`.
- `src/__tests__/non-finite-cost-render.test.ts:53` — confirm the
  `no-loss-of-precision` literal is deliberate before touching it. It is in a
  test about non-finite costs, so it probably is; verify rather than assume.

Deliberate, suppressed inline with a reason:

- Three `no-control-regex` sites — `terminal.ts:179` and two in
  `renderer.test.ts`. Matching control characters is the entire job of the
  sanitiser and of the tests that check it. This restores, against a linter
  that actually enforces it, the suppression #98 noticed had been orphaned.

## Wiring

- `npm run lint` → `oxlint`.
- A `lint` job in `.github/workflows/ci.yml`, matching that file's existing
  convention of separate jobs each carrying a comment on what question it
  answers. It needs no build, so it does not depend on the others.

## The bundle

`cli.ts` and `daily-cost-tracker.ts` are both bundled into `dist/index.js`.
This change therefore requires `npm run build` and `git add -f dist/index.js`
in the same commit. The `bundle-drift` CI job enforces it, and a src-only
commit would leave `git pull` upgraders running the old code.

## Verification

`npm run lint` passing on the current tree proves only that the tree is clean,
not that the gate works — the failure mode this repo has hit repeatedly is a
guard that asserts nothing. So the gate is proved by breaking it: introduce a
violation of a rule in each enabled category, confirm `npm run lint` exits
non-zero on it, and revert.

Plus the existing suite, `npm run typecheck`, `npm run typecheck:scripts`, and
a confirmation that `dist/index.js` matches a fresh build.

## Acceptance criteria

From the issue: `npm run lint` exists, passes on the current tree, and runs in
CI.
