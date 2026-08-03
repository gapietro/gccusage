import { eastAsianWidth } from "get-east-asian-width";

/**
 * Grapheme cluster boundaries, per UAX #29.
 *
 * Constructed once at module scope: building an `Intl.Segmenter` is the
 * expensive part, segmenting with it is not. Grapheme segmentation is
 * locale-independent per the spec; `"en"` is passed rather than `undefined`
 * so the result cannot drift with the host machine's default locale.
 */
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** VARIATION SELECTOR-16 — requests the two-column emoji presentation. */
const VS16 = "️";

/** REGIONAL INDICATOR SYMBOL LETTER A .. Z — two of these make a flag. */
const REGIONAL_INDICATOR_FIRST = 0x1f1e6;
const REGIONAL_INDICATOR_LAST = 0x1f1ff;

/** `str` split into grapheme clusters — what a reader would call "characters". */
export function splitGraphemes(str: string): string[] {
  const clusters: string[] = [];
  for (const { segment } of segmenter.segment(str)) clusters.push(segment);
  return clusters;
}

/**
 * Terminal columns occupied by ONE grapheme cluster.
 *
 * Width comes from the cluster's FIRST code point: a ZWJ family's base is
 * `👨` (wide), a decomposed `é`'s base is `e` (narrow), and the trailing
 * combining marks, joiners and variation selectors cost nothing because they
 * sit inside the cluster rather than being separate iterations.
 *
 * Two exceptions are applied before the table lookup, both measured against
 * the package rather than reasoned about:
 *
 * - A cluster containing VS16 counts 2. `❤️` is U+2764, East_Asian_Width
 *   Ambiguous and therefore 1 on its own, but the selector requests the
 *   emoji presentation and terminals draw that at two columns.
 * - A cluster led by a Regional Indicator counts 2. Regional Indicators are
 *   East_Asian_Width **Neutral**, so `🇯🇵` measures 1 from its base code point
 *   alone, while every terminal draws a flag at two columns.
 *
 * `ambiguousAsWide: false` is passed EXPLICITLY and must stay that way. The
 * package's runtime default is narrow, but its own JSDoc declares
 * `@default true`; a release that aligned the code to its documentation would
 * otherwise silently double-count `▶`, `…`, `│` and the powerline glyphs,
 * which are all Ambiguous, and shift every measurement in the bar.
 */
export function graphemeWidth(cluster: string): number {
  if (cluster === "") return 0;
  if (cluster.includes(VS16)) return 2;
  const codePoint = cluster.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= REGIONAL_INDICATOR_FIRST && codePoint <= REGIONAL_INDICATOR_LAST) {
    return 2;
  }
  return eastAsianWidth(codePoint, { ambiguousAsWide: false });
}

/**
 * Terminal columns `str` occupies.
 *
 * Input must already be free of ANSI escapes — this counts what it is given.
 * `visibleLength` in `terminal.ts` is the ANSI-aware entry point.
 */
export function displayWidth(str: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(str)) width += graphemeWidth(segment);
  return width;
}
