# Terminal width detection — design

Issue: [#67](https://github.com/gapietro/gccusage/issues/67)
Date: 2026-08-01

## Problem

`getTerminalWidth()` is:

```ts
return process.stdout.columns || 80;
```

`process.stdout.columns` is `undefined` whenever stdout is not a TTY, and Claude
Code always pipes the statusline's stdout — that is why `powerline.ts` has to
force `chalk.level = 3`. The width is therefore permanently the `|| 80`
fallback, for every user, in every terminal. It has never reflected a real
terminal.

Three consequences:

1. **`compact.mode: "auto"` can never fire.** `shouldCompact` ends with
   `terminalWidth < (compact.threshold ?? 80)`, i.e. `80 < 80`. Always false.
   Tuning the threshold does not rescue it: any threshold at or below 80 never
   compacts and any threshold above 80 always compacts, so "auto" is a constant
   either way. `README.md:141-143` documents the feature as working.
2. **Line 2 truncates silently.** `renderLine` ends with
   `truncateAnsi(line, context.terminalWidth)`. After PR #66 added the `project`
   segment, line 2 with `vim.mode` active comes to roughly 84 columns and is cut
   mid-word on a 200-column terminal, because the code believes the terminal is
   80.
3. **`renderCompact` mis-charges for separators**, using an arithmetic estimate
   that is wrong by a different amount in each render mode (see below).

## What Claude Code actually provides

Settled by disassembling the installed Claude Code **2.1.220** binary, using the
technique recorded for the auto-compact work: the bun-compiled binary at
`~/.local/share/claude/versions/<version>` carries the JS embedded, and a regex
over the raw bytes recovers the minified source.

The statusline command is executed by `UWs`, which delegates to the shared
hook spawner `z$o`. That spawner builds the child environment as:

```js
let L = {...MO(), ...KDt(o), CLAUDE_PROJECT_DIR: b(C)},
    {columns: N, rows: P} = process.stdout;
if (N) L.COLUMNS = String(N);
if (P) L.LINES = String(P);
```

Claude Code reads `process.stdout.columns` from its **own** process — which is
a TTY — and injects `COLUMNS` and `LINES` into the statusline subprocess's
environment. So the real terminal width is available as `process.env.COLUMNS`,
with no `/dev/tty` or `tput` subprocess required, and it is re-read on every
spawn so it tracks live terminal resizes.

The `if (N)` guard matters: when Claude Code itself is not attached to a TTY
(headless `claude -p`, CI), neither variable is set. A fallback is still needed,
but the case is now rare rather than universal.

The payload builder (`yRS`) carries no width field, so there is nothing to read
out of stdin.

### Measured: there is no reserve (gutter = 0)

An earlier draft of this spec suspected a 2-column reserve, from JSX colocated
with the statusline code showing a `minWidth: 2` prefix box beside a
`wrap: "truncate"` text node. **That guess is wrong. The usable width is
`COLUMNS` exactly.**

Measured on 2026-08-01 against Claude Code 2.1.220 by pointing
`statusLine.command` at a ruler script and reading the cut point. Two facts
settle it:

1. **Structural.** Claude Code derives the child's `COLUMNS` from its own
   `process.stdout.columns`, and Ink truncates the rendered statusline to that
   same `process.stdout.columns`. They are one value sampled at two instants, so
   no systematic reserve can exist between them.
2. **Empirical.** A ruler emitting a fixed 200 columns — long enough that the
   cut point is the true render width regardless of how stale the frame is — was
   cut at exactly column 92 in a spawn that reported `COLUMNS=92`.

Readings that appeared to show a 4-column shortfall were all taken across a
terminal resize: `COLUMNS` is captured when the command spawns, while Ink
re-truncates the already-emitted text at display time, so a resize between the
two makes a fresh frame look truncated. A ruler whose length is derived from
`COLUMNS` cannot distinguish that case from a real reserve; a fixed-length ruler
can, which is why the fixed-200 reading is the one that counts.

**Consequence for the design:** no `STATUSLINE_GUTTER` constant and no
`availableWidth()` helper. A named constant equal to zero, and a subtraction of
zero, are dead weight — layout works against `terminalWidth` directly. If
evidence of a reserve ever emerges, reintroducing it is a three-line change; the
measurement above is recorded so the question is not re-litigated from the JSX
alone.

**Residual risk, accepted:** if a small reserve does exist at some width we did
not sample, our ellipsis lands a column or two late and Ink trims the tail
instead of us. The failure mode is cosmetically identical and loses no
information.

## Approaches considered

**A. Read `COLUMNS` from the environment.** Chosen. Zero cost, tracks resizes,
no subprocess.

**B. Open `/dev/tty` and shell out to `tput cols`.** Works without `COLUMNS`,
but spawns a subprocess on a path Claude Code re-runs on a 300 ms debounce, and
fails where there is no controlling terminal. Strictly worse than A.

**C. Read width from the stdin payload.** Not possible; the field does not
exist. Upstream request at best.

## Design

### Width detection

`src/utils/terminal.ts`:

```ts
export function getTerminalWidth(): number | undefined
```

Precedence:

1. `process.stdout.columns` if truthy — live and exact when stdout is a TTY,
   which is the case when someone runs `gccusage` directly in a terminal. A
   shell-exported `COLUMNS` can be stale, so the live value wins.
2. else `process.env.COLUMNS` parsed as a positive integer — the Claude Code
   path.
3. else `undefined` — genuinely unknown.

Malformed values (`"0"`, `"abc"`, negative, non-integer) are treated as unknown
rather than coerced, so a broken environment degrades to "do not mangle the
output" instead of to a wrong number.

`RenderContext.terminalWidth` becomes `number | undefined` and carries the
**true terminal width**.

### Width reserve: none

Measurement (above) put the reserve at zero, so layout uses `terminalWidth`
directly. There is no `STATUSLINE_GUTTER` and no `availableWidth()` helper.

The reason for measuring rather than assuming stands regardless of the answer: a
plausible constant that is wrong in an unexercised case is exactly the failure
mode of the old 83.5% auto-compact estimate, which survived review because it
was exactly right at the window size everyone used. Here the guess under test
was `COLUMNS - 2`, and it was wrong.

### Line measurement

`renderCompact` currently estimates each segment as
`visibleLength(text) + 2 + 3`. The true cost differs by mode:

- **Powerline**: `visibleLength(text) + 3` — 2 for the surrounding spaces plus
  exactly 1 separator glyph, since `layoutPowerline` emits `N-1` inner
  separators plus 1 closing separator, i.e. `N` glyphs for `N` segments.
- **Plain**: `visibleLength(text)` — `renderLine` joins colorized segments with
  `""`, and `collectWidgets` has already dropped separator widgets, so there is
  no per-segment overhead at all.

The estimate is therefore wrong in both modes, by different amounts. This is not
a tuning error; it is a second, independent implementation of the layout that
drifted from the real one.

The fix is to delete the estimator rather than correct its constants. Once
unknown width means "no padding, no truncation" (below), `renderLine` called
with an unknown width returns the line at its **natural** width — so measuring
is just rendering and taking `visibleLength`:

```
measureLine(outputs, settings, context) =
  visibleLength(renderLine(outputs, settings, {...context, terminalWidth: undefined}, "left"))
```

`renderCompact` fits greedily against that instead of arithmetic. There is then
exactly one layout implementation, and the measurement cannot disagree with the
painter because it *is* the painter. The cost is negligible: the greedy loop
renders at most `n` candidate lines of at most `n` segments, and `n` is bounded
by the number of configured widgets.

This is a refinement of an earlier draft that proposed a separate
`src/render/measure.ts` summing `layoutPowerline` pieces. That would have been a
second implementation of the same layout — the very thing this section exists to
eliminate — and it would also have had to re-derive `renderLine`'s
separator-widget filter to stay in agreement.

### Unknown-width behaviour

Unknown propagates as a decision at each consumer, never as a substitute number:

| Consumer | Behaviour when width is unknown |
| --- | --- |
| `shouldCompact` | `false` — never collapse the bar on a guess |
| `applyFlex` | no padding; left-align regardless of configured mode |
| `truncateAnsi` | return the line unchanged |

This is the safe direction: Claude Code truncates on its own end, so emitting an
untruncated line degrades to Claude Code's own behaviour, whereas truncating to
a guessed 80 destroys output that would have fit.

### Compact threshold

The default stays 80, now measured against the real width. Line 2 measures
roughly 84 columns at its worst, so a normal 100+ column terminal never
compacts, and genuinely narrow terminals now do — which is what the option
always claimed to do.

### Documentation

`README.md:141-143` is corrected in the same commit. The claim becomes true, but
the wording should state the actual rule (collapse below the configured
threshold, default 80) rather than the vague "narrow terminals".

## Testing

The reason this shipped is that nothing exercised the real path. Tests target
that specifically.

1. **`getTerminalWidth` unit tests** — precedence between `process.stdout.columns`
   and `COLUMNS`, malformed values, and the unknown case. Every case must set or
   delete `COLUMNS` explicitly: vitest inherits whatever the surrounding shell
   exports, so a test that does not control it passes or fails by accident.
2. **End-to-end spawn test** — extend the existing `process.execPath` CLI test to
   run the built statusline with `COLUMNS` set and stdout piped, asserting the
   rendered bar reflects that width. This is the only test in the suite that
   would have failed before the fix; a unit test with a mocked `process.stdout`
   would not have.
3. **Natural-width property** — across a range of widget sets, in both powerline
   and plain mode, `renderLine` with an unknown width must add no padding and
   perform no truncation, so that `measureLine` reports the true natural width.
   This is the invariant the whole measure-by-rendering approach rests on.
4. **Real-payload width regression** — the default layout rendered against the
   captured real payloads with `vim.mode` active must fit within a stated width
   without truncating. This pins the #66 regression that made the issue binding.

## Build requirement

`dist/index.js` is force-tracked and `gccusage setup` points
`statusLine.command` at it. Any commit touching `src/` must run `npm run build`
and stage the bundle in the same commit, or upgraders who `git pull` keep
running the old code.

## Out of scope

- Whether `gccusage` should truncate at all, given Claude Code truncates with
  Ink `wrap: "truncate"`. Considered and deliberately not taken on; revisit
  separately if the gutter measurement suggests our truncation is redundant.
- The remaining open issues (#68, #69, #64, #58, #60, #61, #62, #63, #46).
