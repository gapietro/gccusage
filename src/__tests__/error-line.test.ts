import { describe, it, expect, afterEach } from "vitest";
import { formatConfigError } from "../config/error-line.js";

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
