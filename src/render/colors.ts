import chalk from "chalk";

export const NAMED_COLORS: Record<string, string> = {
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  white: "#ffffff",
  black: "#000000",
  gray: "#808080",
  grey: "#808080",
  orange: "#ff8800",
  pink: "#ff69b4",
};

/**
 * Substitute a known color name with its hex value; pass anything else through
 * untouched (trimmed) so the caller's own parsing (chalk's, or `colorize`'s
 * `startsWith("#")` guard) still applies.
 *
 * Uses `Object.hasOwn` rather than `NAMED_COLORS[key] ?? color` because
 * `NAMED_COLORS` is a plain object literal: inherited `Object.prototype`
 * members (`constructor`, `__proto__`, `toString`, `valueOf`, ...) are truthy
 * lookups there too, so `??` never falls through for those keys and the
 * caller receives a function or `[object Object]` instead of a string. On the
 * powerline path that value flows into `colorDistance` -> `normalizeColor` ->
 * this function again, where `.toLowerCase()` on a non-string throws and
 * blanks the entire statusline (see the fix report).
 */
export function resolveColor(color: string): string {
  const trimmed = color.trim();
  const key = trimmed.toLowerCase();
  return Object.hasOwn(NAMED_COLORS, key) ? NAMED_COLORS[key]! : trimmed;
}

export function colorize(text: string, fg?: string, bg?: string): string {
  let result = chalk;

  if (fg) {
    const resolved = resolveColor(fg);
    result = result.hex(resolved.startsWith("#") ? resolved : "#808080");
  }

  if (bg) {
    const resolved = resolveColor(bg);
    result = result.bgHex(resolved.startsWith("#") ? resolved : "#000000");
  }

  return result(text);
}
