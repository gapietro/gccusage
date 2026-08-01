import type { WidgetOutput } from "../widgets/base.js";
import { visibleLength } from "../utils/terminal.js";

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
 * Slices by code point: `String.prototype.slice` would cut a surrogate pair in
 * half, so a branch name containing an emoji would render as a broken glyph.
 *
 * When text contains multi-column characters (astral characters like emoji),
 * removing one code point removes multiple columns. If removing one more would
 * cross below MIN_SHRUNK_TEXT, we stop and return a result slightly wider than
 * requested rather than violating the floor — the caller's truncation is the
 * backstop. This can cause slight overshoot of the requested overflow (removing
 * 5 when 4 were asked), which is acceptable.
 */
function trimTo(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let chars = Array.from(text);
  // Trim by code point until the result fits the target AND never drops below the floor.
  while (chars.length > 0) {
    const current = visibleLength(chars.join("") + ELLIPSIS);
    // Stop if we've reached the target.
    if (current <= width) break;
    // Peek ahead: what if we removed one more?
    const nextChars = chars.slice(0, -1);
    const next = visibleLength(nextChars.join("") + ELLIPSIS);
    // Stop if removing one more would drop below the floor.
    if (next < MIN_SHRUNK_TEXT) break;
    // Safe to proceed.
    chars = nextChars;
  }
  return chars.join("") + ELLIPSIS;
}

/**
 * The same outputs with `overflow` visible columns removed from segments that
 * allow it, or as many as the floor permits.
 *
 * Trims the widest shrinkable segment first, which levels segments rather than
 * destroying one while another stays long. Callers pass the amount a line
 * exceeds the terminal by; this module knows nothing about terminals or
 * rendering. Never mutates its argument.
 */
export function shrinkOutputs(
  outputs: WidgetOutput[],
  overflow: number,
): WidgetOutput[] {
  if (overflow <= 0) return outputs;

  const result = outputs.map((output) => ({ ...output }));
  let remaining = overflow;

  while (remaining > 0) {
    let widest = -1;
    let widestWidth = 0;
    for (let i = 0; i < result.length; i++) {
      const output = result[i]!;
      if (!output.shrinkable) continue;
      const width = visibleLength(output.text);
      if (width > MIN_SHRUNK_TEXT && width > widestWidth) {
        widest = i;
        widestWidth = width;
      }
    }
    // Every shrinkable segment sits at the floor; the caller's truncation is
    // the backstop from here.
    if (widest === -1) break;

    // Take this segment down toward the next-widest rather than all the way in
    // one go, so a single long segment cannot be annihilated while a nearly-as-
    // long neighbour is left untouched.
    const runnerUp = Math.max(
      MIN_SHRUNK_TEXT,
      ...result
        .filter((o, i) => o.shrinkable && i !== widest)
        .map((o) => visibleLength(o.text)),
    );
    const target = Math.max(MIN_SHRUNK_TEXT, runnerUp, widestWidth - remaining);
    // `widestWidth > MIN_SHRUNK_TEXT` and `remaining >= 1`, so `target` is
    // always strictly less than `widestWidth` — the loop cannot spin.
    const capped = Math.min(target, widestWidth - 1);

    const trimmed = trimTo(result[widest]!.text, capped);
    remaining -= widestWidth - visibleLength(trimmed);
    result[widest] = { ...result[widest]!, text: trimmed };
  }

  return result;
}
