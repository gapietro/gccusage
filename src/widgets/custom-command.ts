import { execSync } from "node:child_process";
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export const customCommandWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const command = config.command;
    if (!command) return null;

    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 2000,
        cwd: context.stdin.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (!output) return null;

      // Take only first line
      const text = output.split("\n")[0] ?? "";
      return { text, fg: config.fg, bg: config.bg };
    } catch {
      return null;
    }
  },
};
