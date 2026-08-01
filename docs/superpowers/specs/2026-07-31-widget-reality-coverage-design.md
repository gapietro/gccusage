# Widget reality coverage (#47)

**Date:** 2026-07-31
**Issue:** [#47](https://github.com/gapietro/gccusage/issues/47)
**Status:** approved

## Problem

`src/widgets/registry.ts` registers 25 widget types. `src/config/defaults.ts` uses 10.
Three of the remaining 15 cannot have a default by nature (`separator`, `custom-text`,
`custom-command`). The other **12 are data widgets that never run** unless a user
hand-writes `~/.config/gccusage/settings.json`.

They are registered, documented, and unit-tested — against hand-written fixtures that
encode what we *believe* a Claude Code payload looks like. That belief has been wrong
before: `compact-countdown` measured cumulative session tokens instead of context
occupancy and would have reported nonsense the moment anyone looked, but it was in no
default layout so nobody did. It was caught only when PR #38 promoted it to the default
bar, and its threshold constant then turned out to be wrong too (#37, fixed in #45).

## What the investigation established

A real payload was captured from Claude Code **2.1.220** by temporarily pointing
`statusLine.command` at a wrapper that tees stdin (23 payloads, several sessions, two
models). All 25 widgets were then rendered against it.

**No widget crashed. Every one returned a plausible-looking string.**

```
tokens-input      "In: 122"          tokens-output    "Out: 37.7k"
token-breakdown   "In:117.3k Out:3"
cache-hit-rate    "Cache: 99%"       tokens-cached    "Cache: 5.24M"
session-clock     "28m 9s"           session-timer    "27m 44s"
api-latency       "API: 8m 26s"
cwd               "~/projects/gccusage/src/widgets"
```

This is the decisive result. The issue proposed asserting that each widget produces
"either a sensible non-empty output or a deliberate `null`". **That assertion passes on
all 25 and finds nothing.** The defects in this codebase are not crashes; they are
plausible wrong numbers. A smoke test is therefore rejected in favour of exact expected
text per widget.

Two premises in the issue were also found to be false:

- `~/.cache/gccusage/statusline-cache.json` does **not** hold a real payload. It stores
  the rendered ANSI output, `timestamp`, `sessionId` and `costUsd`. There is no captured
  stdin anywhere on disk, which is why a live capture was required.
- The payload carries `workspace`, `rate_limits`, `session_name`, `effort`, `thinking`,
  `version` and more. **`src/types/status-json.ts` parses 7 fields and silently drops the
  rest**, so some of the right data sources are not reachable today.

## Design

### Fixtures

`src/__tests__/fixtures/real-payloads/*.json` — **three** sanitized captured payloads,
chosen for spread rather than volume: a mid-session 1M-window Opus 5 payload (the richest,
and the one the findings above were derived from), a second model (`claude-fable-5`) to
catch model-name handling, and a low-occupancy payload to exercise the no-alert colour
bands. Alongside them, `capture.md` records the Claude Code version, capture date and the
wrapper method, so the corpus can be refreshed rather than trusted indefinitely.

Sanitization replaces the home path, `session_id`, `prompt_id`, `session_name` and
`workspace.repo` owner/name. Some payloads originated in other concurrent sessions, so
this is a privacy requirement, not tidiness. Numbers and structure are preserved exactly.

Sanitized paths are rooted at `/home/testuser/...` and the matrix sets `HOME` to match, so
the `cwd` widget's `~` abbreviation is genuinely exercised and deterministic.

### `src/__tests__/widget-reality.test.ts`

Four parts.

**1. Expectation table** — one entry per registered widget type:

```ts
{ type: "token-breakdown", expect: "renders", text: "In:117.3k Out:3",
  why: "reads context_window totals, which are a last-message snapshot",
  knownWrong: 58 }
```

**2. Matrix** — every widget rendered against every payload, asserting exact text.

**3. Completeness guard** — the table's keys and `getWidgetTypes()` must match in *both*
directions. A 26th widget cannot be registered without an entry, and a deleted widget
cannot leave a stale one. This forces an expectation to exist for every registered
widget and locks current behaviour against regression, which stops the *dormancy* from
recurring. It does not by itself detect a widget that is wrong from the start: the table
records current behaviour, so a widget that is wrong on day one gets its wrong output
recorded as the expectation and the suite goes green. Catching that requires a human
independently deriving the correct value — which is how #58-#63 were found — a process
step, not a test.

**4. Pipeline case** — one fixture driven through the real `runStatusline` with hermetic
`HOME` and `XDG_CACHE_HOME`, a seeded JSONL transcript and mocked pricing. This proves
`buildRenderContext` completes on a real payload hermetically, and that the key set the
matrix reconstructs matches the key set the real pipeline produces (that binding is
real — the key list is derived from `contextFromFixture`, not hardcoded). It does not
prove the *values* the matrix assumed match production: under a hermetic `HOME` there
are no transcripts, so every derived value is zero and the test reduces to key-presence
and type checks.

### `knownWrong`

Widgets confirmed to be wrong still assert their **current** output, tagged with the
issue number that tracks the defect.

Without this the choice is between a permanently red suite and invisible bugs. With it
the suite stays green, the defect is visible at the point where someone would read the
behaviour, and fixing it forces a deliberate table edit — which is exactly the moment to
notice the linked issue.

### Determinism

- `vi.setSystemTime` from a `derivedAt` field pins `session-clock` and `block-timer`.
  `derivedAt` is the instant the derived context was computed, not the instant the
  stdin payload was captured (the two can be ~30 minutes apart).
- `git-branch` / `git-changes` run against a scratch repo with a known branch and diff.

No widget falls back to a shape-only assertion.

## Findings to file, not fix

Fixing these here would spread the diff across 12 widgets and fold in design decisions
that deserve their own discussion. Each is filed with its failing evidence.

| Widget | Evidence | Severity |
|---|---|---|
| `token-breakdown` | `Out:3` in a $4.32 session whose real output was 37,659 tokens — a last-message snapshot presented as session totals | compact-countdown class |
| `cwd` (blocks #48) | Real `cwd` is `.../gccusage/src/widgets`, so basename is `widgets`, not `gccusage` | blocks #48 as written |
| `cache-hit-rate` vs `tokens-cached` | Both label `Cache:`, mean different things | label collision |
| `session-clock` vs `session-timer` | `28m 9s` vs `27m 44s` — same concept, two sources | redundancy |
| `api-latency` | Cumulative 8m 26s labelled `API:`, reads as per-request latency | misnamed |
| `per-model` | `"Sonnet 4.5"` and `"Sonnet 4"` both shorten to `S4` | collision |

**#48 must be respecified before it is built.** It specifies the basename of `stdin.cwd`,
which yields `widgets` — the wrong answer to "which project is this?". The correct source
is `workspace.project_dir`, which the schema does not currently parse.

Also unparsed and plausibly useful: `rate_limits.five_hour` and `rate_limits.seven_day`,
each with `used_percentage` and `resets_at`.

## Out of scope

- Fixing the six findings above.
- Extending the schema for `workspace` / `rate_limits`. Both belong to the follow-ups that
  consume them, not to the test harness.
- Promoting any widget to a default layout (#48).
- Deleting widgets. The audit informs that decision; it does not pre-empt it.

## Success criteria

1. All 25 registered widgets have an exact expected output against at least one real payload.
2. The completeness guard fails when a widget is added or removed without a table entry.
3. Every confirmed defect is filed with a linked `knownWrong` entry.
4. `npm test`, both typechecks and `npm run build` pass; `dist/index.js` is rebuilt and
   staged if `src/` changes.
