# Build badge — `MMDD.<pushes today>`

## Problem

The README carries no badges. `package.json` says `0.2.0`, but nothing on the
GitHub page tells a reader how recently the repo moved or how much churn a day
carries. The wanted signal is a *build* number in the form `MMDD.<count>`, where
the count is how many times main has been pushed on that date.

## What ships

Two badges at the top of `README.md`, regenerated on every push to `main` by a
GitHub Action:

```markdown
<!-- badges:start -->
![version](https://img.shields.io/badge/version-0.2.0-blue)
![build](https://img.shields.io/badge/build-0801.3-brightgreen)
<!-- badges:end -->
```

Both values are baked into the URL, so the badge renders from shields' static
endpoint with no lookup against this repo and no cache lag on the value itself.

### The number

`MMDD.N`, where `N` counts pushes to `main` on that local date and resets to 1
on the first push of a new day. `0801.3` is the third push on August 1st.

The date is **America/New_York**, not UTC. The repo already keys
`daily-costs.json` on the local date, and a UTC badge would roll over at 8pm
local — resetting a count whose day had not finished. The zone is a `ZONE`
constant in `scripts/lib/build-badge.ts`, resolved through `Intl`, rather than a
`TZ` environment variable in the workflow: one source of truth, and testable
without mutating the environment.

### Version badge

Read from `package.json` on every run, so `npm version` bumps appear on the next
push instead of drifting. Shields' path escaping is applied (`-` → `--`,
`_` → `__`), so a prerelease like `1.0.0-rc1` does not break the URL.

## Components

### `.github/build-number.json` — state

```json
{ "date": "2026-08-01", "count": 3, "build": "0801.3" }
```

`build` is denormalized from `date` and `count` so the file is greppable and a
test can assert the three stay consistent.

### `scripts/lib/build-badge.ts` — the logic, pure

- `todayInZone(now, zone): string` — the `YYYY-MM-DD` date in `zone` at instant
  `now`, via `Intl`, so the zone is explicit rather than inherited.
- `nextBuild(state, today): BuildState` — same date → `count + 1`; different
  date → `{ date: today, count: 1 }`; missing, malformed, or partial state →
  treated as a fresh day. A badge is not worth failing a push over, and the
  next push self-corrects.
- `formatBuild(date, count): string` — `2026-08-01` + 3 → `0801.3`.
- `renderBadges(readme, { version, build }): Result` — replaces the block
  between the markers. Returns an error result when a marker is missing rather
  than appending or silently returning the input unchanged.
- `shieldsEscape(value)` — `-` → `--`, `_` → `__`, spaces → `_`.

Follows the `scripts/lib` convention already set by `cli.ts`: pure functions,
`{ ok, error }` result objects, `.ts` import specifiers.

### `scripts/build-badge.ts` — the entry point

Thin `main()`: read state, read `package.json`, read README, call the pure
functions, write both files. Exits non-zero with a message on any error. Run as
`node scripts/build-badge.ts` (native type stripping, same as `npm run analyze`)
and wired as `npm run badge`.

### `.github/workflows/build-badge.yml` — the trigger

- `on: push: branches: [main]`
- `permissions: contents: write`
- `actions/checkout@v4` with `ref: main` and `fetch-depth: 0` — the job must
  count from the branch tip other runs have already stamped, not from the
  commit that triggered it.
- `actions/setup-node@v4` pinned to Node 24, since the script is a `.ts` file
  Node must strip types from.
- A retry loop, up to 5 attempts: fetch, `reset --hard origin/main`, run the
  script, commit, push. Resetting *first* is what makes a retry correct rather
  than merely repeated — a rejected push means another badge commit landed, so
  the count this attempt computed is stale and must be discarded, not rebased
  forward. Commit message `chore: build 0801.4 [skip ci]`.

**No `concurrency` group.** It reads as the right tool for "two runs must not
share a count", but it cannot be: a run reads the repository at checkout, and
serialising *execution* does not refresh a snapshot. Worse, GitHub cancels a
run that is already pending when a newer one queues behind an in-progress run —
`cancel-in-progress: false` only protects runs that have started — so a burst of
pushes loses counts to the mechanism meant to protect them. Correctness comes
from the retry loop, and a rejected push serialises the runs instead of a queue.

Both failure modes were reproduced against real git repositories before the fix
and after it: two interleaved human pushes moved the count by 1 under the
snapshot-plus-concurrency design, and by 2 under this one.

## Loop guard

A push authenticated with `GITHUB_TOKEN` does not create a workflow run. That
is GitHub's own recursion guard, it needs nothing from the workflow, and it is
what stops the bot's commit from triggering another stamp. The job additionally
guards on `github.actor != 'github-actions[bot]'`.

The bot's commit message deliberately does **not** carry a skip marker. That
was the first design and it failed on its own first run: GitHub's native skip
matches the phrase anywhere in a commit message, prose included, so the merge
commit that introduced this workflow — which only *described* the mechanism —
skipped itself and stamped nothing. A guard that any commit message can trip by
talking about it is not a guard.

One consequence survives and cannot be fixed here: a human commit whose message
contains the literal phrase is skipped by GitHub before this workflow is
consulted, and that push goes uncounted.

## Accepted costs

- Every push to `main` is followed by a bot commit, so the next push needs a
  `git pull` first or it is rejected as non-fast-forward.
- Only `main` counts. Branch and PR pushes do not move the number.
- The count is not a total; `0802.1` follows `0801.9`. It orders builds within a
  day, and the date orders the days.

## Seeding

The first commit ships `build-pending-lightgrey` and
`{ "date": "", "count": 0, "build": "" }` rather than a fabricated number. The
first real push to `main` replaces both with `MMDD.1`.

## Testing

`scripts/__tests__/build-badge.test.ts`, collected by the existing
`scripts/**/__tests__/**` glob in `vitest.config.ts`:

- `nextBuild`: same-day increment, new-day reset, missing file, malformed JSON,
  partial state, and that the emitted `build` string matches its own `date` and
  `count`.
- `renderBadges`: replaces the block, is idempotent across repeated runs, errors
  on a missing start or end marker, and leaves the rest of the README untouched.
- `shieldsEscape`: dashes and underscores in a version.
- End-to-end: spawn `process.execPath` against `scripts/build-badge.ts` in a
  temp directory, guarded by `nodeRunsTypeScript`, to catch the `.js`-vs-`.ts`
  specifier trap that vitest resolves silently but the real CLI does not.

## Out of scope

No `src/` changes, so no `dist` rebuild. No test-running CI — the repo has no
workflows today and this one exists to update a number, not to gate merges.
