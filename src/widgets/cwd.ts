import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";
import { collapseHome } from "../utils/paths.js";

export const cwdWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const raw = context.stdin.cwd;
    if (!raw) return null;

    // Replace home dir with ~. Via getHomeDir() (inside collapseHome) rather
    // than process.env.HOME (#69), so an unset or empty HOME still
    // abbreviates, the same resolution the rest of the codebase uses. Nothing
    // is abbreviated with no home (SEC-004), and only on a path-segment
    // boundary, so /Users/x2 is not "~2" when home is /Users/x.
    const cwd = collapseHome(raw);

    const label = config.label ?? "";
    const text = label ? `${label} ${cwd}` : cwd;
    return { text, fg: config.fg, bg: config.bg };
  },
};
