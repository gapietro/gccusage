import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { loadSettings } from "../config/loader.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

vi.mock("node:fs");

describe("loadSettings", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns defaults when no config file exists", () => {
    const { settings } = loadSettings();
    expect(settings.lines).toEqual(DEFAULT_SETTINGS.lines);
    expect(settings.powerline?.theme).toBe("default");
  });

  it("merges partial powerline config with defaults", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "ocean" } }),
    );

    const { settings } = loadSettings();
    // Theme overridden
    expect(settings.powerline?.theme).toBe("ocean");
    // Other powerline settings preserved from defaults
    expect(settings.powerline?.enabled).toBe(true);
    expect(settings.powerline?.separator).toBe("\u25B6");
    // Lines preserved from defaults
    expect(settings.lines).toEqual(DEFAULT_SETTINGS.lines);
  });

  it("merges partial cache config with defaults", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ cache: { statuslineTtlMs: 10000 } }),
    );

    const { settings } = loadSettings();
    expect(settings.cache?.statuslineTtlMs).toBe(10000);
    expect(settings.cache?.pricingTtlMs).toBe(86400000);
  });

  it("allows full line override", () => {
    const customLines = [
      { widgets: [{ type: "model" }], flex: "left" as const },
    ];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ lines: customLines }),
    );

    const { settings } = loadSettings();
    expect(settings.lines).toEqual(customLines);
  });

  it("returns defaults and reports an error on invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("invalid JSON");
  });

  it("allows theme-only config file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "sunset" } }),
    );

    const { settings } = loadSettings();
    expect(settings.powerline?.theme).toBe("sunset");
    expect(settings.lines.length).toBe(2);
  });

  it("reports no error when the config file is absent", () => {
    const { error } = loadSettings();
    expect(error).toBeUndefined();
  });

  it("reports no error for a valid config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "ocean" } }),
    );

    const { error } = loadSettings();
    expect(error).toBeUndefined();
  });

  it("reports a schema mismatch with its dot path and the received value", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ lines: "nope" }));

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("lines");
    // `received` already carries its own quotes — one pair, not two.
    expect(error).toContain('"nope"');
    expect(error).not.toContain('""nope""');
  });

  it("counts additional issues rather than listing them all", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ lines: "nope", costSource: "bogus" }),
    );

    const { error } = loadSettings();
    expect(error).toContain("(+1 more)");
  });

  it("reports an unreadable config file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("cannot read config");
    expect(error).toContain("EACCES");
  });

  // Issue #42: "196" is an ansi256 code that chalk's unanchored hex regex
  // paints as #119966. It must be rejected, not silently misparsed.
  it("rejects an ansi256 code in a widget color", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", bg: "196" }] }],
      }),
    );

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("lines.0.widgets.0.bg");
    expect(error).toContain("must be a color name or #rgb/#rrggbb hex");
    expect(error).toContain('"196"');
  });

  it("rejects a near-miss hex typo", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", fg: "#12345" }] }],
      }),
    );

    const { error } = loadSettings();
    expect(error).toContain("lines.0.widgets.0.fg");
    expect(error).toContain('"#12345"');
  });

  it("counts the second bad color rather than listing it", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [
          { widgets: [{ type: "model", bg: "196" }, { type: "cwd", bg: "grey1" }] },
        ],
      }),
    );

    const { error } = loadSettings();
    expect(error).toContain("lines.0.widgets.0.bg");
    expect(error).toContain("(+1 more)");
  });

  it("reports a root-level type mismatch without a dot-path prefix", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("3");

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("Invalid type: Expected Object but received 3");
    expect(error).not.toContain("null:");
  });

  it("accepts a named color and hex side by side", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", fg: "red", bg: "#1a5fb4" }] }],
      }),
    );

    const { settings, error } = loadSettings();
    expect(error).toBeUndefined();
    expect(settings.lines[0]?.widgets[0]?.fg).toBe("red");
  });
});
