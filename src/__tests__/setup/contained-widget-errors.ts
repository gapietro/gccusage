import { beforeEach, afterEach } from "vitest";
import {
  CONTAINED_WIDGET_ERROR_HOOK,
  type ContainedWidgetErrorListener,
} from "../../render/contained-error-hook.js";
import { CONTAINED_ERRORS_ALLOWED } from "../helpers/contained-widget-errors.js";

/**
 * Fails any test during which the renderer contained a widget throw, unless
 * the test called `allowContainedWidgetErrors()` (REL-007, review of #154).
 *
 * Containment keeps one bad widget from erasing the bar, but it also turns a
 * crash into a missing segment, and a test asserting only that a segment is
 * absent cannot tell the two apart. This puts the crash back in front of the
 * suite for in-process renders. Bundle-spawning tests run in another process
 * and need `GCCUSAGE_DEBUG=1` plus a stderr check instead.
 *
 * Registered through `setupFiles` in vitest.config.ts. State lives on
 * `globalThis` (see contained-error-hook.ts), so `vi.resetModules()` in a test
 * cannot detach it.
 */
const globals = globalThis as Record<symbol, unknown>;
let contained: string[] = [];

beforeEach(() => {
  contained = [];
  globals[CONTAINED_ERRORS_ALLOWED] = false;
  const listener: ContainedWidgetErrorListener = (widgetType, error) => {
    contained.push(`${widgetType}: ${error instanceof Error ? error.message : String(error)}`);
  };
  globals[CONTAINED_WIDGET_ERROR_HOOK] = listener;
});

afterEach(() => {
  delete globals[CONTAINED_WIDGET_ERROR_HOOK];
  const allowed = globals[CONTAINED_ERRORS_ALLOWED] === true;
  delete globals[CONTAINED_ERRORS_ALLOWED];
  if (!allowed && contained.length > 0) {
    throw new Error(
      `the renderer contained ${contained.length} widget throw(s) during this test — ` +
        `a crash the bar hid as a missing segment:\n  ${contained.join("\n  ")}\n` +
        "If the test means to exercise containment, call allowContainedWidgetErrors().",
    );
  }
});
