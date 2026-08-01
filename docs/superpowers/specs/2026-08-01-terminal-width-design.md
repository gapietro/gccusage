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

### Unverified observation

The statusline text appears to be rendered through Ink with `wrap: "truncate"`,
beside a `minWidth: 2` prefix box, which would make the usable width
`COLUMNS - 2`. This was read off the JSX colocated with the statusline code and
is **not** proven end-to-end. It is resolved by measurement during
implementation rather than assumed — see "Width reserve" below.

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

### Width reserve

The renderer — the only consumer of `terminalWidth` — derives
`availableWidth = Math.max(1, terminalWidth - STATUSLINE_GUTTER)`. The clamp
keeps a pathologically narrow terminal from producing a zero or negative budget,
which `truncateAnsi` and `applyFlex` would otherwise be handed.

`STATUSLINE_GUTTER` is **measured, not guessed**: implementation includes
rendering a ruler bar of known width at a known `COLUMNS` and observing the exact
column at which Claude Code cuts. Whatever value falls out (0, 1, or 2) becomes
the constant, with the measurement recorded in a comment beside it.

Keeping the reserve at the render layer rather than inside `getTerminalWidth()`
means the helper stays honest about what it reports.

Rationale for measuring: a plausible constant that is wrong in an unexercised
case is exactly the failure mode of the old 83.5% auto-compact estimate, which
survived review because it was exactly right at the window size everyone used.

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

New module:

```
src/render/measure.ts
  measureLine(outputs, settings): number
```

It runs the same `layoutPowerline` the painter runs and sums `visibleLength`
over the returned pieces; in plain mode it sums the segment texts. `renderCompact`
fits greedily against `measureLine` rather than arithmetic. One layout
implementation means the estimator and the renderer cannot drift apart again,
which is the actual defect.

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
3. **Measurement agreement property** — across a range of widget sets, in both
   powerline and plain mode,
   `measureLine(outputs) === visibleLength(stripAnsi(renderLine(outputs)))`.
   Kills the drift class permanently.
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
