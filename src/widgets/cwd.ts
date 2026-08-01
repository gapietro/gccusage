import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { getHomeDir } from "../utils/paths.js";

export const cwdWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    let cwd = context.stdin.cwd;
    if (!cwd) return null;

    // Replace home dir with ~. Via getHomeDir() rather than process.env.HOME
    // (#69) so an unset or empty HOME still abbreviates, the same resolution
    // the rest of the codebase uses; it always returns an absolute path.
    const home = getHomeDir();
    if (cwd.startsWith(home)) {
      cwd = "~" + cwd.slice(home.length);
    }

    const label = config.label ?? "";
    const text = label ? `${label} ${cwd}` : cwd;
    return { text, fg: config.fg, bg: config.bg };
  },
};
