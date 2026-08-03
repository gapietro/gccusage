# Non-SGR escapes counted as visible text — design

Issue: #113. Split out of #86, where it was named in 'Out of scope'.

## Root cause

`stripAnsi` matches `/\x1b\[[0-9;]*m/g` — SGR only. Everything else a terminal
treats as a control action is counted by `visibleLength` as visible text.

`truncateAnsi` does not call `stripAnsi`; it hand-rolls a *second, different*
recogniser (`indexOf("m", i)`). The two disagreeing is the other half of the
root cause, and it fails in the opposite direction — it charges visible text
zero columns.

## Measured, on the code at f2f125d

`visibleLength`, columns reported vs columns drawn:

| input | reported | actual |
|---|---|---|
| `ESC]8;;https://example.com ESC\ link ESC]8;; ESC\` (OSC-8 hyperlink) | 37 | 4 |
| `ESC]0;my window title BEL ok` (set title) | 22 | 2 |
| `ESC[?25l ok` (hide cursor) | 8 | 2 |
| `ESC[1;5r ok` (scroll region) | 8 | 2 |
| `ESC[1A ok` (cursor up) | 6 | 2 |
| `ESC[K ok` (erase line) | 5 | 2 |
| `ESC(B ok` (charset select) | 5 | 2 |
| `ESC c ok` (full reset) | 4 | 2 |
| `abc CR def` | 7 | 6 |
| `ab BEL c` | 4 | 3 |

Over-measurement truncates the bar prematurely: the filed defect.

**`truncateAnsi` also under-measures, which the issue does not mention.** Its
`indexOf("m", i)` scan swallows everything up to the next `m` *anywhere* in the
string as if it were one escape, at zero column cost:

- `truncateAnsi("ESC[2Jhome", 4)` returns `"ESC[2Jhome…" + RESET` — the entire
  input, plus an ellipsis. `hom` was charged 0 columns because the `m` of
  `home` was read as an SGR terminator. The function's contract is "at most
  maxWidth columns"; it returned 4 columns of text it promised to cut, and made
  the string *longer* than the input it was asked to shorten.
- `truncateAnsi(osc8Link, 10)` cuts inside the URL, emitting `ESC]8;;http…` —
  an OSC sequence with no terminator. A terminal consumes what follows as part
  of the string until it finds one.

That fall-through is the case the existing comment at `truncation.ts:77`
describes and defers to this issue.

## Fix

One recogniser, shared. `terminal.ts` owns the escape grammar; `truncation.ts`
consumes it instead of carrying its own.

```
ESC (?:
    \[ [0-?]* [ -/]* [@-~]                 CSI — SGR is the final-byte-'m' case
  | \] [^BEL ESC]* (?: BEL | ESC \\ )      OSC — BEL- or ST-terminated
  | [P^_X] [^ESC]* ESC \\                  DCS / PM / APC / SOS — ST-terminated
  | [ -/]+ [0-~]                           nF — ESC ( B
  | [0-~]                                  two-character — ESC c, ESC 7
)
```

The **lookahead** on the two-character alternative is load-bearing: `[0-~]`
covers `[`, `]`, `P`, `X`, `^` and `_`, so without it that alternative would
match the opener of a CSI or string sequence and leave the body as visible
text. It bites hardest on an *unterminated* sequence, where the OSC alternative
fails and `ESC ]` would otherwise be taken as a two-character escape.

**The alternation order is not load-bearing, contrary to the first draft of
this spec.** Moving the two-character alternative to the front leaves the whole
suite green (mutation M4 below) — the lookahead already prevents the overlap.
The claim was written from reasoning and falsified by testing it; the ordering
is readability only.

Every alternative is linear with no nested quantifier, so the pattern cannot
backtrack catastrophically. That matters more here than it usually does: the
input is arbitrary shell output from `custom-command`, and `ansi-regex` — the
obvious dependency to reach for instead — carried a ReDoS advisory
(GHSA-93q8-gq69-wqmw) on exactly this shape of pattern. Hand-rolled and pinned
by tests, for a grammar that is frozen (ECMA-48) rather than a moving data
table; contrast `get-east-asian-width`, taken as a dependency in #86 precisely
because Unicode width data does move.

### Also in scope: C0 controls

Same root cause one step out — input that drives the terminal but draws
nothing, counted as a column. `CR`, `BEL`, `BS`, `SO` and friends each measure
1 today. They are stripped alongside escapes.

Three deliberate exclusions:

- **LF** stays a column, and more importantly stays in the string. Found by
  breaking it: the bar is two lines and callers `split("\n")` the output of
  `stripAnsi`, so stripping LF collapsed both lines into one 90-column line and
  turned four assertions in `default-layout-width.test.ts` vacuous by leaving
  them comparing against an empty second line. It is a structural separator
  here, not decoration. CR is *not* excluded — nothing in this codebase's
  output uses it structurally.

- **TAB** stays 1 column. Its real width depends on the cursor's position
  against the next tab stop, which is not knowable statically. 1 is a floor —
  a tab is never narrower — so it can only over-measure, never overflow.
- **A bare ESC** that opens nothing stays 1 column, matching what the current
  `truncateAnsi` charges it and keeping the incomplete-escape rule below
  coherent.

### Incomplete escapes count as visible

`ESC]8;;url` with no terminator does not match, so it is measured as text.

This is the safe direction and is chosen deliberately. Over-measuring truncates
early — cosmetic. Under-measuring overflows the terminal, which is the entire
bug class this and #86 exist to close. A malformed sequence must never be able
to make the rest of the bar free.

## Not in scope

**`shrink.ts`'s `trimTo` can still cut a trailing escape in half.** It trims
cluster by cluster from the end and re-measures with `visibleLength` every
iteration, so it cannot under-measure once `visibleLength` is correct — the
incomplete-escape rule above is what guarantees that, since the severed
remainder reverts to being counted as text. What it can do is leave visible
garbage from an already-pathological input. Bounded and cosmetic; stated rather
than papered over.

**Injection is not addressed.** Correct measurement does not stop a
`custom-command` from putting `ESC[2J` in the bar; it only stops it from
breaking the width math. The bar is embedded in Claude Code's own TUI, so a
cursor-move or erase sequence from a user's command corrupts a rendering this
tool does not own. That is a distinct defect — a hazard, not a miscount — with
a distinct fix (sanitise at the widget boundary), and it gets its own issue
rather than riding along here. Note the fix here does not worsen it: those
sequences reach the output today too, merely mis-measured.

## Acceptance

1. Every row in the measured table above reports the actual column count.
2. `truncateAnsi(s, w)` satisfies `visibleLength(result) <= w` for every input
   in the table, at every width in a sweep — including `ESC[2Jhome`.
3. `truncateAnsi` never emits a partial escape sequence: whatever it cuts, the
   escapes in the result are the same complete escapes, in order, as a prefix
   of those in the input.
4. The default bar is byte-identical. It contains no escapes but SGR and no C0
   controls, so the exact width pins in `default-layout-width.test.ts` (88/80/79)
   must not move. Any movement means the grammar is eating something it should
   not — the same regression guard #86 used.

## Verified

**End-to-end on the shipped bundle**, through the path the issue names — a
`custom-command` emitting an OSC-8 hyperlink (`CI:green`, 8 columns, wrapped in
40 bytes of URL), at `COLUMNS=40`, compared against the merge-base bundle
(`git show f2f125d:dist/index.js`):

| | columns drawn | `CI:green` visible |
|---|---|---|
| before | 9 | no — truncated away entirely |
| after | 20 | yes |

**Default bar byte-identical** at COLUMNS 60/80/100/120/200, diffed against the
same merge-base bundle. Acceptance 4 holds.

**No render-path regression**: 112.9ms → 104.8ms mean over 10 cold runs
(statusline cache cleared between each), inside noise and far inside the 10ms
rule #86 pre-registered.

**Linearity, measured rather than asserted** — `stripAnsi` on adversarial input
(unterminated CSI/OSC/DCS, parameter floods, ESC floods), at 400,000
characters: 1.1–7.4ms, scaling ~4–7× for a 10× input. No catastrophic
backtracking.

**Eight mutations, seven caught.** M4 (alternation order reversed) survives,
which is what corrected this spec's claim about ordering above rather than a
gap in the tests. Two of the tests written here were themselves vacuous on
first attempt and were caught by the same battery:

- The zero-width-control test used one CR. `.test()` on a `g`-flagged regex
  alternates true/false, so a single control passes either way. Two
  *non-adjacent* controls do not fix it either — the check runs on every
  cluster, and any non-matching one between them resets `lastIndex`. Only two
  **adjacent** controls tell a stateful recogniser from a stateless one.
- The truncation width sweep cannot catch a control charged one column: doing
  so cuts *early*, which still satisfies `<= maxWidth`. Only an exact-cut-point
  assertion catches it.
