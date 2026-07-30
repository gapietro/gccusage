import { describe, it, expect } from "vitest";
import { shellQuote, buildStatusLineCommand } from "../cli.js";

describe("shellQuote", () => {
  it("wraps plain paths in single quotes", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("'/usr/local/bin/node'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/Users/o'brien/dist/index.js")).toBe(
      "'/Users/o'\\''brien/dist/index.js'",
    );
  });
});

describe("buildStatusLineCommand", () => {
  it("quotes both the node executable and the script path", () => {
    const cmd = buildStatusLineCommand(
      "/usr/local/bin/node",
      "/Users/dev/Developer Projects/gccusage/dist/index.js",
    );
    expect(cmd).toBe(
      "'/usr/local/bin/node' '/Users/dev/Developer Projects/gccusage/dist/index.js'",
    );
  });
});
