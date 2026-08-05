import type { Settings } from "./schema.js";

/**
 * Whether `type` appears anywhere in the resolved layout.
 *
 * Deliberately coarse: it asks whether the widget is *configured*, not whether
 * it survives the shrink pass at render time. A widget dropped for width still
 * counts. Over-counting in that edge is acceptable — the point is to charge
 * nothing to the users who never configured the widget at all.
 *
 * `lines` is always present after the loader merge (`loader.ts:40`), so there
 * is no optional handling here.
 */
export function layoutIncludesWidget(settings: Settings, type: string): boolean {
  return settings.lines.some((line) => line.widgets.some((w) => w.type === type));
}
