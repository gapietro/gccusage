import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { getHomeDir } from "../utils/paths.js";
import {
  formatConfigError,
  formatStdinError,
  formatStdinReadError,
  formatStdinTimeout,
} from "../config/error-line.js";

const CONFIG = "/home/u/.config/gccusage/settings.json";
const MESSAGE = "lines.0.widgets.2.bg: must be a color name or #rgb/#rrggbb hex (got \"196\")";

describe("formatConfigError", () => {
  const originalHome = process.env["HOME"];

  afterEach(() => {
    process.env["HOME"] = originalHome;
  });

  it("is a single line with no trailing newline", () => {
    const line = formatConfigError(MESSAGE, CONFIG);
    expect(line).not.toContain("\n");
  });

  it("opens with a bold-red marker so it cannot be mistaken for a segment", () => {
    const line = formatConfigError(MESSAGE, CONFIG);
    expect(line.startsWith("[1;31m⚠ gccusage config[0m")).toBe(true);
  });

  it("includes the message verbatim", () => {
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(MESSAGE);
  });

  it("collapses $HOME to ~ so the line stays short", () => {
    process.env["HOME"] = "/home/u";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain("~/.config/gccusage/settings.json");
  });

  it("leaves a path outside $HOME alone", () => {
    process.env["HOME"] = "/home/other";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });

  it("does not collapse when HOME is / (every path starts with it)", () => {
    process.env["HOME"] = "/";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });

  it("survives HOME being unset", () => {
    delete process.env["HOME"];
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });

  // SEC-004. The path shown is getConfigPath(), which resolves home through
  // getHomeDir() — the passwd entry when HOME is unset or empty. Shortening
  // against raw $HOME instead left that path unshortened, and in the old
  // `HOME || "~"` world the two disagreed about where home even was.
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("collapses the resolved home directory when HOME is %s", (_label, home) => {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;
    const resolvedHome = getHomeDir();
    const configPath = path.join(resolvedHome, ".config", "gccusage", "settings.json");

    expect(formatConfigError(MESSAGE, configPath)).toContain(
      `~${path.sep}.config${path.sep}gccusage${path.sep}settings.json`,
    );
  });
});

describe("formatStdinTimeout", () => {
  it("is a single line with no trailing newline", () => {
    expect(formatStdinTimeout(5000)).not.toContain("\n");
  });

  it("opens with the same bold-red marker as the other error lines", () => {
    expect(formatStdinTimeout(5000).startsWith("\x1b[1;31m⚠ gccusage\x1b[0m")).toBe(true);
  });

  it("names the deadline that was actually applied", () => {
    // Rendered from the argument, never hardcoded: a test driving the bundle
    // at 200ms must not read a line claiming "within 5s", or the assertion
    // pins a lie.
    expect(formatStdinTimeout(5000)).toContain("within 5s");
    expect(formatStdinTimeout(200)).toContain("within 200ms");
    expect(formatStdinTimeout(7500)).toContain("within 7.5s");
  });

  it("never renders a sub-second deadline as 0s", () => {
    // utils/format.ts's formatDuration floors to whole seconds and turns 200
    // into "0s", which is why this has its own formatter.
    expect(formatStdinTimeout(200)).not.toContain("0s");
  });
});

// TEST-003: these two were never executed. index-entry.test.ts mocks them to
// observe the call, and nothing else imported them, so a formatter that threw
// or emitted a newline would have brought REL-004's bar erasure back with the
// suite green. The prefix is asserted through the reset, not just `⚠ gccusage`:
// the config line's `⚠ gccusage config` starts with that too.
describe.each([
  ["formatStdinError", formatStdinError, "stdin is not valid JSON"],
  ["formatStdinReadError", formatStdinReadError, "read EIO"],
])("%s", (_name, format, message) => {
  it("is a non-empty single line with no trailing newline", () => {
    const line = format(message);
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });

  it("opens with the same bold-red marker as the other error lines", () => {
    expect(format(message).startsWith("\x1b[1;31m⚠ gccusage\x1b[0m")).toBe(true);
  });

  it("includes the message verbatim", () => {
    expect(format(message)).toContain(message);
  });
});
