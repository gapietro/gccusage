import { visibleLength, escapeLengthAt, isZeroWidthControl } from "../utils/terminal.js";
import { graphemeWidth, splitGraphemes } from "../utils/display-width.js";

const ELLIPSIS = "…";
const ESC = "\u001b";
const RESET = `${ESC}[0m`;

/**
 * `str` cut to at most `maxWidth` terminal columns, ending in an ellipsis.
 *
 * Walks grapheme clusters, not UTF-16 units: the previous implementation
 * incremented one column per code unit, which both under-counted wide glyphs
 * and could cut a surrogate pair in half. Issue #86.
 *
 * It also carried a second guard, `stripAnsi(str).length <= maxWidth`, that
 * defeated the whole fix on its own — 17 CJK glyphs are 34 columns but report
 * a `length` of 17, so a bar overflowing a 20-column budget was returned
 * untouched. That guard is deliberately gone; do not reintroduce it.
 */
export function truncateAnsi(str: string, maxWidth: number | undefined): string {
  // Unknown width: return the line untouched. Claude Code truncates on its own
  // end, so an over-long line degrades to its behaviour, whereas truncating to
  // a guessed width destroys output that would have fit.
  if (maxWidth === undefined) return str;
  if (visibleLength(str) <= maxWidth) return str;

  // One column is reserved for the ellipsis (`…` is East_Asian_Width Ambiguous,
  // which this codebase measures as 1). At maxWidth <= 1 there is no room for
  // content, and the ellipsis alone would occupy the whole budget or overflow
  // it — so emit nothing rather than break the contract this function exists
  // to enforce.
  const budget = maxWidth - 1;
  if (budget <= 0) return RESET;

  const result: string[] = [];
  let used = 0;
  let i = 0;

  while (i < str.length) {
    // Escapes are copied verbatim and cost no columns. The recogniser is
    // `terminal.ts`'s — the same one `visibleLength` measures with. This used
    // to be a private `indexOf("m", i)` scan, and the two disagreeing was half
    // of #113: that scan read the `m` of `home` as an SGR terminator, so
    // `ESC[2Jhome` came back as the whole input plus an ellipsis — three
    // columns of visible text charged nothing, and a string longer than the
    // one it was asked to shorten. It could also cut inside an OSC-8 URL,
    // emitting a sequence the terminal never finds a terminator for.
    const escapeLength = escapeLengthAt(str, i);
    if (escapeLength > 0) {
      result.push(str.slice(i, i + escapeLength));
      i += escapeLength;
      continue;
    }

    // The run of text up to the next escape. Searching from `i + 1` matters:
    // an ESC that opens no sequence the grammar recognises reaches here, and
    // searching from `i` would find it again, yielding an empty run and
    // spinning forever. Included in the run instead, it costs one column —
    // exactly what `visibleLength` charges it, ESC being deliberately excluded
    // from the zero-width control class for that reason.
    //
    // Segmenting per run means a cluster split ACROSS an escape (`a`, ESC[31m,
    // U+0301) is not rejoined. chalk wraps whole segments, so this does not
    // arise in practice; it is stated rather than papered over.
    let runEnd = str.indexOf(ESC, i + 1);
    if (runEnd === -1) runEnd = str.length;

    for (const cluster of splitGraphemes(str.slice(i, runEnd))) {
      // A control that drives the terminal without drawing — CR, BEL, BS —
      // costs no columns, matching `visibleLength`. Copied through rather than
      // dropped: this function truncates, it does not sanitise, which is the
      // same posture it takes towards the escapes above.
      const width = isZeroWidthControl(cluster) ? 0 : graphemeWidth(cluster);
      // Stop BEFORE a cluster that would straddle the budget. A wide cluster
      // at the boundary leaves the result one column short of maxWidth, which
      // is correct: never overflow.
      if (used + width > budget) {
        result.push(ELLIPSIS, RESET);
        return result.join("");
      }
      result.push(cluster);
      used += width;
    }

    i = runEnd;
  }

  // Defensive, and no longer the known-defective path it was before #113.
  //
  // Reaching here means the walk charged the whole string at most `budget`
  // columns while the `visibleLength` check at the top said it needed more
  // than `maxWidth`. Both now share a recogniser, so the only way they can
  // still disagree is the run-boundary cluster split noted above, and that
  // direction over-charges rather than under-charges. The ellipsis is appended
  // regardless: `used <= budget` holds, so the result is inside `maxWidth`
  // either way, and the contract is a ceiling rather than a promise that an
  // ellipsis means something was dropped.
  result.push(ELLIPSIS, RESET);
  return result.join("");
}
