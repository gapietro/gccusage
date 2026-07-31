# Token-efficiency research — design

**Issue:** #49 · **Date:** 2026-07-31 · **Status:** approved, not yet implemented

## Purpose

Decide what a token-efficiency meter should measure, using evidence rather than
intuition, and record the reasoning so the question stays closed. The meter
widget is filed separately and is blocked on this. Building it first would lock
in a metric chosen from a hunch.

The deliverable is two artifacts:

1. `scripts/analyze-transcripts.ts` — a committed, re-runnable analysis instrument.
2. `docs/research/token-efficiency.md` — the findings, with a concrete
   recommendation, thresholds, per-state advice, and an explicit ruled-out list.

This spec covers no changes under `src/`. Nothing here requires an `npm run
build` or a staged `dist/` bundle. If implementation ends up touching `src/`,
that rule applies again and the bundle must be rebuilt and force-added in the
same commit.

## What the corpus actually is

Established by direct inspection on 2026-07-31, correcting the issue's estimate
of "hundreds of transcripts":

| Fact | Value |
|---|---|
| Main-session transcripts | 90, at `~/.claude/projects/<proj>/<sessionId>.jsonl` |
| Subagent transcripts | 555, at `<session>/subagents/agent-*.jsonl` |
| Main sessions with ≥5 assistant turns | 83 — the analysis population |
| Assistant turns in that population | 21,324 |
| Projects | 22 |

Two structural facts matter for the implementation:

- **`isSidechain` is `false` on all 38,069 records inspected.** Subagent work
  cannot be found through that flag; it lives in the `subagents/` subdirectory.
  A reader that trusts the flag will report zero delegation and be silently
  wrong — the same failure mode that made `gccusage today` report zero before
  PR #29.
- Sessions also carry `tool-results/` (spilled large results) and `memory/`
  subdirectories. Neither is part of the token accounting, but a recursive glob
  will pick them up if it is not scoped.

### Preliminary readings

These came from throwaway probes while scoping and are **not** citable results.
The committed script must reproduce them; if it does not, the discrepancy is
itself a finding.

- Cache hit rate across the 83 sessions: p10 93.3%, p50 97.5%, p90 98.9%.
- `cache_read` per turn: p10 49.8k, p50 125.1k, p90 254.8k.
- `cache_creation` per turn: p10 1,575, p50 3,069, p90 8,067.
- `toolUseResult` serialized size: p50 774 B, p90 6.3 KB, p99 24 KB, max 347 KB,
  over 11,181 results.
- Tool call volume is dominated by Bash (5,162), then Edit (1,890).
- Exactly **one** `compact_boundary` record exists in the whole corpus.

The first reading is the reason this research is shaped the way it is. Cache hit
rate — the issue's leading candidate — sits between 93% and 99% in nine sessions
out of ten. A meter showing it would read "97%" indefinitely.

## Approach

Decompose spend first, then choose the signal. The alternative considered was a
straight bake-off of the four candidates in the issue; it was rejected because
the cache-hit-rate reading suggests the answer may not be in that field at all,
and a study that can only pick among four candidates would be forced to
recommend one of them. The bake-off survives as stage 3.

### Stage 1 — Decomposition

Where do tokens actually go?

- Split each turn's input into `cache_read`, `cache_creation`, and fresh
  `input_tokens`; compute what fraction of session spend each represents at
  real per-token prices.
- Attribute context *growth* to its sources: tool results (by tool name and
  size), assistant output, user prompts.
- Characterise the tail of tool-result sizes. A p99 of 24 KB against a p50 of
  774 B means the mean is a bad summary and the tail is where any lever lives.

### Stage 2 — Levers

For each source found in stage 1, ask whether a user can change it *mid-session*.
Candidates to test:

- **Turn count against a large window.** Every turn re-reads the entire context;
  a median session re-reads 125k tokens per turn. If true, the dominant cost is
  turns × window size, not anything about caching.
- **Oversized tool results** — measurable per tool from stage 1.
- **Subagent delegation.** The 555 subagent transcripts allow a direct
  comparison: do sessions that delegate grow their main-context per turn more
  slowly than sessions that do not?
