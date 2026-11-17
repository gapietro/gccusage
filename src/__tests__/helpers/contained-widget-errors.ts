/**
 * Opt-in for tests that deliberately make a widget throw, so the suite-wide
 * check in `setup/contained-widget-errors.ts` does not fail them (REL-007).
 * Reset before every test, so it never leaks into the next one.
 */
export const CONTAINED_ERRORS_ALLOWED = Symbol.for("gccusage.test.containedWidgetErrorsAllowed");

export function allowContainedWidgetErrors(): void {
  (globalThis as Record<symbol, unknown>)[CONTAINED_ERRORS_ALLOWED] = true;
}
