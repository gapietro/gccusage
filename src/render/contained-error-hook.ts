/**
 * A test seam for widget throws the renderer contains (REL-007, review of #154).
 *
 * Containing a throw is right for users — one bad segment must not erase the
 * bar — but it also makes the throw invisible to a test that only asserts a
 * segment is ABSENT: "renders no burn rate" passes just the same whether the
 * widget returned null on purpose or crashed. The test setup file
 * (`src/__tests__/setup/contained-widget-errors.ts`) installs a listener here
 * before every test and fails any test where it fired, unless that test
 * opted in.
 *
 * Keyed on `globalThis` with a registered symbol rather than held in module
 * state, so a test that calls `vi.resetModules()` and re-imports the renderer
 * still reports to the same listener. This module imports nothing, so the
 * setup file can load it without pulling the renderer's dependency graph in
 * ahead of any test file's `vi.mock`.
 *
 * In production nothing is installed and the call is a no-op.
 */
export const CONTAINED_WIDGET_ERROR_HOOK = Symbol.for("gccusage.containedWidgetError");

export type ContainedWidgetErrorListener = (widgetType: string, error: unknown) => void;

export function reportContainedWidgetError(widgetType: string, error: unknown): void {
  const listener = (globalThis as Record<symbol, unknown>)[CONTAINED_WIDGET_ERROR_HOOK];
  if (typeof listener === "function") (listener as ContainedWidgetErrorListener)(widgetType, error);
}
