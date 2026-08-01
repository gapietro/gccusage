import { stripAnsi, visibleLength } from "../utils/terminal.js";

export function truncateAnsi(str: string, maxWidth: number | undefined): string {
  // Unknown width: return the line untouched. Claude Code truncates on its own
  // end, so an over-long line degrades to its behaviour, whereas truncating to
  // a guessed width destroys output that would have fit.
  if (maxWidth === undefined) return str;
  if (visibleLength(str) <= maxWidth) return str;

  const plain = stripAnsi(str);
  if (plain.length <= maxWidth) return str;

  // Walk through the original string, tracking visible chars
  let visible = 0;
  let i = 0;
  const result: string[] = [];

  while (i < str.length && visible < maxWidth - 1) {
    // Check if this is an ANSI escape
    if (str[i] === "\x1b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        result.push(str.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    result.push(str[i]!);
    visible++;
    i++;
  }

  result.push("\u2026"); // ellipsis
  result.push("\x1b[0m"); // reset
  return result.join("");
}
