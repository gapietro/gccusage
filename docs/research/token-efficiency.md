# What a token-efficiency meter should measure

Research findings for [#49](https://github.com/gapietro/gccusage/issues/49). Generated from
`npm run analyze` over the local Claude Code transcript corpus on 2026-07-31.

Every figure below comes from that script. Figures marked † are not printed by
`npm run analyze` but are derived from the per-session rows in `npm run analyze -- --json`;
§10 gives the exact command that reproduces them.

---

## 1. Recommendation

**Do not build a token-efficiency meter. No candidate signal qualifies.**

A meter can only flag waste it can see, and there are two kinds in play. *Cache-rebuild* waste —
paying to re-write context the cache should have been holding — is what a hit rate measures, and
it is close to absent here: the cache hit rate is 98.0% at the median and 94.5% at the *tenth
percentile* across 83 sessions. That rules out the cache-shaped candidates and nothing else.
*Context-size* waste — carrying more context than the task needs — is fully cached by
construction, so it is invisible to a hit rate no matter how large it gets, and it is both the
dominant cost in this corpus (cache reads are 65.1% of session cost at the median, §4) and the
one genuinely actionable lever (§6). The case against a meter cannot rest on "caching works"; it
rests on what happens when you try to build a signal for the waste that does matter.

That attempt runs into a structural fact. Cost here is, near enough, a sum over assistant turns
of (context read × 0.1 + output × 5). Turn count is therefore a *factor in the product*, not an
independent predictor of it, and the 0.924† correlation between assistant turns and session cost
is an identity check on the decomposition rather than a finding about how sessions are run. It
cannot separate "this session cost a lot because a lot was asked of it" from "this session cost
a lot because it was run badly", since a badly-run session also takes more turns. Nothing in
this corpus separates those two, which is the first reason no threshold in it can be calibrated
into a judgement about efficiency.

The two quantities that multiply out to cost — how big the context is, and how many turns run
against it — are both already on the status bar: `context-percent` shows the first, and
`compact-countdown` (#45) shows how many tokens of headroom remain before auto-compact. The
strongest signal in the study, `cache-read-per-turn` (dynamic range 213,276; cost correlation
0.84), is essentially a re-encoding of those two: it correlates 0.877† with turn count, so it
mostly restates "this session is long and its context is large" — as an uncalibrated rate rather
than in tokens against the real threshold.

Availability rules nothing in or out. Claude Code 2.1.220 builds the statusline payload's
`context_window` block from the **last assistant message's usage alone**, with no
session-cumulative token totals anywhere in it, so every candidate scored here has a single-turn
live analogue and none of them is exactly computable live (§7). What does bite is calibration:
every number below is a session aggregate over one person's 83 sessions, and a live widget would
be reading a single-turn sample against it.

## 2. Thresholds and what each state means

Since the recommendation is to build nothing, this section shows the threshold table the best
candidate would have produced, and what each state implies. It is the concrete form of the
argument in §1, not a build instruction.

The candidate is the study's strongest signal, `cache-read-per-turn` (p10 59,416, p50 131,357,
p90 272,692, max 527,629, cost correlation 0.84). It is used here rather than a cache-share
signal because availability no longer narrows the field — no candidate is exactly computable
from a live payload, and each has a single-turn analogue that is (§7). Boundaries are the
observed decile edges, not round numbers.

| State | Range | What it means | What the user does mid-session |
| --- | --- | --- | --- |
| Low | ≤ 59,416 tokens/turn (bottom decile) | A short or freshly-started session: the window is still small, so each turn re-reads little. The eight sessions in this decile run 5 to 33 assistant turns, median 13†. | **Nothing.** The rate rises on its own as the session runs; there is no action that keeps it low except not working. |
| Normal | 59,416 – 272,692 | What a working session looks like. Eight of ten sessions live here. | **Nothing.** This is the null state and it covers 80% of sessions. |
| High | ≥ 272,692 (top decile) | The context is large and every turn re-reads all of it. These sessions run a median of 381 assistant turns† — the state is "this session is long", arriving late. | Shrink the context or start a fresh session — **which is exactly the advice `compact-countdown` already gives**, in tokens remaining before auto-compact rather than as a rate with no threshold attached. |

Two of the three states imply no action. The third duplicates a widget that is already in the
default layout and states the same thing more precisely. That is the case against the meter, in
one table.

There is also a calibration problem that applies to every candidate. These figures are session
means over all of a session's assistant turns; a live payload carries the *latest* turn's usage
(§7). A boundary fitted to a mean is not a valid boundary for a single sample of the thing being
averaged — a session at 250,000 tokens/turn on average will still cross 272,692 on individual
turns, and the widget would flip states on turn-to-turn noise. Re-cutting this corpus per turn
to derive live-valid boundaries is possible in principle, since transcripts carry per-turn usage;
this study did not do it, so no number in this table should be shipped as a threshold.

## 3. What the corpus is

| | |
| --- | --- |
| Projects contributing sessions | 12 |
| Main session transcripts | 92 |
| Subagent transcripts | 591 |
| Sessions analysed (≥ 5 assistant turns) | 83 |
| Assistant turns analysed | 10,363 |
| Compaction boundaries observed | **1** |

There are 22 project directories under `~/.claude/projects/`; only 12 contain a top-level
session transcript; the other 10 hold only auxiliary files (a `memory/` directory or a
`sessions-index.json`) and contribute nothing. Sessions with fewer
than 5 assistant turns are excluded as too short to characterise, which drops 9 of the 92.

The sample is skewed. Of the 83 analysed sessions, 10 project labels appear at all, and three
projects supply 54 of them (26, 17, and 11)† — this repository and ServiceNow consulting work.
One user, one machine, one working style. **Any threshold derived from this corpus is
calibrated to one person**, and that is the single largest reason not to ship a number derived
from it as a default.

Project labels are anonymised (`proj-a`…) by the analysis script and real directory names never
leave `discover.ts`.

### What counts as one assistant turn

A "turn" here is one API response, keyed on `message.id` — not one transcript line. Claude Code
writes a single response as several assistant lines, one per content block (`thinking`, `text`,
each `tool_use`), and **every one of those lines repeats the same `message.usage` object
verbatim**. On this corpus that is 21,936 lines carrying usage against 10,371 distinct
`message.id` groups — counted across all 92 transcripts, so before the ≥ 5-turn filter that
produces the 10,363 above. A line-per-turn parser overcounts by 2.12x, and overcounts
non-uniformly, since a response with more content blocks contributes more copies. In 6,158
multi-line groups not one disagreed on its usage numbers, so deduplicating on `message.id`
loses nothing.

This mattered: the first version of this document was written from a line-counting parser and
roughly half its figures were wrong — turn counts inflated, per-turn rates deflated, and shares
distorted toward whichever component happened to co-occur with block-heavy responses. Anyone
re-running the instrument, or reading token totals out of a Claude Code transcript by any other
route, has to deduplicate first.

### The `isSidechain` finding

Subagent work is discovered through the `subagents/` directory, not through the transcript's
`isSidechain` field. That field is `false` on every record in this corpus. A reader that trusts
it concludes there was zero delegation and is silently wrong — the corpus in fact contains 591
subagent transcripts. This is documented in `scripts/lib/discover.ts` so the next reader does
not rediscover it the hard way.

## 4. Where the tokens go

Share of session cost in input-token-equivalents (output 5x, cache write 1.25x, cache read
0.1x — ratios rather than dollar prices, so the result is model-independent):

| Component | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Cache reads | 45.1% | 65.1% | 77.0% | 83.2% |
| Output | 12.6% | 17.5% | 24.6% | 40.5% |
| Fresh input | 0.0% | 0.0% | 0.0% | 0.4% |
| Cache writes | 8.9% | 16.5% | 32.8% | 58.2% |

| Per-turn tokens | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Cache read | 59,416 | 131,357 | 272,692 | 527,629 |
| Cache creation | 1,356 | 2,605 | 5,621 | 22,987 |
| Output | 455 | 784 | 1,069 | 2,296 |

| Session shape | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Assistant turns | 24 | 107 | 230 | 624 |
| User prompts | 3 | 13 | 43 | 152 |
| Turns per prompt | 3.9 | 6.4 | 18.8 | 94.5 |

**Cache reads dominate.** At the median they are 65.1% of session cost, and together with cache
writes, context handling is roughly 82% of spend. Generation — the part that produces the
answer — is 17.5%. Fresh uncached input rounds to 0.0% at every percentile up to p90 and peaks
at 0.4%: essentially nothing is ever sent uncached.

### Why `output-share-of-cost` correlates *negatively* (−0.54)

This looks like a data error and is not. The mechanism:

Reconstruct a median-shaped turn in cost-equivalents. Cache read 131,357 × 0.1 = 13,136;
output 784 × 5 = 3,920; cache creation 2,605 × 1.25 = 3,256. That is 65% / 19% / 16% of the
turn's cost — close to the observed p50 shares of 65.1% / 17.5% / 16.5%, so the decomposition
is internally consistent.

Now vary the session. Output per turn barely moves: p10 455 to p90 1,069, a 2.3x spread, and it
correlates only 0.16 with cost. Cache read per turn moves 4.6x over the same deciles (59,416 to
272,692) and keeps growing with the session, because the context is re-read in full every turn
and the context only gets bigger. Shares must sum to 1, so as the cache-read term grows the
output term's *share* shrinks. `output-share-of-cost` correlates −0.579† with
`cache-read-per-turn`.

The consequence is a trap for meter design: a *low* output share is the signature of an
expensive session, and a high output share means the session was short. Anyone reading "output
is only 13% of my cost" as a sign of efficiency would have it exactly backwards.

## 5. Tool result sizes

Tool results from the 92 main transcripts (subagent transcripts are not included here):

| Tool | Calls | Total bytes | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| Edit | 1,939 | 9,737,640 | 4,161 | 10,339 | 15,166 | 26,534 |
| Bash | 5,305 | 5,487,969 | 424 | 2,504 | 7,806 | 73,025 |
| mcp:claude-in-chrome | 150 | 5,046,559 | 577 | 129,572 | 177,179 | 177,408 |
| Read | 641 | 3,822,553 | 3,193 | 10,323 | 37,463 | 346,857 |
| Write | 430 | 3,301,832 | 3,705 | 17,894 | 64,490 | 72,007 |
| Agent | 571 | 1,902,874 | 2,943 | 5,458 | 8,489 | 9,980 |
| mcp:foundry | 568 | 1,265,149 | 767 | 5,635 | 22,884 | 44,425 |
| AskUserQuestion | 120 | 202,026 | 1,316 | 3,049 | 5,102 | 6,139 |
| TaskUpdate | 708 | 78,060 | 111 | 112 | 122 | 123 |
| WebFetch | 25 | 65,083 | 1,239 | 4,583 | 22,327 | 27,720 |

(Top 10 of 27 tools by total bytes; the full table is in the script output. Across all 27,
11,495 calls returned 31,135,862 bytes, and the top five tools account for 88.0% of them.†)

**The medians are uninformative; the tails are where the context goes.** `mcp:claude-in-chrome`
has a median result of 577 bytes and a p90 of 129,572 — a 225x jump — and on only 150 calls it
is the third-largest byte consumer in the corpus, ahead of `Read` with 4.3x the call count. A
single `Read` reached 346,857 bytes. `Bash` is the opposite shape: 5,305 calls, a 424-byte
median, and it still accumulates 5.5 MB purely through volume.

MCP tools are reported at server granularity (`mcp:foundry`, not
`mcp__foundry__servicenow_query`) deliberately: the per-operation names identify a specific
client engagement and this repository is public. Which server returns huge results is the
finding; which of its operations did is not, so that resolution was given up on purpose.

## 6. Levers

For each source in §4, can a user change it *mid-session*?

**Turn count against a large window — yes, and it is the biggest lever.** Cost is approximately
turns × average context size, and both factors grow together — cache read per turn correlates
0.877† with turn count — so cost grows super-linearly in session length. This is a structural
relationship, not an empirical discovery: turns are a factor in the product that defines cost.
What the corpus adds is the spread: turns per prompt is 6.4 at the median, 18.8 at p90, and 94.5
at maximum — one prompt can cost 6 turns or 90. The mid-session action is real: narrow the ask,
or finish the current thread and start a fresh session for the next task. `compact-countdown`
and `context-percent` already surface the state that should trigger it.

**Oversized tool results — partly, and prospectively.** Total tool-result bytes correlate 0.743†
with cache read per turn: big results really do inflate what every subsequent turn re-reads.
But by the time a 177 KB browser snapshot is visible it is already in the context, and nothing
removes it. The lever is choosing narrower reads *before* the call, and it is not something a
statusline can prompt: tool-result bytes are not in the stdin payload at all.

**Subagent delegation — the corpus cannot settle it, and the raw comparison is misleading.**

- Sessions that spawned subagents: 37. Sessions that did not: 46.
- Cache read per turn, with subagents: p10 112,190 / p50 165,396 / p90 352,484 / max 527,629.
- Cache read per turn, without: p10 49,024 / p50 99,583 / p90 203,915 / max 324,248.

Read naively this says delegation costs 66% more per turn. It almost certainly does not say
that. Sessions that delegate are *different sessions*: 135 assistant turns at the median versus
63, and 23 user prompts versus 5†. Since cache read per turn correlates 0.877† with turn count,
most of that gap is explained by the sessions being longer, not by delegation. The causal
direction is at least as likely to run the other way — long, hard, multi-part tasks are the ones
that get delegated.

The measurement is also incomplete in the opposite direction: the analysis reads main
transcripts only, so a subagent's own token spend is **not counted** anywhere in this corpus.
Delegation therefore looks cheaper than it is on total spend while looking more expensive on
main-thread per-turn reads. What is measurable is the compression: 571 `Agent` calls returned a
median of 2,943 bytes into the main context (max 9,980) in exchange for whatever the subagent
read — which is the context-isolation benefit, visible but not quantifiable against a
counterfactual. Settling this needs the same task run both ways, which this corpus does not
contain.

**Compaction — not a factor here, and the corpus cannot speak to it.** Exactly **1** compaction
boundary appears across 83 sessions and 10,363 assistant turns. Whatever auto-compact does to
cost or quality, it did not happen to this user: sessions end before the threshold is reached.
That is itself a finding about the meter's premise — the behaviour a meter would nag toward
(stop and start fresh) is already this user's habit, so a meter would be advising a change
already made. It also means the corpus offers zero evidence on when compaction helps versus
hurts — one of issue #49's scope questions, and one this study has to leave unanswered.

## 7. Candidate evaluation

All six scored signals:

| Signal | Live availability | p10 | p50 | p90 | Dynamic range (p90-p10) | Cost correlation |
| --- | --- | --- | --- | --- | --- | --- |
| cache-hit-rate | live-proxy | 94.5% | 98.0% | 99.0% | 4.5% | 0.12 |
| cache-read-per-turn | live-proxy | 59,416 | 131,357 | 272,692 | 213,276 | 0.84 |
| cache-creation-per-turn | live-proxy | 1,356 | 2,605 | 5,621 | 4,265 | 0.62 |
| output-per-turn | live-proxy | 455 | 784 | 1,069 | 614 | 0.16 |
| cache-read-share-of-cost | live-proxy | 45.1% | 65.1% | 77.0% | 31.9% | 0.33 |
| output-share-of-cost | live-proxy | 12.6% | 17.5% | 24.6% | 12.0% | -0.54 |

### What "live availability" means, and why every row says the same thing

Every signal here is a **session aggregate**: a sum or a mean over all of a session's assistant
turns. The statusline payload contains no session-cumulative token totals to build one from.
Claude Code 2.1.220 assembles `context_window` from the last assistant message's usage —
`current_usage` is that message's `usage` object verbatim, and `total_input_tokens` is that same
message's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, which is why
it tracks the current window rather than the session's history.

So no signal in the table is exactly computable live (`live-exact`), and equally none is
uncomputable (`transcript-only`): each has a single-turn live analogue in the same units. The
column is uniform on purpose — availability disqualifies nothing here, and the rulings below
rest on dynamic range, cost correlation, and redundancy with widgets already on the bar. An
earlier draft of this document had the flag two-valued and used it to disqualify the study's
best signal outright; that was wrong in both directions, and `scripts/lib/analysis.ts` now
carries the three-state flag and the reasoning.

### Ruled out — the four candidates from #49

| Candidate (#49) | Measured as | Ruled out because |
| --- | --- | --- |
| **Cache reuse rate** | `cache-hit-rate` | Spans 4.5 points between p10 (94.5%) and p90 (99.0%), with a median of 98.0%. A statusline segment rendering integer percent would read 98% or 99% in most sessions; the entire informative band is narrower than a glance can distinguish. It correlates only 0.12 with cost, and its meaning is ambiguous — a high reuse rate means caching is working, which is the *good* outcome, so there is no "red" that means anything. Its live form is narrower still: the latest turn's read/write split rather than the session figure measured here. |
| **Context burn per turn** | `cache-read-per-turn` | The best-scoring signal in the study — 213,276 dynamic range, 0.84 cost correlation — and still not worth shipping. It is **not** ruled out for being uncomputable live; it has a live analogue like everything else. It is ruled out because it correlates 0.877† with turn count, making it a restatement of "long session, large context", which `context-percent` and `compact-countdown` already show — and `compact-countdown` shows it in tokens against the actual auto-compact threshold (`windowSize − 33,000`, #45) rather than as a rate with no calibrated boundary. The live analogue is a single turn's read against thresholds fitted to session means (§2), so it would also flip states on turn-to-turn noise. |
| **Cost per unit of work** | not measurable in this corpus | The denominator does not exist in the data. Transcripts carry no lines-added/removed, so this corpus cannot calibrate a single threshold for it — and the work denominator varies 24x within the corpus anyway (turns per prompt: p10 3.9, p50 6.4, max 94.5). The tool mix shows why lines are a bad proxy: 5,305 `Bash` calls against 1,939 `Edit` calls, so most tool activity produces no lines at all. On a research or debugging session the denominator is zero and the meter reads infinity — precisely the sessions where spend most needs watching. |
| **Composite grade** | any weighted blend of the above | Its inputs disagree in sign: `cache-read-share-of-cost` correlates +0.33 with cost while `output-share-of-cost` correlates −0.54, so a fixed-weight blend of the two partially cancels itself. And a composite by construction hides which input moved — which is the one piece of information that could imply an action. Blending signals that are themselves restatements of turn count (§1) does not produce a signal about anything else. |

`output-per-turn` and `cache-creation-per-turn` are not #49 candidates but were scored. Output
per turn barely moves (614 dynamic range, 0.16 correlation) and is the negative-share trap of §4
seen from the other side. Cache creation per turn correlates 0.62 — the second-strongest in the
table — but it is a component of the same context-growth story as `cache-read-per-turn` rather
than an independent signal, and its actionable content is the same "the context is big" message.

## 8. Disposition of `cache-hit-rate` (#47)

**Keep the widget registered as an opt-in diagnostic. Do not promote it to the default layout,
and do not build a meter on it.** Its dormancy under #47 should be recorded as deliberate for
this widget rather than counted as one of the 12 accidental omissions.

Reasons:

- As a *meter* it fails on the numbers in §7: 4.5-point p10–p90 band, 0.12 cost correlation,
  and a "good" direction that is already where nearly every session sits (p50 98.0%).
- As a *diagnostic* it retains one narrow use. The distribution has a low tail — minimum 88.9%
  against a p10 of 94.5% — and it tracks something real: the 88.9% session spent 58.2% of its
  budget writing cache rather than reading it, and a 416-turn session at 93.0% spent 45.8%†. A
  session really can spend nearly half its budget rebuilding cache, and the hit rate is the only
  stdin-visible marker of that state.
- The honest caveat, stated rather than glossed: even in that state the mid-session action is
  weak. Cache rebuilds come from prompt-prefix churn and from idling past the cache TTL, and a
  user who notices an 89% hit rate cannot undo the rebuild that already happened. At best it
  explains a cost spike after the fact.
- Retiring it would save nothing. It is about twenty lines with no dependencies and no default-layout
  presence, so it costs nothing to keep and its removal would only take away an occasionally
  useful opt-in.

## 9. Limitations

- **One user, one machine, 83 sessions.** Work skewed toward this repository and ServiceNow
  consulting; three projects supply 54 of the 83 sessions†. Every threshold in this document is
  calibrated to one person's working style and should not be shipped as a default for others.
- **Nothing to say about compaction.** One boundary in the entire corpus (§6). Whether
  compaction helps or hurts is untested here.
- **Subagent spend is invisible.** Metrics are computed from main transcripts only; the 591
  subagent transcripts contribute no tokens to any cost figure, so total session cost is
  understated for the 37 sessions that delegated, and the delegation comparison in §6 measures
  main-thread effects only.
- **The delegation comparison is confounded and no causal claim is made** in either direction.
- **Turn/cost correlations are structural, not evidential.** Cost is by construction a sum over
  turns, so turn count correlating 0.924† with cost confirms the decomposition rather than
  telling us anything about how well a session was run (§1).
- **Cost is in input-token-equivalents, not dollars** (output 5x, cache write 1.25x, cache read
  0.1x). This is model-independent and does not go stale with list prices, but it is not
  directly comparable to `cost.total_cost_usd`, and it assumes the 5-minute cache TTL pricing.
- **MCP granularity is deliberately coarse.** Per-operation MCP tool names were collapsed to the
  server (`mcp:foundry`) because they identify a client engagement and this repo is public. The
  data is not finer than it appears, and the omitted resolution could change §5's reading of
  which calls produce the tail.
- **Live and retrospective statistics are not the same statistic.** Every figure here is a
  session aggregate; the live payload carries only the latest assistant message's usage, with no
  session-cumulative totals (§7). Any threshold intended for a live widget needs re-derivation
  per turn, against live payloads, not from this data.
- **Tool-result bytes are serialised JSON bytes, not tokens.** They are a proxy for context
  cost, correlated but not equal.
- **No quality dimension.** Everything here measures spend. Nothing measures whether the
  session produced a good result, so "efficiency" throughout means "cost per turn", never
  "value per dollar".

## 10. Reproducing

```bash
npm run analyze              # the markdown tables quoted above
npm run analyze -- --json    # full aggregates, including per-session rows
npm run analyze -- --projects-dir /path/to/projects
```

Requires **Node ≥ 23.6**, which strips TypeScript types natively — there is no build step and no
dependency to install. Output is anonymised: project directories become `proj-a`, `proj-b`, …
and no prompt text, file contents, or paths are ever emitted. Unrecognised arguments and a
missing, flag-shaped, or non-existent `--projects-dir` value are hard errors with a non-zero
exit, so a typo cannot silently fall back to scanning the default corpus.

The corpus is live data, so counts drift as new sessions are recorded. Figures here are from a
run on 2026-07-31.

### Derived figures (†)

The figures marked † are computed from the `sessions` array in the `--json` output, using the
same Pearson correlation the script applies to its own signal table:

```bash
npm run --silent analyze -- --json > /tmp/analysis.json
node -e '
const S = require("/tmp/analysis.json").sessions;
const f = k => S.map(s => s[k]);
const r = (xs, ys) => { const n = xs.length;
  const mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n;
  let c=0, vx=0, vy=0;
  for (let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; c+=dx*dy; vx+=dx*dx; vy+=dy*dy; }
  return c/Math.sqrt(vx*vy); };
for (const [a,b] of [["turns","totalCostEquivalent"],["cacheReadPerTurn","turns"],
                     ["outputShare","cacheReadPerTurn"],["toolResultBytes","cacheReadPerTurn"]])
  console.log(a, "vs", b, r(f(a), f(b)).toFixed(3));
const by = {}; for (const s of S) by[s.projectLabel] = (by[s.projectLabel]??0)+1;
console.log(by);
'
```

The delegation medians (135 vs 63 turns, 23 vs 5 user prompts) come from the same rows, split
on `subagentCount > 0`; the §2 decile turn counts come from sorting those rows on
`cacheReadPerTurn` and taking the first and last eight; the per-session hit-rate and
cache-write-share pairs in §8 come from sorting on `cacheHitRate`; the tool totals (11,495
calls, 31,135,862 bytes, top-five share 88.0%) come from summing the `tools` array.
