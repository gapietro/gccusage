# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Remediation of the 2026-11-16 audit (see AUDIT.md).

### Added

- Subagent transcripts are read. Claude Code writes Task and workflow agents'
  usage to separate files beside the session transcript
  (`<session>/subagents/…`); calculated costs, the token widgets, per-model
  figures and `gccusage today` now include them. Each transcript file's
  totals are cached, so only files that changed are re-read (COR-007).
- The burn rate carries the `?` marker when the calculated session cost it
  comes from is incomplete (COR-008).
- `GCCUSAGE_DEBUG=1` also names a widget whose render failed and any relative
  `XDG_*` value that was ignored.

### Changed

- The calculated burn rate is the session's per-model cost over its elapsed
  time, so it matches the session total whichever model is current. It used
  to price every token at the current model's rate: the same session read
  $10.00/hr or $2.00/hr depending on `/model` (COR-008).
- `Today:` is tracked per Claude Code process for costs Claude Code reports,
  and its `?` marker is stored per session, so an incomplete or stale figure
  is marked on every session's bar (COR-005, COR-009).
- Cache files are created readable by you only (files `0600`, directories
  `0700`); an existing cache directory is narrowed in the background (SEC-003).
- `setup` keeps `settings.json`'s permissions (never group- or
  world-writable), writes the `.bak` as `0600`, and writes through a symlinked
  `settings.json` to its target instead of replacing the link. A target in a
  read-only directory is refused with an explanation (SEC-003).
- `npm install` no longer builds `dist/index.js` (it is committed), which also
  fixes `npm install -g github:gapietro/gccusage` failing without the build
  toolchain (OPS-009).

### Fixed

- A daily cost store that cannot be written (a root-owned or full cache
  directory) no longer erases the whole bar on every render; `Today:` is
  marked `?` instead (REL-005).
- Two terminals on one session (`--resume` in a second window) no longer
  inflate `Today:` without bound; one case showed $16.50 for $6.40 of spend
  (COR-005). A forked or long-idle resumed session's restored cost is not
  counted as today's, and a calculated total that falls because prices
  changed is no longer read as a restart.
- A cache timestamp in the future (a clock set backwards) or one JSON reads as
  `Infinity` no longer freezes pricing, serves an old bar past its TTL, or
  pins the block timer; the session clock shows `Session: ?` instead of a
  negative time (COR-006).
- A widget that fails costs only its own segment instead of the whole bar,
  and a context usage over 100% renders a full bar instead of nothing
  (REL-007). A failed pricing-refresh spawn no longer exits 1 with a stack
  trace (REL-006). Interrupted cache writes no longer leave temporary files
  behind, and old ones are swept (REL-008).
- With `HOME` empty or unset, configuration is no longer read relative to the
  current directory, or from a shared temporary directory, where a repository
  or another user could plant a `custom-command` (SEC-004).
- Pricing tables built from the feed no longer take on a prototype from a
  `__proto__` model id (SEC-005).
- `~` is shown for the home directory only on a path boundary: with home
  `/home/u`, `/home/u2/x` was shown as `~2/x`.

### Upgrade notes

- Downgrading to 1.2.0 or earlier after running this version can count part
  of today twice until midnight: older versions read the per-process daily
  records (`~/.cache/gccusage/daily/*.p*.json`) as extra sessions. Delete
  those files after a downgrade.
- The today-aggregate cache is rebuilt once after upgrading.

## [1.2.0] — 2026-11-12

### Added

