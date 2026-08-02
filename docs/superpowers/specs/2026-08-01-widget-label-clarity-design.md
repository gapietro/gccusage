# Widget label clarity (#60, #61, #62, #63)

**Date:** 2026-08-01
**Issues:** #60, #61, #62, #63 — all surfaced by the #47 widget reality harness

## Problem

Four of the twelve widgets that render in no default layout produce output a
user cannot correctly read:

| # | Widget(s) | Symptom |
|---|-----------|---------|
| 60 | `cache-hit-rate`, `tokens-cached` | Both label their output `Cache:` — a percentage and a token count, indistinguishable side by side |
| 61 | `session-clock`, `session-timer` | Both render a bare duration; the two numbers disagreed by 27 minutes on a real payload |
| 62 | `api-latency` | `API: 35m 5s` reads as one request's latency; it is cumulative session API time |
| 63 | `per-model` | First-letter-per-word shortening collapses `Sonnet 4.5` and `Sonnet 4` to the same `S4` |

## What the binary says about #61

The issue proposed retiring `session-clock` on the theory that both widgets
measure the same thing from different sources. Disassembling Claude Code
2.1.220 shows they do not:

```
total_duration_ms  →  sMe()  =  Date.now() - Mt.startTime
Mt.startTime       →  set at process init, reset by $bi()
```

Claude Code separately tracks `sessionLogicalStartTime` (read by `XCt()`), and
`total_duration_ms` deliberately does **not** use it. So:

- `session-timer` (`cost.total_duration_ms`) — since this CLI **process**
  started. Resets on restart and on `--resume`.
- `session-clock` (`sessionStartTime`, the transcript's first JSONL timestamp)
  — since the **logical session** began. Survives resume.

The fixture's 2hr13m vs 1hr46m is a session resumed 27 minutes in, not a
defect. Retiring either widget would delete a measurement the other cannot
make, so #61's recommendation rests on a false premise.

## Design

**#60** — both defaults change, so the ambiguity is gone from either
direction: `cache-hit-rate` → `Hit:`, `tokens-cached` → `Cached:`.

**#61** — keep both widgets; give each a default label naming its origin.
`session-clock` → `Session:`, `session-timer` → `Up:`. The labels are what
carry the distinction, so both stop defaulting to no label. `label: ""` is not
nullish, so explicit opt-out still works.

**#62** — default label `API:` → `API total:`. The registry key stays
`api-latency`: renaming the widget type would break existing user layouts for
a cosmetic gain, and the complaint is about displayed text.

**#63** — remove the abbreviation rather than improve it (user decision).
`per-model` renders `formatModelName`'s output verbatim: `Opus 5:$22.52`,
`Sonnet 4.5:$3.40`. Nothing is collapsed, so nothing can collide, and an
unrecognised model id renders in full instead of as a single letter.

## Testing

1. `widget-expectations.ts`: six entries updated; `knownWrong: 60/61/62/63`
   dropped. No entry carries `knownWrong` after this — the field stays as the
   mechanism for the next defect the harness surfaces.
2. `per-model` unit tests covering the exact #63 collision (two versions of one
   family staying distinct) and the unrecognised-id fallback.
3. Session-clock/timer unit tests for the distinct defaults and the `label: ""`
   opt-out.
4. **A guard generalizing #60**: render every widget against the fixture,
   extract each leading alphabetic `Word:` label, assert no two widgets share
   one. Verified non-vacuous by mutation — reintroducing a duplicate label
   fails it.

   Known limits: labels are read from rendered text (each default lives inline
   as `config.label ?? "..."` and is not exported), so widgets that decline on
   the fixture are not covered. One collision is allowlisted with its reason —
   `tokens-input` and `token-breakdown` both lead with `In:`, because
   `token-breakdown` is the compound form of the single-metric widgets by
   design.

## Out of scope

No widget is removed and no registry key is renamed, so no existing user config
breaks. Default layouts are untouched; all six widgets remain non-default.
