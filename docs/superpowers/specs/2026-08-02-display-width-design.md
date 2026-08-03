# Display width measurement — design

Issue: [#86](https://github.com/gapietro/gccusage/issues/86) (audit finding COR-003, P2)
Date: 2026-08-02

## Problem

`visibleLength` measures with `String.prototype.length`, which counts UTF-16 code
units rather than terminal columns:

```ts
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}
```

Every width decision in the renderer is built on it — `flex.ts` padding,
`renderer.ts`'s `measureLine` and the `renderCompact` greedy fit, `truncation.ts`,
and `shrink.ts`. East Asian characters occupy two columns but count as one, so a
line of CJK is under-measured by half and the bar overflows and wraps.

From the issue, at `COLUMNS=45` with `compact.mode: "never"` and a project
directory named `日本語プロジェクト名前テストの長い`:

```
counted=45   Opus 4.6 ▶ $1.00 ▶ [===-------] 30% (200.0k…     <- correct
counted=35   日本語プロジェクト名前テストの長い ▶ Today: $1.00 ▶   <- 35 counted, 52 displayed
```

`project` and `git-branch` are the two shrinkable widgets and both carry
user-chosen names, which is exactly where non-ASCII appears.

## Three defects, not one

The issue names the first. The other two were found while reading the call sites
and are part of the same fix.

**1. `visibleLength` under-counts wide characters.** As above.

**2. `truncateAnsi` has an independent second guard that defeats the fix.**

```ts
if (visibleLength(str) <= maxWidth) return str;
const plain = stripAnsi(str);
if (plain.length <= maxWidth) return str;     // raw UTF-16 length
```

Correct `visibleLength` and leave this line, and the issue's own reproduction
still passes through untouched: 34 CJK glyphs measure 68 columns so the first
check correctly falls through, then `plain.length` is 34, which is `<= 45`, and
the un-truncated string is returned. The line must be deleted, not supplemented.

`truncateAnsi` also walks `str` one UTF-16 unit at a time doing `visible++`, so
independently of width it can cut a surrogate pair in half and emit a broken
glyph.

**3. `shrink.ts`'s `trimTo` slices by code point** (`Array.from`), so trimming can
leave a dangling ZWJ or strip a combining mark off its base. Its comments also
explain the multi-column overshoot as "a surrogate pair counts as 2 code units",
which is true of today's buggy measure and stops being the reason once we measure
by cluster.

## Decisions

### Width data: the `get-east-asian-width` dependency

A third runtime dependency, alongside `chalk` and `valibot`. It is zero-dependency,
pure ESM, ~14.6 KB unpacked, and is nothing but the generated East_Asian_Width
lookup from the Unicode data files. It bundles into `dist/index.js`, so users
carry no install cost.

Rejected: hand-rolling the ranges (goes stale as Unicode adds blocks, and a
hand-typed table is easy to get subtly wrong), and `string-width` (pulls
`emoji-regex` + `strip-ansi` + `ansi-regex` transitively and duplicates the
`stripAnsi` this repo already has).

### Ambiguous characters count as 1 — and the option is passed explicitly

Measured against the real package before choosing:

```
▶ U+25B6   ambiguous  default=1  ambiguousAsWide=2
… U+2026   ambiguous  default=1  ambiguousAsWide=2
│ U+2502   ambiguous  default=1  ambiguousAsWide=2
 U+E0B0   ambiguous  default=1  ambiguousAsWide=2   (powerline separator)
 U+E0A0   ambiguous  default=1  ambiguousAsWide=2   (branch glyph)
日          wide       2
😀          wide       2
=          narrow     1
```

Every decorative glyph the bar draws is Ambiguous. Treating Ambiguous as wide
would double-count all of them and shift every measurement in the renderer.
UAX #11 says Ambiguous should default to narrow where context cannot be
established, which is our situation.

`{ ambiguousAsWide: false }` is passed **explicitly** rather than relying on the
default, because the package's runtime default is narrow while its own JSDoc
declares `@default true`. A future version aligning the code to its documentation
would otherwise silently break the whole bar.

### Grapheme clusters via `Intl.Segmenter`

Summing East Asian width per code point gets CJK right and multi-code-point
glyphs wrong: a decomposed `é` (e + U+0301) counts 2 and a `👨‍👩‍👧` ZWJ family
counts 5. (Under today's `.length` those are 2 and 8, and a `🇯🇵` flag is 4.)
`Intl.Segmenter` is built into Node, needs full ICU
(shipped by default, and guaranteed by the `engines.node >=22` floor set in
PR #109), and costs no new dependency.

Each cluster is widthed by its **first** code point. That is what makes clusters
work: a ZWJ family's base is `👨` (wide → 2), a decomposed `é`'s base is `e`
(narrow → 1), and trailing combining marks, joiners and variation selectors
contribute nothing because they are inside the cluster rather than separate
iterations.

Two exceptions, applied as explicit rules before the table lookup. Both were
found by measuring the real package rather than reasoning about it, and both are
what `string-width` does:

- **A cluster containing U+FE0F (VS16) counts 2.** `❤️` is U+2764 (Ambiguous → 1)
  plus VS16, but terminals render the emoji presentation at two columns.
- **A cluster whose first code point is a Regional Indicator (U+1F1E6–U+1F1FF)
  counts 2.** Regional Indicators are East_Asian_Width=**Neutral**, so widthing
  `🇯🇵` by its base code point yields 1 — verified against the package, not
  assumed. Terminals render a flag at two columns.

Without these we would ship a known under-count of exactly the class this issue
is about.

### No speculative fast path

Measured, 20,000 iterations over the default 66-column bar:

```
.length             0.2ms
segmenter + EAW    81.2ms   (~4us/call)
ASCII regex test    0.5ms   -> matches: FALSE
```

The ASCII fast path that would have carried the common case **misses the default
bar entirely**, because `▶` is not ASCII. Meanwhile ~4us per call against a ~60ms
render budget means several hundred calls stay under 1ms.

So: implement correctly, then measure the render path using this repo's
established method (`git show <merge-base>:dist/index.js` as the before-binary,
statusline cache cleared between runs, timed to process exit). Add a fast path
only if that measurement justifies one.

## Design

A new unit, `src/utils/display-width.ts`, owns all Unicode reasoning and nothing
else:

```ts
splitGraphemes(str: string): string[]     // Intl.Segmenter, granularity: "grapheme"
graphemeWidth(cluster: string): number    // columns for ONE cluster: 0, 1 or 2
displayWidth(str: string): number         // sum over clusters; input must be ANSI-free
```

`graphemeWidth` is exported rather than kept private because `truncateAnsi` needs
the width of a single cluster as it walks. Routing that through `displayWidth`
would re-run the segmenter once per cluster — 66 segmentation passes over a
66-column line instead of one.

One module-scope `Intl.Segmenter` instance — construction is the expensive part,
segmentation is not.

`terminal.ts` keeps its public surface unchanged: `visibleLength(str)` becomes
`displayWidth(stripAnsi(str))`. Its four existing call sites need no import
changes for measurement.

**`truncation.ts`.** The `plain.length` guard is deleted. The walk becomes:
tokenize into ANSI runs and text runs; copy ANSI runs verbatim and count nothing;
split text runs with `splitGraphemes` and add each cluster's width until the next
would exceed `maxWidth - 1`, reserving one column for the ellipsis (`…` is
Ambiguous → 1). Stopping *before* a wide cluster that would straddle the boundary
means the result can be one column narrower than `maxWidth`; that is correct, and
is pinned by a test so it is not later "fixed" into an overflow.

Degenerate widths: at `maxWidth <= 1` the reserve leaves no room for content, and
appending the ellipsis alone would itself occupy 1 column and so overflow
`maxWidth = 0`. Such a line has nowhere to go, so `truncateAnsi` returns the empty
string (plus the reset) rather than an ellipsis that breaks its own contract. The
current implementation does not handle this; it is called out here because the
`maxWidth - 1` arithmetic makes it reachable and it needs a deliberate answer.

Acknowledged limitation: segmenting per text-run means a cluster split across an
escape (`a` `\x1b[31m` `U+0301`) is not joined. chalk wraps whole segments, so
this does not arise in practice; it is stated rather than papered over.

**`shrink.ts`.** `Array.from(text)` becomes `splitGraphemes(text)` in `trimTo`.
The peek-ahead, the overshoot allowance and the `stuck` set all stay — a cluster
can still be 2 columns, so removing one can still drop the width by 2 and
undershoot `MIN_SHRUNK_TEXT`. The comments are rewritten to state the real reason
in place of the surrogate-pair explanation.

**Unchanged:** `flex.ts`, `renderer.ts`, every widget, and every config schema.
They read through `visibleLength` and inherit the fix.

## Testing

Unit tests on `display-width.ts`: ASCII, CJK (`日本語` → 6), fullwidth forms,
decomposed `é` → 1, precomposed `é` → 1 (it is Ambiguous, so it also pins the
policy), flag → 2, ZWJ family → 2, `❤️` → 2, and — the policy pin — `▶`, `…`,
`│`, U+E0B0 and U+E0A0 each → 1. Every one of these figures was measured against
the real package while writing this spec, not derived from memory of the tables.

`truncateAnsi`: a case reproducing the deleted `plain.length` line; a
never-exceeds-`maxWidth` assertion; the wide-cluster-straddling case landing at
`maxWidth - 1`; an emoji at the cut point staying intact; ANSI escapes surviving.

`shrink.ts`: trimming a name containing a ZWJ emoji leaves no dangling joiner.

The issue's acceptance criterion: a CJK case in
`src/__tests__/default-layout-width.test.ts` asserting the rendered display width
stays within the terminal width. It must fail against the current implementation
before it passes against the fix.

Per this repo's `vacuous-tests` discipline, every new test is verified by breaking
what it guards. A test that passes on first run and cannot be made to fail is not
evidence.

## The regression guard

Every glyph the default bar draws is either ASCII or Ambiguous, and both measure 1
under either implementation. **This fix must therefore leave every existing width
measurement byte-identical.** If any current width test shifts, the Ambiguous
policy is wrong and the right response is to stop, not to update the expectation.
That invariant detects more than any assertion written for the occasion.

## Risks

The bundle grows by roughly the size of the EAW table. `npm run build` must run
and `dist/index.js` must be staged (`git add -f`), or CI's `bundle-drift` job goes
red — and, worse, `git pull` upgraders keep running the old code.

This touches the width path that `shrink`, `truncation` and `renderCompact` all
sit on, and `shrinkOutputs` already carries subtle loop-termination reasoning. The
mitigation is the invariant above.

## Out of scope

`stripAnsi`'s regex matches only SGR (`\x1b[...m`), so any other escape sequence
is counted as visible text. This is reachable — the `custom-command` widget puts
arbitrary shell output in the bar, so OSC-8 hyperlinks or cursor codes from a
user's command are mis-measured today. It is a distinct defect with a distinct
fix and gets its own issue rather than riding along here.
