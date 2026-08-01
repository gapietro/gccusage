import * as path from "node:path";
import type { Widget, WidgetOutput } from "./base.js";
import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

/**
 * The current project's name, from `workspace.project_dir` — the repo root.
 *
 * Deliberately never reads `stdin.cwd`: cwd is wherever the shell happened to
 * be when Claude Code started, so its basename names a subdirectory whenever
 * the session did not start at the root (#59). When `project_dir` is absent
 * this declines rather than falling back to cwd, because that fallback is
 * silently wrong in exactly the case the widget exists to handle.
 *
 * Two checkouts of the same repo still render identically; that is a known
 * limit of any basename, recorded in the #48 design doc.
 */
export const projectWidget: Widget = {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null {
    const projectDir = context.stdin.workspace?.project_dir;
    if (!projectDir) return null;

    // Strip trailing separators so "/x/y/" and "/x/y" behave identically,
    // including for the HOME comparison below; keep a lone "/" intact.
    const dir = projectDir.replace(/\/+$/, "") || "/";

    const home = process.env["HOME"];
    // path.basename("/") is "", the only case that can be empty here.
    const name = dir === home ? "~" : path.basename(dir) || "/";

    const label = config.label ?? "";
    const text = label ? `${label} ${name}` : name;
    return { text, fg: config.fg, bg: config.bg, shrinkable: true };
  },
};