- **Compaction.** With one `compact_boundary` in the corpus, the working
  hypothesis is that auto-compact almost never fires in practice. If that holds
  it is evidence about `compact-countdown` as well as about the meter.

A lever that cannot be pulled mid-session may still be worth reporting, but it
cannot justify a meter.

### Stage 3 — Candidate evaluation

Score the four candidates from the issue, plus anything stage 2 surfaces, on
four axes:

| Axis | Question |
|---|---|
| Dynamic range | Does it move enough across real sessions to be readable? |
| Cost correlation | Does moving it actually change what the session costs? |
| Availability | Live stdin, or transcript-read only? |
| Actionability | If it goes red, what does the user *do*? |

Actionability decides ties. A meter reporting a number nobody can act on is
decoration.

Output includes a ruled-out table with a reason per rejected signal. That table
is the part that stops the question being reopened, so it must be specific:
"cache hit rate — p10-p90 range is 5.6 points, below the resolution of a
statusline segment" rather than "not useful".

### Stage 4 — Thresholds

Derive thresholds from corpus percentiles, not round numbers, and state the
sampling bias plainly: one user, one machine, 83 sessions, work skewed toward
this repo and ServiceNow consulting. A threshold derived from this corpus is a
starting point calibrated to one person, and the doc must say so rather than
implying generality it has not earned.

## The instrument

`scripts/analyze-transcripts.ts`, with an `npm run analyze` alias.

**Runtime.** Plain TypeScript run as `node scripts/analyze-transcripts.ts`.
Node ≥23.6 strips types natively, so this needs no new dependency. The repo's
`engines` field says `node >=18` and `npm run dev` invokes `bun`, which is not
installed on this machine; the script header must state the Node version it
needs so a contributor on Node 18 gets an explanation rather than a syntax error.

**Parser.** Its own minimal streaming parser, not `src/data/jsonl-reader.ts`.
The research needs fields that reader discards — `durationMs`, `toolUseResult`
sizes, `compact_boundary` system records, and the `subagents/` files. Keeping
the research parser out of `src/` also keeps it out of the shipped bundle. If
the meter later needs any of this logic, it moves into `src/` at that point,
with the rebuild that implies.

**Output.** `--json` for machine-readable aggregates; default output is markdown
tables that can be pasted into the findings doc. Every figure in the doc must be
reproducible from one of these two modes.

**Anonymisation.** Project directory names map to stable `proj-a`…`proj-v`
labels via a sorted-order assignment, so reruns are consistent. Only numeric
aggregates and tool names reach the output. No prompt text, file contents, file
paths, or directory names. This is a public repo and the corpus includes client
work.

## The findings document

`docs/research/token-efficiency.md`, in this order:

1. **Recommendation and thresholds** — up front, before the evidence. A reader
   deciding what to build should not have to read four stages of analysis first.
2. **What the corpus is**, including its biases.
3. **Decomposition** — where tokens go.
4. **Levers** — what a user can change mid-session.
5. **Candidate evaluation**, including the ruled-out table.
6. **Per-state advice** — for each state the recommended meter can show, the
   action it implies.
7. **Limitations** — what this corpus cannot answer.
8. **Reproducing** — how to re-run `npm run analyze`.

## Done means

- `npm run analyze` runs clean from a fresh checkout on Node ≥23.6 and prints
  both output modes.
- Every number in the findings doc traces to script output; no figure appears
  that the script cannot regenerate.
- The doc names a specific recommended signal, its thresholds, and the advice
  each state implies — or states positively that no signal qualifies and gives
  the reason.
- The ruled-out table covers all four candidates from the issue with a specific
  reason each.
- `#47`'s dormant `cache-hit-rate` widget is explicitly dispositioned: keep as
  foundation, or retire.
- `npm test` and `npm run typecheck` pass.

## Out of scope

- Building the meter widget itself — separate issue, blocked on this.
- Changing any default layout.
- Acting on the `compact-countdown` implications, beyond recording them.
- Fixing `npm run dev`'s dependency on an uninstalled `bun`.
