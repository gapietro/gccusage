# Sanitise terminal control sequences out of widget text

Issue #115. Split out of #113, which fixed the *measurement* of non-SGR escape
sequences. This is the other half: measuring them correctly does not stop them
reaching the terminal.

## Problem

`custom-command` runs an arbitrary shell command and puts its first line of
output in the bar. Whatever escape sequences that command emits are copied
through verbatim — `truncateAnsi` deliberately preserves escapes at zero column
cost, and nothing between the widget and stdout filters them.

The statusline is not written to a terminal this tool owns. Claude Code embeds
it in its own Ink-rendered TUI, so a cursor-move or erase sequence corrupts a
rendering this tool has no control over, on a cadence of every render:

- `ESC[2J` clears the screen
- `ESC[1A` / `ESC[H` move the cursor out of the statusline
- `ESC[?25l` hides the cursor and never restores it
- `ESC]0;…BEL` retitles the user's terminal window
- `CR` returns to column 0, so the rest of the bar overwrites what precedes it

Pre-existing, not introduced by #113 — those bytes reached the output before
that fix too, merely mis-measured on the way.

## Design

### Placement: every widget output, in the renderer

A new export `sanitizeAnsi(str)` in `src/utils/terminal.ts`, applied in
`src/render/renderer.ts` at both widget-collection sites (`collectWidgets` and
`renderFull`). `custom-command.ts` is not touched.

`terminal.ts` owns the escape grammar for the whole codebase after #113, and
`sanitizeAnsi` reuses the same `ESCAPE_SEQUENCE` recogniser. The lesson #113
shipped was that the bug came from *two* recognisers disagreeing, not from one
narrow pattern: **never let a consumer re-derive "is this an escape".** A
sanitiser with its own private idea of where a sequence ends is that same defect
returning, and here it fails in the dangerous direction — a mis-parsed boundary
emits bytes rather than mis-counting columns.

Sanitising every widget output rather than `custom-command` alone costs nothing
internally: **no widget emits ANSI of its own.** Colour arrives later, in
`powerline.ts`, from the `fg`/`bg` fields. So the only escapes in any
`WidgetOutput.text` today are ones that came from outside the process, and a
blanket pass over `output.text` cannot damage anything this codebase generates.

The gain is that it is safe by default. `git-branch`, `project`, `cwd` and
`model` all surface text this tool did not author, and a future widget will
surface more. Requiring each to opt in is the same shape of failure as
"registered ≠ displayed", which is how the `compact-countdown` bug survived.

### Order: sanitise before the separator check

The call sits immediately after `if (!output) continue;` and **before**
`isSeparatorOutput(output)`.

`isSeparatorOutput` already treats `text === ""` as a separator. Placing the
sanitiser first means text that reduces to nothing — a command emitting only
escapes — flows into that existing branch in `collectWidgets`, so the compact
path cleans it away with no further change.

**`renderFull` needed a second, new rule.** `renderFull` does not call
`isSeparatorOutput` inline; it hands its collected outputs to
`cleanSeparators`, which only removes a separator-shaped entry when it is
adjacent to another separator or sits at a line boundary — the behaviour a
deliberately placed `{ type: "separator" }` widget mid-line depends on. An
emptied `custom-command` sitting between two ordinary widgets is neither
adjacent nor a boundary, so `cleanSeparators` kept it as-is and it laid out as
a bare padded, coloured segment with a separator glyph on each side — visible
proof the command ran, contradicting the whole point of sanitising it. The
ordering above is necessary but was not sufficient: the shipped code adds
`isEmptyOutput`, a predicate keyed on the sanitiser's exact empty-string
contract (`text === ""`, not `.trim() === ""` — whitespace is visible output,
not sanitiser fallout), checked in `cleanSeparators` *before* its existing
consecutive/boundary collapse logic runs. `isEmptyOutput` is not redundant
with the ordering rule; it is what makes `renderFull`'s empty-segment case
actually collapse. See `src/render/renderer.ts`.

