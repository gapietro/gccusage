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
    const settings = loadSettings();
    expect(settings.lines).toEqual(DEFAULT_SETTINGS.lines);
    expect(settings.powerline?.theme).toBe("default");
  });

  it("merges partial powerline config with defaults", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "ocean" } }),
    );

    const settings = loadSettings();
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

    const settings = loadSettings();
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

    const settings = loadSettings();
    expect(settings.lines).toEqual(customLines);
  });

  it("returns defaults on invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");

    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("allows theme-only config file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "sunset" } }),
    );

    const settings = loadSettings();
    expect(settings.powerline?.theme).toBe("sunset");
    expect(settings.lines.length).toBe(2);
  });
});