- `GCCUSAGE_GIT_TIMEOUT_MS` (default 2000) overrides how long each `git` call
  behind the `git-branch` and `git-changes` widgets may take before the
  segment drops out, for repos where `git status` is legitimately slow (#146).

### Fixed

- A widget `type` or `powerline.theme` named after a JavaScript built-in
  (`constructor`, `toString`, `__proto__`, ...) no longer erases the whole bar:
  the widget is skipped and the theme falls back to `default`, exactly as for
  any other unknown name (#143).
- A model id named after a JavaScript built-in is now treated as unpriced.
  Previously it was costed as `NaN`, so the session and Today totals rendered
  `$?` (dropping the part that was priced), the burn rate rendered `$?/hr`,
  and the session's daily-store entry was written unreadable. It now renders
  like any unknown model: the priced part, with the `?` uncertainty marker on
  the session total (#143).
- A transcript token count too large to represent (such as `1e400`) or
  negative is now treated as missing. Previously it made the calculated
  session cost non-finite: the bar rendered `$??`, and the session's
  daily-store entry was written unreadable, so its spend dropped out of every
  session's `Today:` and its start-of-day baseline was lost (#145).
- If a session cost still comes out non-finite (valid counts that overflow
  once priced and summed), the daily store keeps the session's last good
  entry. The session renders a single `$?`. Unless `costSource` is
  `"calculated"`, `Today:` shows the last good figure with the `?` marker
  (#145).
- A cost shown as `$?` keeps its configured background colour. It used to
  turn red when the value had overflowed, but not when it was `NaN` (#145).
- With `costSource: "calculated"`, a transcript whose token counts overflow
  no longer invalidates the cache of today's totals. Before, every render
  re-read every transcript for the rest of the day (#145).

## [1.1.0] — 2026-11-10

### Added

- `effort` widget: the session's reasoning-effort level, read from Claude
  Code's statusline payload, on a per-level colour. In the default layout
  directly after `model`; hidden for models without effort support (#139).
- `GCCUSAGE_DEBUG=1` prints, on stderr, whatever error made the statusline
  render nothing, so a bar that has disappeared can be diagnosed. Off by
  default (OPS-006).

### Changed

- Default layout: `burn-rate` moved from line 1 to line 2, after
  `today-spend`, to make room for `effort` (#139).
- At 80 columns the busiest line 2 now shortens `project` and `git-branch`
  sooner, and with vim mode on and a busy git status the end of line 2 can be
  cut. Move to a wider terminal or use a custom layout to avoid it (#139).

### Fixed

- A `vim` mode named after a JavaScript built-in (`constructor`, `toString`,
  `__proto__`, ...) no longer erases the whole bar; the segment renders on the
  NORMAL colour. The renderer now also drops any non-string segment colour
  rather than failing the render, so one bad widget costs its colour, not the
  bar (#141).
- A stdin stream that fails mid-read now renders `⚠ gccusage  could not read
  stdin — <error>` instead of an empty bar (REL-004).

### Resolved known limitations

- CI now runs on every pull request and push to `main` and is required to
  merge; the 1.0.0 note that it had never run no longer applies.
- The render path has a debug flag (`GCCUSAGE_DEBUG`, above), and a stdin
  failure renders a diagnostic instead of nothing.

## [1.0.0] — 2026-08-05

First tagged release. The tool has been in daily use since 2026-02-23; 1.0.0
marks the point where its behaviour under failure is defined and tested rather
than incidental, not the point where the features arrived.

### Added

- `--version` / `-v` and `--help` / `-h`. Both previously exited 1 with
  "Unknown command"; there was no way to ask the binary what version it was.
- 26 widgets — model, session and daily cost, burn rate, context percentage and
  window size, git branch and changes, token counts and breakdown, cache hit
  rate, lines changed, vim mode, API latency, timers, auto-compact countdown,
  turn counter, and free-form text/command segments.
- `gccusage setup`, which points Claude Code's `statusLine.command` at the
  committed bundle, writes a `.bak` of the previous settings, and resolves a
  Node path that survives a `brew upgrade`.
- `gccusage today`, a per-model daily usage report.
- Five themes, configurable layouts, per-widget colours, compact and flex modes,
  and a generated `config-schema.json` for editor completion.

### Fixed

The 20 findings of the 2026-08-01 production-readiness audit, and the 18 issues
they spun off. The ones that changed user-visible behaviour:

- Concurrent sessions no longer lose the day's spend — the store is sharded per
  session and every write is atomic (temp file + rename).
- A blackholed pricing endpoint no longer stalls the render for ~10.5 s. The
  render path does no network I/O at all; a detached child refreshes prices out
  of band. Measured 40 ms to process exit with the endpoint refused.
- Costs no longer collapse to `$0.00` when the network is unavailable: an
  offline pricing snapshot ships in the bundle, and genuinely unpriced usage is
  marked `?` rather than silently counted as free.
- Above-200k-token and 1-hour-cache pricing tiers are applied per request, so
  long-context sessions are no longer under-costed (+7.5 % corpus-wide).
- Wide characters (CJK, emoji, flags) are measured in terminal columns rather
  than UTF-16 code units, so the bar no longer overflows the terminal.
- Arbitrary escape sequences from `custom-command` output can no longer reach
  Claude Code's TUI — widget text passes an SGR-only allowlist.
- A slow or truncated stdin payload renders a diagnostic line instead of a
  confident `$0.00` beside a non-zero `Today:` figure.
- Malformed input degrades per field rather than per bar: one bad stdin field
  costs that field, and non-finite numbers are rejected at the schema instead of
  rendering as `Infinity`.
- Every cache file is validated against a schema on read, so a corrupt or
  hand-edited cache cannot blank the bar or poison cost maths.
- `setup` refuses to proceed on an unusable `settings.json` instead of
  reporting success having silently clobbered it.

### Known limitations

- **CI has not run.** The five-job workflow (tests on Node 22/24, lint,
  coverage, bundle-drift) is authored and correct but blocked by a GitHub
  account billing failure, so every gate is currently verified by hand against
  a clean clone on Node 22 and 24 before merge.
- The render path has no logging and no debug flag: an internal failure exits 0
  with no output, which Claude Code renders as an erased bar.
- Windows is not supported. `setup` writes a POSIX shell string and the Node
  path resolver does not handle `.exe`.

[Unreleased]: https://github.com/gapietro/gccusage/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/gapietro/gccusage/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/gapietro/gccusage/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/gapietro/gccusage/releases/tag/v1.0.0