### The allowlist

| Input | Result | Why |
|---|---|---|
| `ESC[31m`, `ESC[1m`, `ESC[0m`, `ESC[38:2::1:2:3m` | kept | SGR is the allowlist |
| `ESC[>4;2m`, `ESC[?1m`, `ESC[ m` | dropped | not SGR — see below |
| `ESC[2J`, `ESC[1A`, `ESC[H`, `ESC[?25l` | dropped | erase / cursor control |
| `ESC]0;title BEL`, `ESC]8;;uri ST`, DCS/SOS/PM/APC | dropped | all OSC out |
| `ESC c`, `ESC ( B` — nF and two-character | dropped | includes full reset |
| lone `ESC` the grammar cannot complete | dropped | see "Incomplete escapes" |
| `TAB` | one space | see "TAB" |
| `CR`, `BEL`, `LF`, `DEL`, other C0 | dropped | `CR` overwrites the bar; `LF` breaks the two-line structure |
| any SGR survived | append one `ESC[0m` | see "Containment" |

### "SGR" is narrower than "CSI ending in `m`"

The obvious predicate — reuse the grammar's CSI shape and check the final byte
is `m` — is wrong, and wrong in the direction that matters.

`ESCAPE_SEQUENCE` spells a CSI's parameter bytes `[0-?]`, per ECMA-48. That
range includes the private-marker bytes `<`, `=`, `>` and `?`. So `CSI > 4 ; 2 m`
ends in `m` and would pass such a check — but it is `modifyOtherKeys`, an xterm
keyboard-protocol mode change, not colour. Letting a `custom-command` reconfigure
how the user's terminal reports keypresses is exactly the hazard this issue
exists to close, and it would have walked straight through the allowlist.

SGR is therefore matched by its own narrow pattern: `ESC [`, then parameter
bytes drawn from digits, `;` and `:` only, then `m`. No private markers, no
intermediate bytes (`ESC [ SP m` is not SGR either). `:` is included for T.416
subparameter forms such as `38:2::1:2:3`, which real tools emit for truecolour
and underline styles; a private marker is excluded outright — the
parameter-byte class admits only digits, `;` and `:`, so `<`, `=`, `>` and `?`
cannot appear anywhere in it, not merely as the first byte — so admitting `:`
cannot smuggle one in.

This is a second recogniser in `terminal.ts`, which sits uneasily beside "never
let a consumer re-derive 'is this an escape'". It does not violate that rule:
`sanitizeAnsi` still uses `ESCAPE_SEQUENCE` alone to decide **where each
sequence starts and ends**, and consults the SGR pattern only to classify a
span whose boundaries are already fixed. Finding boundaries is the job that must
never be duplicated; classifying is not. The SGR pattern must stay anchored so
it can only ever test a whole span.

### OSC-8 hyperlinks: dropped

The judgment call the issue flags, decided against, and documented at the
sanitiser so it is not quietly reversed.

Keeping them requires parsing OSC parameters to separate `ESC]8;;uri` from
`ESC]0;title` — the allowlist stops being "one sequence class" and becomes a
parameter-level policy. It also requires force-closing: an unclosed hyperlink
leaks link state onto everything Claude Code draws after the bar, so a
`ESC]8;;ST` would have to be appended whenever the text opened one. That is real
machinery, with its own tests and its own failure modes, for a capability nobody
has asked for and that only some terminals render inside a statusline.

The loss is real but small. If someone wants it, the rule to relax is a single
predicate.

### Incomplete escapes: dropped, inverting #113's rule

This asymmetry is the subtlest part of the change.

For **measuring**, #113 established that an escape the grammar cannot complete
stays visible text, deliberately: over-measuring truncates early, which is
cosmetic, while under-measuring overflows the terminal, which is the bug class
#113 and #86 exist to close. A malformed sequence must never make the rest of
the bar free.

