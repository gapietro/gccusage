import { describe, it, expect, afterEach } from "vitest";
import { formatConfigError, formatStdinTimeout } from "../config/error-line.js";

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
