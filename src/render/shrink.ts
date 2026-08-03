import type { WidgetOutput } from "../widgets/base.js";
import { visibleLength } from "../utils/terminal.js";
import { splitGraphemes } from "../utils/display-width.js";

/**
 * Fewest visible columns a shrunk segment may keep, ellipsis included.
 *
 * Below roughly this width a branch name stops distinguishing one branch from
 * another, so the columns buy nothing. Deliberately not configurable: a knob
 * would need documenting, validating and testing, and nothing yet suggests
 * anyone wants to tune it.
 */
export const MIN_SHRUNK_TEXT = 8;

const ELLIPSIS = "…";

/**
 * `text` reduced to at most `width` visible columns, ending in an ellipsis.
 *
 * Slices by grapheme cluster. `String.prototype.slice` would cut a surrogate
 * pair in half, and code-point slicing — what this used to do — would strip a
 * combining mark off its base or leave a ZWJ with nothing to join, so a branch
 * name containing an emoji rendered as a broken glyph.
 *
 * A single cluster can occupy two terminal columns (CJK, emoji), so removing
 * one cluster can remove two columns. If removing one more would cross below
 * MIN_SHRUNK_TEXT, we stop and return a result slightly wider than requested
 * rather than violating the floor — the caller's truncation is the backstop.
 * This can overshoot the requested overflow slightly (removing 5 columns when
 * 4 were asked), which is acceptable.
 */
function trimTo(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let clusters = splitGraphemes(text);
  // Trim by cluster until the result fits the target AND never drops below the floor.
  while (clusters.length > 0) {
    const current = visibleLength(clusters.join("") + ELLIPSIS);
    // Stop if we've reached the target.
    if (current <= width) break;
    // Peek ahead: what if we removed one more?
    const nextClusters = clusters.slice(0, -1);
    const next = visibleLength(nextClusters.join("") + ELLIPSIS);
    // Stop if removing one more would drop below the floor.
    if (next < MIN_SHRUNK_TEXT) break;
    // Safe to proceed.
    clusters = nextClusters;
  }
  return clusters.join("") + ELLIPSIS;
}

/**
 * The same outputs with `overflow` visible columns removed from segments that
 * allow it, or as many as the floor permits.
 *
 * Trims the widest shrinkable segment first, which levels segments rather than
 * destroying one while another stays long. Callers pass the amount a line
 * exceeds the terminal by; this module knows nothing about terminals or
 * rendering. Never mutates its argument.
 *
 * Hazard, currently latent: `trimTo` slices by grapheme cluster with no idea
 * that `sanitizeAnsi` (issue #115) may have appended a trailing `ESC[0m` to
 * `output.text`, so trimming a shrinkable segment can cut that reset off and
 * leave an open SGR loose in the bar. Unreachable today only because the two
 * `shrinkable: true` widgets, `git-branch` and `project`, both surface git
 * refnames, and refnames cannot contain control bytes — so their text never
 * carries SGR for `trimTo` to endanger. A future widget that sets
 * `shrinkable: true` on text that can carry SGR reopens this; re-appending a
 * reset after any trim would be the fix.
 */
export function shrinkOutputs(
  outputs: WidgetOutput[],
  overflow: number,
): WidgetOutput[] {
  if (overflow <= 0) return outputs;

  const result = outputs.map((output) => ({ ...output }));
  let remaining = overflow;

  // Indices `trimTo` cannot shorten any further without breaching the floor.
  // Without this, a segment made of two-column clusters (CJK, emoji) can sit
  // ABOVE the floor (say, width 9) purely as `trimTo`'s peek-ahead overshoot,
  // so the `width > MIN_SHRUNK_TEXT` eligibility check below keeps re-selecting
  // it — and re-trimming it to the exact same text forever, since the very
  // same peek-ahead refuses to take it down to 7. Comparing `trimTo`'s output
  // width against the input width (not against MIN_SHRUNK_TEXT) is what
  // detects that zero progress was made, regardless of why.
  const stuck = new Set<number>();

  while (remaining > 0) {
    let widest = -1;
    let widestWidth = 0;
    for (let i = 0; i < result.length; i++) {
      if (stuck.has(i)) continue;
      const output = result[i]!;
      if (!output.shrinkable) continue;
      const width = visibleLength(output.text);
      if (width > MIN_SHRUNK_TEXT && width > widestWidth) {
        widest = i;
        widestWidth = width;
      }
    }
    // Every shrinkable segment sits at the floor (or is stuck just above it);
    // the caller's truncation is the backstop from here.
    if (widest === -1) break;

    // Take this segment down toward the next-widest rather than all the way in
    // one go, so a single long segment cannot be annihilated while a nearly-as-
    // long neighbour is left untouched.
    const runnerUp = Math.max(
      MIN_SHRUNK_TEXT,
      ...result
        .filter((o, i) => o.shrinkable && i !== widest && !stuck.has(i))
        .map((o) => visibleLength(o.text)),
    );
    const target = Math.max(MIN_SHRUNK_TEXT, runnerUp, widestWidth - remaining);
    // `widestWidth > MIN_SHRUNK_TEXT` and `remaining >= 1`, so `target` is
    // always strictly less than `widestWidth` — the loop cannot spin ON THAT
    // ARITHMETIC. It can still spin if `trimTo` itself refuses to move (see
    // `stuck` above), which is why progress is verified below rather than
    // assumed from this bound.
    const capped = Math.min(target, widestWidth - 1);

    const trimmed = trimTo(result[widest]!.text, capped);
    const trimmedWidth = visibleLength(trimmed);
    if (trimmedWidth >= widestWidth) {
      // `trimTo`'s floor peek-ahead declined to remove anything (the next
      // code point would have breached MIN_SHRUNK_TEXT). Retrying this
      // segment would repeat the exact same refusal forever, so stop
      // considering it and let another segment (or the outer break above)
      // take over.
      stuck.add(widest);
      continue;
    }
    remaining -= widestWidth - trimmedWidth;
    result[widest] = { ...result[widest]!, text: trimmed };
  }

  return result;
}
