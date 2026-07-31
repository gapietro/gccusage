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
 * untouched so the caller's own parsing (chalk's, or `colorize`'s
 * `startsWith("#")` guard) still applies.
 */
export function resolveColor(color: string): string {
  return NAMED_COLORS[color.toLowerCase()] ?? color;
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
