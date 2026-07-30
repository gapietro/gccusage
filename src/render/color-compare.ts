// Comparing colors as values: what chalk actually paints for a given string,
// and how far apart two painted colors look. Kept out of powerline.ts so that
// file stays about layout.

// Mirrors chalk's own `hexToRgb`, which is deliberately *unanchored* — it
// scans the string for the first 6-run (preferred) or 3-run of hex digits
// anywhere inside it, rather than requiring the whole string to be a clean
// hex color. See node_modules/chalk/source/vendor/ansi-styles/index.js:136
// (chalk@5.6.2): `/[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16))`. Re-check
// this against that file if chalk is ever upgraded.
const CHALK_HEX = /[a-f\d]{6}|[a-f\d]{3}/i;

/**
 * Normalize a color string the way chalk's `hex()`/`bgHex()` actually resolve
 * it: find the first embedded 6-digit (or 3-digit) hex run per chalk's own
 * unanchored regex, expand a 3-digit match to 6, lowercase it, and collapse
 * anything with no such run (named colors, empty strings, garbage) to the
 * same black chalk paints for those inputs. Because the match is unanchored,
 * inputs like "#abcd" or "#12345" resolve to a real color ("#aabbcc",
 * "#112233") rather than black — that mirrors chalk exactly, even though it
 * looks surprising next to a naive anchored implementation.
 */
export function normalizeColor(color: string): string {
  const match = CHALK_HEX.exec(color);
  if (!match) return "#000000";
  let digits = match[0].toLowerCase();
  if (digits.length === 3) {
    digits = [...digits].map((c) => c + c).join("");
  }
  return `#${digits}`;
}

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

// D65 white point in XYZ, derived the way CSS Color 4 derives it — from the
// CIE 1931 2° D65 chromaticity coordinates (x=0.3127, y=0.3290) — rather than
// a pre-rounded constant. Matters here: a rounded white point (e.g. the
// commonly-quoted 0.95047/1.08883) diverges from a reference implementation
// using this derivation by enough to fail a tight differential test (see the
// issue #40 Task 1 report) even though neither is "wrong" in isolation.
const D65_X = 0.3127 / 0.329;
const D65_Y = 1;
const D65_Z = (1 - 0.3127 - 0.329) / 0.329;

/** sRGB hex -> CIE L*a*b* (D65 white point). */
function hexToLab(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const r8 = (n >> 16) & 255;
  const g8 = (n >> 8) & 255;
  const b8 = n & 255;
  const r = srgbToLinear(r8 / 255);
  const g = srgbToLinear(g8 / 255);
  const b = srgbToLinear(b8 / 255);

  // sRGB D65 -> XYZ (matrix per CSS Color 4 / the observablehq color-matrix
  // calculator, higher precision than the commonly-quoted rounded matrix),
  // then scaled by the D65 white point.
  const x = (r * 0.4123907992659593 + g * 0.357584339383878 + b * 0.1804807884018343) / D65_X;
  const y = (r * 0.2126390058715102 + g * 0.715168678767756 + b * 0.0721923153607337) / D65_Y;
  const z = (r * 0.0193308187155918 + g * 0.119194779794626 + b * 0.9505321522496607) / D65_Z;

  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  const l = 116 * fy - 16;
  // Achromatic RGB (r === g === b, e.g. any grey) picks up a spurious sliver
  // of chroma here from floating-point rounding in the matrix multiply above
  // — a and b land at ~1e-14 instead of exactly 0. That's normally invisible,
  // but CIEDE2000's hue terms are ill-conditioned right at chroma zero, so it
  // was measured (see the issue #40 Task 1 report's differential script) to
  // occasionally swing colorDistance by ~1e-6 against a reference for grey
  // comparisons. culori and d3-color hit the same float noise and special-case
  // it away (https://github.com/d3/d3-color/pull/46); mirror that here.
  if (r8 === g8 && g8 === b8) return [l, 0, 0];
  return [l, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * CIEDE2000 perceptual difference between two colors, after resolving each to
 * the color chalk would actually paint for it.
 *
 * Why CIEDE2000 and not a WCAG contrast ratio: WCAG contrast measures
 * luminance only, for text legibility against a background. It is not a
 * measure of whether two adjacent color patches are distinguishable — purple
 * beside teal scores 1.05:1 by WCAG while being obviously different colors.
 * See the issue #40 design spec for the measurements.
 *
 * Roughly: 0 identical, ~1 a just-noticeable difference, >10 clearly distinct.
 */
export function colorDistance(a: string, b: string): number {
  const [l1, a1, b1] = hexToLab(normalizeColor(a));
  const [l2, a2, b2] = hexToLab(normalizeColor(b));

  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));

  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * DEG + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * DEG + 360) % 360;

  const dLp = l2 - l1;
  const dCp = c2p - c1p;

  // Hue difference wraps at 0/360; chroma of zero means hue is undefined.
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp * RAD) / 2);

  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;

  let hBarP: number;
  if (c1p * c2p === 0) {
    hBarP = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hBarP = (h1p + h2p) / 2;
  } else {
    hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * RAD) +
    0.24 * Math.cos(2 * hBarP * RAD) +
    0.32 * Math.cos((3 * hBarP + 6) * RAD) -
    0.2 * Math.cos((4 * hBarP - 63) * RAD);

  const sL = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;

  const dTheta = 30 * Math.exp(-Math.pow((hBarP - 275) / 25, 2));
  const rC = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const rT = -Math.sin(2 * dTheta * RAD) * rC;

  return Math.sqrt(
    Math.pow(dLp / sL, 2) +
      Math.pow(dCp / sC, 2) +
      Math.pow(dHp / sH, 2) +
      rT * (dCp / sC) * (dHp / sH),
  );
}
