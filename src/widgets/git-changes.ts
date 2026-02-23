import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { getGitChanges } from "../utils/git.js";

export const gitChangesWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const changes = getGitChanges(context.stdin.cwd);
    if (!changes) return null;
    if (changes.added === 0 && changes.modified === 0 && changes.deleted === 0) return null;

    const parts: string[] = [];
    if (changes.added > 0) parts.push(`+${changes.added}`);
    if (changes.modified > 0) parts.push(`~${changes.modified}`);
    if (changes.deleted > 0) parts.push(`-${changes.deleted}`);

    const label = config.label ?? "";
    const text = label ? `${label} ${parts.join(" ")}` : parts.join(" ");
    return { text, fg: config.fg, bg: config.bg };
  },
};
