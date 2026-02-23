import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export interface WidgetOutput {
  text: string;
  fg?: string;
  bg?: string;
}

export interface Widget {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null;
}
