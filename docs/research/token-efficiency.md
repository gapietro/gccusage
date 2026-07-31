# What a token-efficiency meter should measure

Research findings for [#49](https://github.com/gapietro/gccusage/issues/49). Generated from
`npm run analyze` over the local Claude Code transcript corpus on 2026-07-31.

Every figure below comes from that script. Figures marked † are not printed by
`npm run analyze` but are derived from the per-session rows in `npm run analyze -- --json`;
§10 gives the exact command that reproduces them.

---

## 1. Recommendation

**Do not build a token-efficiency meter. No candidate signal qualifies.**

The corpus does not contain the thing a meter would look for. Caching in these 85 sessions
works close to perfectly — cache hit rate is 97.5% at the median and 92.9% at the *tenth
percentile* — so there is no recoverable efficiency loss to flag. Session cost is not set by
how well the session is run; it is set by how much work was asked for. Assistant turn count
alone correlates 0.919† with session cost, better than any of the six signals scored.

The two quantities that actually multiply out to cost — how big the context is, and how many
turns run against it — are both already on the status bar: `context-percent` shows the first,
and `compact-countdown` (#45) shows how many tokens of headroom remain before auto-compact.
A meter would re-encode those two numbers as a third one with worse actionability.

The strongest signal in the data, `cache-read-per-turn` (dynamic range 211,172; cost
correlation 0.86), is disqualified twice over: a live statusline payload cannot compute it at
all, and it correlates 0.882† with turn count, meaning it mostly restates "this session is long
and its context is large" — which is what `context-percent` and `compact-countdown` already
display, in tokens, against the real threshold.

## 2. Thresholds and what each state means

Since the recommendation is to build nothing, this section shows the threshold table the best
stdin-available candidate would have produced, and what each state implies. It is the concrete
form of the argument in §1, not a build instruction.

The candidate is `cache-read-share-of-cost` (p10 39.2%, p50 58.9%, p90 72.3%, max 81.7%,
cost correlation 0.39) — the highest-correlating signal a live payload can compute. Boundaries
are the observed decile edges, not round numbers.

| State | Range | What it means | What the user does mid-session |
| --- | --- | --- | --- |
| Low | ≤ 39.2% (bottom decile) | Cost sits in cache writes and output rather than re-reads. In the corpus this is a short or freshly-started session, or one whose cache is being rebuilt. Cache-write share reaches 73.2% at its maximum. | **Nothing.** The share moves on its own as the session runs; there is no action that raises it, and raising it would not be desirable anyway. |
| Normal | 39.2% – 72.3% | What a working session looks like. Eight of ten sessions live here. | **Nothing.** This is the null state and it covers 80% of sessions. |
| High | ≥ 72.3% (top decile) | The context is large and every turn re-reads it. | Shrink the context or start a fresh session — **which is exactly the advice `compact-countdown` already gives**, in tokens remaining before auto-compact rather than as a share. |

Two of the three states imply no action. The third duplicates a widget that is already in the
default layout and states the same thing more precisely. That is the case against the meter, in
one table.

There is also a calibration problem that applies to every stdin-available candidate. The
corpus figures are session-cumulative sums over all assistant turns; the live payload's
`context_window.current_usage` is a snapshot of the *current* window. A threshold fitted to the
first is not valid for the second, and the corpus cannot be re-cut to produce the second,
because transcripts record per-turn usage rather than per-turn window composition.

## 3. What the corpus is

| | |
| --- | --- |
| Projects contributing sessions | 12 |
| Main session transcripts | 92 |
| Subagent transcripts | 581 |
| Sessions analysed (≥ 5 assistant turns) | 85 |
| Assistant turns analysed | 21,845 |
| Compaction boundaries observed | **1** |

There are 22 project directories under `~/.claude/projects/`; only 12 contain a top-level
session transcript; the other 10 hold only auxiliary files (a `memory/` directory or a
`sessions-index.json`) and contribute nothing. Sessions with fewer
than 5 assistant turns are excluded as too short to characterise, which drops 7 of the 92.

The sample is skewed. Of the 85 analysed sessions, 11 project labels appear at all, and three
projects supply 55 of them (26, 17, and 12)† — this repository and ServiceNow consulting work.
One user, one machine, one working style. **Any threshold derived from this corpus is
calibrated to one person**, and that is the single largest reason not to ship a number derived
from it as a default.

Project labels are anonymised (`proj-a`…) by the analysis script and real directory names never
leave `discover.ts`.

### The `isSidechain` finding

Subagent work is discovered through the `subagents/` directory, not through the transcript's
`isSidechain` field. That field is `false` on every record in this corpus. A reader that trusts
it concludes there was zero delegation and is silently wrong — the corpus in fact contains 581
subagent transcripts. This is documented in `scripts/lib/discover.ts` so the next reader does
not rediscover it the hard way.

## 4. Where the tokens go

Share of session cost in input-token-equivalents (output 5x, cache write 1.25x, cache read
0.1x — ratios rather than dollar prices, so the result is model-independent):

| Component | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Cache reads | 39.2% | 58.9% | 72.3% | 81.7% |
| Output | 14.5% | 20.6% | 29.7% | 44.7% |
| Fresh input | 0.0% | 0.0% | 0.0% | 0.6% |
| Cache writes | 9.7% | 18.2% | 36.9% | 73.2% |

| Per-turn tokens | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Cache read | 52,302 | 125,102 | 263,474 | 505,017 |
| Cache creation | 1,598 | 3,069 | 8,058 | 16,829 |
| Output | 515 | 953 | 1,450 | 3,080 |

| Session shape | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| Assistant turns | 52 | 230 | 471 | 1,129 |
| User prompts | 3 | 12 | 42 | 152 |
| Turns per prompt | 7.7 | 14.5 | 37.2 | 231.5 |

**Cache reads dominate.** At the median they are 58.9% of session cost, and together with cache
writes, context handling is roughly 77% of spend. Generation — the part that produces the
answer — is 20.6%. Fresh uncached input rounds to 0.0% at every percentile up to p90 and peaks
at 0.6%: essentially nothing is ever sent uncached.

### Why `output-share-of-cost` correlates *negatively* (−0.44)

This looks like a data error and is not. The mechanism:

Reconstruct a median-shaped turn in cost-equivalents. Cache read 125,102 × 0.1 = 12,510;
output 953 × 5 = 4,765; cache creation 3,069 × 1.25 = 3,836. That is 59% / 23% / 18% of the
turn's cost — close to the observed p50 shares of 58.9% / 20.6% / 18.2%, so the decomposition
is internally consistent.

Now vary the session. Output per turn barely moves: p10 515 to p90 1,450, a 2.8x spread, and it
correlates only 0.19 with cost. Cache read per turn moves 5.0x over the same deciles (52,302 to
263,474) and keeps growing with the session, because the context is re-read in full every turn
and the context only gets bigger. Shares must sum to 1, so as the cache-read term grows the
output term's *share* shrinks. `output-share-of-cost` correlates −0.480† with
`cache-read-per-turn`.

The consequence is a trap for meter design: a *low* output share is the signature of an
expensive session, and a high output share means the session was short. Anyone reading "output
is only 14% of my cost" as a sign of efficiency would have it exactly backwards.

## 5. Tool result sizes

Tool results from the 92 main transcripts (subagent transcripts are not included here):

| Tool | Calls | Total bytes | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- |
| Edit | 1,939 | 9,737,640 | 4,161 | 10,339 | 15,166 | 26,534 |
| Bash | 5,286 | 5,463,591 | 424 | 2,504 | 7,701 | 73,025 |
| mcp:claude-in-chrome | 150 | 5,046,559 | 577 | 129,572 | 177,179 | 177,408 |
| Read | 640 | 3,819,269 | 3,192 | 10,326 | 37,479 | 346,857 |
| Write | 430 | 3,301,832 | 3,705 | 17,894 | 64,490 | 72,007 |
| Agent | 561 | 1,843,531 | 2,912 | 5,402 | 8,356 | 9,980 |
| mcp:foundry | 568 | 1,265,149 | 767 | 5,635 | 22,884 | 44,425 |
| AskUserQuestion | 119 | 198,985 | 1,310 | 3,047 | 5,111 | 6,139 |
| TaskUpdate | 703 | 77,509 | 110 | 112 | 122 | 123 |
| WebFetch | 25 | 65,083 | 1,239 | 4,583 | 22,327 | 27,720 |

(Top 10 of 27 tools by total bytes; the full table is in the script output. Across all 27,
11,459 calls returned 31,045,265 bytes, and the top five tools account for 88.2% of them.†)

**The medians are uninformative; the tails are where the context goes.** `mcp:claude-in-chrome`
has a median result of 577 bytes and a p90 of 129,572 — a 225x jump — and on only 150 calls it
is the third-largest byte consumer in the corpus, ahead of `Read` with 4.3x the call count. A
single `Read` reached 346,857 bytes. `Bash` is the opposite shape: 5,286 calls, a 424-byte
median, and it still accumulates 5.5 MB purely through volume.

MCP tools are reported at server granularity (`mcp:foundry`, not
`mcp__foundry__servicenow_query`) deliberately: the per-operation names identify a specific
client engagement and this repository is public. Which server returns huge results is the
finding; which of its operations did is not, so that resolution was given up on purpose.

## 6. Levers

For each source in §4, can a user change it *mid-session*?

**Turn count against a large window — yes, and it is the biggest lever.** Turns correlate 0.919†
with session cost, and cache read per turn correlates 0.882† with turn count. Cost is
approximately turns × average context size, and both factors grow together, so cost grows
super-linearly in session length. The spread is wide: turns per prompt is 14.5 at the median,
37.2 at p90, and 231.5 at maximum — one prompt can cost 15 turns or 200. The mid-session action
is real: narrow the ask, or finish the current thread and start a fresh session for the next
task. `compact-countdown` and `context-percent` already surface the state that should trigger
it.

**Oversized tool results — partly, and prospectively.** Total tool-result bytes correlate 0.754†
with cache read per turn: big results really do inflate what every subsequent turn re-reads.
But by the time a 177 KB browser snapshot is visible it is already in the context, and nothing
removes it. The lever is choosing narrower reads *before* the call, and it is not something a
statusline can prompt: tool-result bytes are not in the stdin payload at all.

**Subagent delegation — the corpus cannot settle it, and the raw comparison is misleading.**

- Sessions that spawned subagents: 37. Sessions that did not: 48.
- Cache read per turn, with subagents: p10 107,061 / p50 154,108 / p90 326,583 / max 505,017.
- Cache read per turn, without: p10 44,906 / p50 95,718 / p90 195,779 / max 329,759.

Read naively this says delegation costs 61% more per turn. It almost certainly does not say
that. Sessions that delegate are *different sessions*: 284 assistant turns at the median versus
140, and 23 user prompts versus 5†. Since cache read per turn correlates 0.882† with turn count,
most of that gap is explained by the sessions being longer, not by delegation. The causal
direction is at least as likely to run the other way — long, hard, multi-part tasks are the ones
that get delegated.

The measurement is also incomplete in the opposite direction: the analysis reads main
transcripts only, so a subagent's own token spend is **not counted** anywhere in this corpus.
Delegation therefore looks cheaper than it is on total spend while looking more expensive on
main-thread per-turn reads. What is measurable is the compression: 561 `Agent` calls returned a
median of 2,912 bytes into the main context (max 9,980) in exchange for whatever the subagent
read — which is the context-isolation benefit, visible but not quantifiable against a
counterfactual. Settling this needs the same task run both ways, which this corpus does not
contain.

**Compaction — not a factor here, and the corpus cannot speak to it.** Exactly **1** compaction
boundary appears across 85 sessions and 21,845 assistant turns. Whatever auto-compact does to
cost or quality, it did not happen to this user: sessions end before the threshold is reached.
That is itself a finding about the meter's premise — the behaviour a meter would nag toward
(stop and start fresh) is already this user's habit, so a meter would be advising a change
already made. It also means the corpus offers zero evidence on when compaction helps versus
hurts — one of issue #49's scope questions, and one this study has to leave unanswered.

## 7. Candidate evaluation

All six scored signals:

| Signal | Available from | p10 | p50 | p90 | Dynamic range (p90-p10) | Cost correlation |
| --- | --- | --- | --- | --- | --- | --- |
| cache-hit-rate | stdin | 92.9% | 97.5% | 98.9% | 6.0% | 0.22 |
| cache-read-per-turn | transcript | 52,302 | 125,102 | 263,474 | 211,172 | 0.86 |
| cache-creation-per-turn | transcript | 1,598 | 3,069 | 8,058 | 6,460 | 0.47 |
| output-per-turn | transcript | 515 | 953 | 1,450 | 935 | 0.19 |
| cache-read-share-of-cost | stdin | 39.2% | 58.9% | 72.3% | 33.1% | 0.39 |
| output-share-of-cost | stdin | 14.5% | 20.6% | 29.7% | 15.2% | -0.44 |

Only two of the six are computable from a live statusline payload, and they are the two with
the weakest correlations bar one.

### Ruled out — the four candidates from #49

| Candidate (#49) | Measured as | Ruled out because |
| --- | --- | --- |
| **Cache reuse rate** | `cache-hit-rate` (stdin) | Spans 6.0 points between p10 (92.9%) and p90 (98.9%), with a median of 97.5%. A statusline segment rendering integer percent would read 97% or 98% in most sessions; the entire informative band is narrower than a glance can distinguish. It correlates only 0.22 with cost, and its meaning is ambiguous — a high reuse rate means caching is working, which is the *good* outcome, so there is no "red" that means anything. The live widget's version is narrower still: it is computed from `current_usage`, a single-window snapshot, not the session-cumulative figure measured here. |
| **Context burn per turn** | `cache-read-per-turn` (transcript) | The best-scoring signal in the study — 211,172 dynamic range, 0.86 cost correlation — and unusable. It is transcript-only: a live payload carries a current-window snapshot and cumulative totals, never per-turn history, so the widget cannot compute it. It also correlates 0.882† with turn count, making it a restatement of "long session, large context", which `context-percent` and `compact-countdown` already show — and `compact-countdown` shows it in tokens against the actual auto-compact threshold (`windowSize − 33,000`, #45) rather than as an uncalibrated rate. |
| **Cost per unit of work** | not measurable in this corpus | The denominator does not exist in the data. Transcripts carry no lines-added/removed, so this corpus cannot calibrate a single threshold for it — and the work denominator varies 30x within the corpus anyway (turns per prompt: p50 14.5, p90 37.2, max 231.5). The tool mix shows why lines are a bad proxy: 5,286 `Bash` calls against 1,939 `Edit` calls, so most tool activity produces no lines at all. On a research or debugging session the denominator is zero and the meter reads infinity — precisely the sessions where spend most needs watching. |
| **Composite grade** | any weighted blend of the above | Its inputs disagree in sign: `cache-read-share-of-cost` correlates +0.39 with cost while `output-share-of-cost` correlates −0.44, so a fixed-weight blend of the two stdin-available signals partially cancels itself. The only input with real predictive power (`cache-read-per-turn`, 0.86) is unavailable live, so a live composite would be assembled from the weak signals only. And a composite by construction hides which input moved — which is the one piece of information that could imply an action. |

`output-per-turn` and `cache-creation-per-turn` are not #49 candidates but were scored and also
fail: 0.19 and 0.47 correlation respectively, both transcript-only.

## 8. Disposition of `cache-hit-rate` (#47)

**Keep the widget registered as an opt-in diagnostic. Do not promote it to the default layout,
and do not build a meter on it.** Its dormancy under #47 should be recorded as deliberate for
this widget rather than counted as one of the 12 accidental omissions.

Reasons:

- As a *meter* it fails on the numbers in §7: 6.0-point p10–p90 band, 0.22 cost correlation,
  and a "good" direction that is already where nearly every session sits (p50 97.5%).
- As a *diagnostic* it retains one narrow use. The distribution has a long low tail — minimum
  73.6% against a p10 of 92.9% — and the cache-write share reaches 73.2% at its maximum, so a
  session really can spend most of its budget rebuilding cache rather than reading it. The hit
  rate is the only stdin-visible marker of that state.
- The honest caveat, stated rather than glossed: even in that state the mid-session action is
  weak. Cache rebuilds come from prompt-prefix churn and from idling past the cache TTL, and a
  user who notices a 74% hit rate cannot undo the rebuild that already happened. At best it
  explains a cost spike after the fact.
- Retiring it would save nothing. It is about twenty lines with no dependencies and no default-layout
  presence, so it costs nothing to keep and its removal would only take away an occasionally
  useful opt-in.

## 9. Limitations

- **One user, one machine, 85 sessions.** Work skewed toward this repository and ServiceNow
  consulting; three projects supply 55 of the 85 sessions†. Every threshold in this document is
  calibrated to one person's working style and should not be shipped as a default for others.
- **Nothing to say about compaction.** One boundary in the entire corpus (§6). Whether
  compaction helps or hurts is untested here.
- **Subagent spend is invisible.** Metrics are computed from main transcripts only; the 581
  subagent transcripts contribute no tokens to any cost figure, so total session cost is
  understated for the 37 sessions that delegated, and the delegation comparison in §6 measures
  main-thread effects only.
- **The delegation comparison is confounded and no causal claim is made** in either direction.
- **Cost is in input-token-equivalents, not dollars** (output 5x, cache write 1.25x, cache read
  0.1x). This is model-independent and does not go stale with list prices, but it is not
  directly comparable to `cost.total_cost_usd`, and it assumes the 5-minute cache TTL pricing.
- **MCP granularity is deliberately coarse.** Per-operation MCP tool names were collapsed to the
  server (`mcp:foundry`) because they identify a client engagement and this repo is public. The
  data is not finer than it appears, and the omitted resolution could change §5's reading of
  which calls produce the tail.
- **Live and retrospective statistics are not the same statistic.** Corpus shares are
  session-cumulative; stdin's `current_usage` is a window snapshot (§2). Any future threshold
  intended for a live widget needs re-derivation against live payloads, not this data.
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
and no prompt text, file contents, or paths are ever emitted.

The corpus is live data, so counts drift as new sessions are recorded. Figures here are from a
run on 2026-07-31.

### Derived figures (†)

The figures marked † are computed from the `sessions` array in the `--json` output, using the
same Pearson correlation the script applies to its own signal table:

```bash
npm run analyze -- --json > /tmp/analysis.json
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

The delegation medians (284 vs 140 turns, 23 vs 5 user prompts) come from the same rows, split
on `subagentCount > 0`; the tool totals (11,459 calls, 31,045,265 bytes, top-five share 88.2%)
come from summing the `tools` array.
