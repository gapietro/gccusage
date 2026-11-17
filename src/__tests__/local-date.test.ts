import { describe, it, expect } from "vitest";
import { localDateKey } from "../utils/local-date.js";

/**
 * The tests that seed a daily store import `localDateKey` rather than each
 * restating the format (MAINT-003). That makes them agree with production by
 * construction, so the format itself is pinned here, once.
 */
describe("localDateKey", () => {
  it("formats YYYY-MM-DD with zero-padded month and day", () => {
    expect(localDateKey(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 10, 16, 12))).toBe("2026-11-16");
  });

  // Local, not UTC, to match `isEntryFromToday`'s local midnight. Off UTC, one
  // of these two instants falls on a different UTC date, so a UTC key would
  // fail one of them in any zone; on a UTC machine both pass either way.
  it("keys on the local calendar date at both ends of the day", () => {
    expect(localDateKey(new Date(2026, 11, 31, 0, 30))).toBe("2026-12-31");
    expect(localDateKey(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
  });
});
