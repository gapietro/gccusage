import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { getGitBranch } from "../utils/git.js";

export const gitBranchWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const branch = getGitBranch(context.stdin.cwd);
    if (!branch) return null;

    const icon = config.icon ?? ""; // No icon by default (powerline branch icon requires Nerd Font)
    const label = config.label ?? "";
    const prefix = [icon, label].filter(Boolean).join(" ");
    const text = prefix ? `${prefix} ${branch}` : branch;
    return { text, fg: config.fg, bg: config.bg };
  },
};
