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
- `concurrency: { group: build-badge, cancel-in-progress: false }` — two pushes
  landing together must not both read the same count and write the same number.
  Never cancel in progress: a cancelled run drops a push from the count.
- `actions/setup-node@v4` pinned to Node 24, since the script is a `.ts` file
  Node must strip types from.
- Runs the script; commits and pushes only when the files changed, with message
  `chore: build 0801.4 [skip ci]`.

## Loop guard

The bot's own push carries `[skip ci]`, which GitHub honours natively for push
events, so it does not trigger another run. The workflow also guards on
`!contains(github.event.head_commit.message, '[skip ci]')` in case that
behaviour is ever disabled. Consequence, and it is the intended one: the count
measures *human* pushes.

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
