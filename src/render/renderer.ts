import type { RenderContext } from "../types/render-context.js";
import type { Settings } from "../config/schema.js";
import type { WidgetOutput } from "../widgets/base.js";
import { getWidget } from "../widgets/registry.js";
import { colorize } from "./colors.js";
import { renderPowerlineSegments } from "./powerline.js";
import { applyFlex, type FlexMode } from "./flex.js";
import { truncateAnsi } from "./truncation.js";

export function renderStatusline(context: RenderContext, settings: Settings): string {
  const lines: string[] = [];
  const powerline = settings.powerline;
  const isPowerline = powerline?.enabled ?? false;

  for (const lineConfig of settings.lines) {
    const outputs: WidgetOutput[] = [];

    for (const widgetConfig of lineConfig.widgets) {
      const widget = getWidget(widgetConfig.type);
      if (!widget) continue;

      const output = widget.render(context, widgetConfig);
      if (!output) continue;

      outputs.push(output);
    }

    // Filter out leading/trailing separators and consecutive separators
    const cleaned = cleanSeparators(outputs);

    if (cleaned.length === 0) continue;

    let line: string;
    if (isPowerline && powerline) {
      // In Powerline mode, separators are handled by the renderer
      const nonSeparator = cleaned.filter(
        (o) => o.text !== " | " && o.text.trim() !== "|",
      );
      line = renderPowerlineSegments(nonSeparator, {
        theme: powerline.theme ?? "default",
        separator: powerline.separator ?? "\uE0B0",
        separatorThin: powerline.separatorThin ?? "\uE0B1",
      });
    } else {
      // Standard mode: colorize each widget
      const segments = cleaned.map((o) => colorize(o.text, o.fg, o.bg));
      const flex = (lineConfig.flex ?? "left") as FlexMode;
      line = applyFlex(segments, context.terminalWidth, flex);
    }

    // Truncate to terminal width
    line = truncateAnsi(line, context.terminalWidth);
    lines.push(line);
  }

  return lines.join("\n");
}

function cleanSeparators(outputs: WidgetOutput[]): WidgetOutput[] {
  const result: WidgetOutput[] = [];
  let lastWasSeparator = true; // treat start as "separator" to skip leading

  for (const output of outputs) {
    const isSep = isSeparatorOutput(output);
    if (isSep && lastWasSeparator) continue; // skip consecutive or leading
    result.push(output);
    lastWasSeparator = isSep;
  }

  // Remove trailing separator
  while (result.length > 0 && isSeparatorOutput(result[result.length - 1]!)) {
    result.pop();
  }

  return result;
}

function isSeparatorOutput(output: WidgetOutput): boolean {
  const text = output.text.trim();
  return text === "|" || text === "│" || text === "" || output.text === " | ";
}
