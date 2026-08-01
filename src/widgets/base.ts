import type { RenderContext } from "../types/render-context.js";
import type { WidgetConfig } from "../config/schema.js";

export interface WidgetOutput {
  text: string;
  fg?: string;
  bg?: string;
  /**
   * May this segment's text be trimmed from the right when the line would not
   * otherwise fit? Only set it on widgets whose variable-length part is the
   * SUFFIX of `text`: `project` renders `label + name` and `git-branch` renders
   * `icon + label + branch`, so right-trimming cannot eat a label or icon.
   * Re-check that before setting it on any new widget.
   */
  shrinkable?: boolean;
}

export interface Widget {
  render(context: RenderContext, config: WidgetConfig): WidgetOutput | null;
}
