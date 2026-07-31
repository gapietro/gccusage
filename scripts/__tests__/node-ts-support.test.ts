import { describe, it, expect } from "vitest";
import { supportsTypeScript, nodeRunsTypeScript } from "./node-ts-support.ts";

describe("supportsTypeScript", () => {
  it("reports support when Node names a stripping mode", () => {
    expect(supportsTypeScript("strip")).toBe(true);
    expect(supportsTypeScript("transform")).toBe(true);
  });

  it("reports no support when stripping is explicitly disabled", () => {
    expect(supportsTypeScript(false)).toBe(false);
  });

  it("reports no support on Node that predates the feature flag", () => {
    // The property is absent below the Node version that introduced it, and
    // every such Node fails to parse a .ts file. Reading `undefined` as
    // support is the bug this asserts against: it would run the spawning
    // tests on exactly the versions that cannot survive them.
    expect(supportsTypeScript(undefined as unknown as typeof process.features.typescript)).toBe(
      false,
    );
  });
});

describe("nodeRunsTypeScript", () => {
  it("agrees with this runtime's actual behaviour", () => {
    // Self-consistency: the flag must match whether Node really did strip
    // types, which it demonstrably did — this test file is TypeScript.
    expect(nodeRunsTypeScript).toBe(typeof process.features.typescript === "string");
  });
});
