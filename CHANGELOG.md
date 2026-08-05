# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gapietro/gccusage/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gapietro/gccusage/releases/tag/v1.0.0
