import { visibleLength } from "../utils/terminal.js";
import { graphemeWidth, splitGraphemes } from "../utils/display-width.js";

const ELLIPSIS = "…";
const RESET = "\u001b[0m";

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
    // SGR escapes are copied verbatim and cost no columns.
    if (str[i] === "\u001b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        result.push(str.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }

    // The run of text up to the next escape. Searching from `i + 1` matters:
    // a lone ESC that is not a valid SGR sequence reaches here, and searching
    // from `i` would find it again, yielding an empty run and spinning
    // forever. Included in the run instead, it costs one column — exactly what
    // the previous implementation charged it.
    //
    // Segmenting per run means a cluster split ACROSS an escape (`a`, ESC[31m,
    // U+0301) is not rejoined. chalk wraps whole segments, so this does not
    // arise in practice; it is stated rather than papered over.
    let runEnd = str.indexOf("\u001b", i + 1);
    if (runEnd === -1) runEnd = str.length;

    for (const cluster of splitGraphemes(str.slice(i, runEnd))) {
      const width = graphemeWidth(cluster);
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

  // Reachable: a malformed escape that `stripAnsi`'s SGR regex does not
  // recognise (e.g. `"\x1b[" + "x".repeat(30) + "m"`, whose body is
  // non-digit) is still swallowed whole by this walk's own `indexOf("m", i)`
  // scan and charged 0 columns, so the loop can exhaust `str` and fall
  // through here even though the emitted string overflows `maxWidth`. That
  // is a defect in non-SGR escape handling, tracked as issue #113 — not
  // something to fix by tightening this function's own guard.
  result.push(ELLIPSIS, RESET);
  return result.join("");
}
