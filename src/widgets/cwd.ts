import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const cwdWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    let cwd = context.stdin.cwd;
    if (!cwd) return null;

    // Replace home dir with ~
    const home = process.env["HOME"];
    if (home && cwd.startsWith(home)) {
      cwd = "~" + cwd.slice(home.length);
    }

    const label = config.label ?? "";
    const text = label ? `${label} ${cwd}` : cwd;
    return { text, fg: config.fg, bg: config.bg };
  },
};