For **emitting**, that same rule is the attack. A command whose output ends in
an unterminated `ESC[2` contributes an ESC and a `2` that render as harmless
text on their own — until the next literal `J` anywhere later in the bar
completes them into a screen-clear. The terminal does not care that the two
halves came from different widgets.

So: measurement fails safe by *keeping* an incomplete escape; sanitising fails
safe by *dropping* it. Only the ESC byte is dropped — the printable remainder
(`[2`) stays and renders as literal text, which is honest and costs the
measurer nothing it does not already handle.

### TAB: replaced with one space, not dropped

`ZERO_WIDTH_CONTROL_CLASS` excludes TAB because its width depends on the
cursor's position against the next tab stop, which is not knowable statically;
counting it as 1 is a floor, and a floor can only over-measure.

Replacing it with a single space makes that floor exact rather than approximate,
and preserves the separation the tab was expressing — dropping it outright turns
`foo⇥bar` into `foobar`. A statusline segment has no use for a real tab stop.

### LF: dropped, and why that does not repeat #113's mistake

`stripAnsi` deliberately does *not* strip LF: the bar is two lines and callers
`split("\n")` its output, so LF is a structural separator there. Removing it
from that class collapsed the two-line bar into one 90-column line and turned
four assertions in `default-layout-width.test.ts` vacuous.

The sanitiser is at a different layer. It runs on a single `WidgetOutput.text`,
per widget, *before* `renderFull` joins lines with `"\n"`. At that layer a LF is
never structural — it can only break the bar's line structure from inside a
segment. Dropping it here and preserving it in `stripAnsi` are consistent, not
contradictory.

### Containment: append `ESC[0m` when SGR survives

`powerline.ts` wraps each segment as `chalk.hex(fg).bgHex(bg)(" " + text + " ")`.
chalk closes only fg (`ESC[39m`) and bg (`ESC[49m`); it does not emit a full
reset. So an allowed-but-unclosed `ESC[7m` (reverse) or `ESC[5m` (blink)
survives past the segment, past the bar, and into Claude Code's TUI — the same
corruption class as `ESC[2J`, arriving through a sequence we agreed to allow.

If any SGR survives sanitising, one `ESC[0m` is appended — unless the output
already ends in `ESC[0m`, in which case nothing is appended. That guard is
what makes the function idempotent: without it, sanitising an
already-sanitised string (which itself ends in the appended reset, still
valid SGR) would see SGR survive again and append a second one, so re-running
the sanitiser would keep growing the string instead of reaching a fixed
point. The cost of the reset itself is that the segment's trailing padding
column loses its background in powerline mode. That cost is already being
paid today: a command that colours itself almost always emits its own
`ESC[0m`, which we keep, so that column is already resetting. Our reset
introduces no new glitch and closes the leak.

## Testing

`sanitizeAnsi` unit tests, one per acceptance sequence — `ESC[2J`, `ESC[1A`,
`ESC[?25l`, `CR` — plus SGR survival, `ESC[>4;2m` and `ESC[?1m`
being dropped despite ending in `m`, the split-across-boundary `ESC[2` case,
TAB, LF, and the appended reset.

A renderer-level test that drives a real `custom-command` config emitting those
bytes and asserts they are absent from the rendered bar. The acceptance
criterion is about the *bar*, not the helper, and only a test at that layer
proves the renderer actually calls the sanitiser at both collection sites.

Every test verified by breaking what it guards, per the project's
`vacuous-tests` rule. The specific trap expected here: `expect(bar).not
.toContain("\x1b[2J")` passes vacuously if the widget returned `null` and
rendered no segment at all. Each such test must also assert the segment's
visible text is still present, so it distinguishes "sanitised" from "absent".

## Ship

`npm run build` and `git add -f dist/index.js` in the same commit. CI's
`bundle-drift` job enforces byte-equality, and a src-only commit leaves
`git pull` upgraders running the old code.

No config surface changes, so `config-schema.json` does not move.
