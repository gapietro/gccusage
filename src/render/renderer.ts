import type { RenderContext } from "../types/render-context.js";
import type { Settings, WidgetConfig } from "../config/schema.js";
import type { WidgetOutput } from "../widgets/base.js";
import { getWidget } from "../widgets/registry.js";
import { colorize } from "./colors.js";
import { renderPowerlineSegments } from "./powerline.js";
import { applyFlex, type FlexMode } from "./flex.js";
import { truncateAnsi } from "./truncation.js";
import { visibleLength } from "../utils/terminal.js";
import { shrinkOutputs } from "./shrink.js";

interface WidgetResult {
  output: WidgetOutput;
  priority: number;
}

function shouldCompact(settings: Settings, terminalWidth: number | undefined): boolean {
  const compact = settings.compact;
  if (!compact) return false;
  const mode = compact.mode ?? "auto";
  if (mode === "always") return true;
  if (mode === "never") return false;
  // "auto" with no measurable width: never collapse the bar on a guess.
  if (terminalWidth === undefined) return false;
  return terminalWidth < (compact.threshold ?? 80);
}

function collectWidgets(
  configs: WidgetConfig[],
  context: RenderContext,
): WidgetResult[] {
  const results: WidgetResult[] = [];
  for (const config of configs) {
    const widget = getWidget(config.type);
    if (!widget) continue;
    const output = widget.render(context, config);
    if (!output) continue;
    if (isSeparatorOutput(output)) continue;
    results.push({ output, priority: config.priority ?? 99 });
  }
  return results;
}

function renderLine(
  outputs: WidgetOutput[],
  settings: Settings,
  context: RenderContext,
  flex: FlexMode,
): string {
  const powerline = settings.powerline;
  const isPowerline = powerline?.enabled ?? false;

  // Shrink over-long segments before laying out, so a long branch name costs
  // its own tail rather than the tail of the whole line.
  //
  // The width check MUST come before the measureLine call: measureLine renders
  // through this same function with terminalWidth undefined, so an
  // unconditional call here would recurse forever. Unknown width means "leave
  // the output alone", the same rule applyFlex and truncateAnsi follow \u2014 which
  // is exactly what makes measureLine's result a true natural width.
  let laidOut = outputs;
  if (context.terminalWidth !== undefined) {
    const natural = measureLine(outputs, settings, context);
    if (natural > context.terminalWidth) {
      laidOut = shrinkOutputs(outputs, natural - context.terminalWidth);
    }
  }

  let line: string;
  if (isPowerline && powerline) {
    const nonSeparator = laidOut.filter(
      (o) => o.text !== " | " && o.text.trim() !== "|",
    );
    line = renderPowerlineSegments(nonSeparator, {
      theme: powerline.theme ?? "default",
      separator: powerline.separator ?? "\uE0B0",
      separatorThin: powerline.separatorThin ?? "\u2502",
    });
  } else {
    const segments = laidOut.map((o) => colorize(o.text, o.fg, o.bg));
    line = applyFlex(segments, context.terminalWidth, flex);
  }

  return truncateAnsi(line, context.terminalWidth);
}

export function renderStatusline(context: RenderContext, settings: Settings): string {
  if (shouldCompact(settings, context.terminalWidth)) {
    return renderCompact(context, settings);
  }
  return renderFull(context, settings);
}

/**
 * The width this line would occupy if nothing constrained it.
 *
 * Measured by rendering, not by arithmetic. `renderLine` with an unknown width
 * adds no padding and performs no truncation, so its visible length is the
 * natural width — which means this cannot disagree with the painter, because
 * it *is* the painter. The previous hand-rolled estimate charged a fixed
 * `+2 +3` per segment: wrong by 2 in powerline mode and by 5 in plain mode,
 * with nothing tying it to the layout it was predicting. See issue #67.
 */
function measureLine(
  outputs: WidgetOutput[],
  settings: Settings,
  context: RenderContext,
): number {
  return visibleLength(
    renderLine(outputs, settings, { ...context, terminalWidth: undefined }, "left"),
  );
}

function renderCompact(context: RenderContext, settings: Settings): string {
  // Collect all widgets from all lines, sort by priority
  const allWidgets: WidgetResult[] = [];
  for (const lineConfig of settings.lines) {
    allWidgets.push(...collectWidgets(lineConfig.widgets, context));
  }
  allWidgets.sort((a, b) => a.priority - b.priority);

  // Greedily add widgets until the line would exceed the terminal width
  const fitted: WidgetOutput[] = [];
  const budget = context.terminalWidth;

  for (const { output } of allWidgets) {
    const candidate = [...fitted, output];
    // Unknown budget: there is nothing to fit against, so never cut the list
    // short on a guess — same "leave it alone" rule as truncateAnsi/applyFlex.
    // `compact.mode: "always"` reaches this loop even when the width is
    // unknown, so this guard is load-bearing, not defensive filler.
    if (budget !== undefined && measureLine(candidate, settings, context) > budget && fitted.length > 0) {
      break;
    }
    fitted.push(output);
  }

  if (fitted.length === 0) return "";
  return renderLine(fitted, settings, context, "left");
}

function renderFull(context: RenderContext, settings: Settings): string {
  const lines: string[] = [];

  for (const lineConfig of settings.lines) {
    const outputs: WidgetOutput[] = [];

    for (const widgetConfig of lineConfig.widgets) {
      const widget = getWidget(widgetConfig.type);
      if (!widget) continue;

      const output = widget.render(context, widgetConfig);
      if (!output) continue;

      outputs.push(output);
    }

    const cleaned = cleanSeparators(outputs);
    if (cleaned.length === 0) continue;

    const line = renderLine(cleaned, settings, context, (lineConfig.flex ?? "left") as FlexMode);
    lines.push(line);
  }

  return lines.join("\n");
}

function cleanSeparators(outputs: WidgetOutput[]): WidgetOutput[] {
  const result: WidgetOutput[] = [];
  let lastWasSeparator = true;

  for (const output of outputs) {
    const isSep = isSeparatorOutput(output);
    if (isSep && lastWasSeparator) continue;
    result.push(output);
    lastWasSeparator = isSep;
  }

  while (result.length > 0 && isSeparatorOutput(result[result.length - 1]!)) {
    result.pop();
  }

  return result;
}

function isSeparatorOutput(output: WidgetOutput): boolean {
  const text = output.text.trim();
  return text === "|" || text === "│" || text === "" || output.text === " | ";
}
