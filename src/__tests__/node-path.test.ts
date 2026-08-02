import { describe, it, expect } from "vitest";
import {
  versionSegment,
  resolveStableNodePath,
  type NodePathProbe,
} from "../utils/node-path.js";

const CELLAR = "/opt/homebrew/Cellar/node/26.5.0_1/bin/node";

/** A probe backed by a fixed symlink table; realpath throws for absent paths. */
function probe(
  execPath: string,
  links: Record<string, string>,
  pathEntries: string[],
): NodePathProbe {
  return {
    execPath,
    pathEntries,
    realpath: (p: string) => {
      const resolved = links[p];
      if (resolved === undefined) throw new Error(`ENOENT: ${p}`);
      return resolved;
    },
  };
}

describe("versionSegment", () => {
  it.each([
    [CELLAR, "26.5.0_1"],
    ["/opt/homebrew/Cellar/node@22/22.1.0/bin/node", "22.1.0"],
    ["/Users/x/.nvm/versions/node/v22.1.0/bin/node", "v22.1.0"],
    ["/Users/x/.nodenv/versions/22.1.0/bin/node", "22.1.0"],
    ["/Users/x/.volta/tools/image/node/22.1.0/bin/node", "22.1.0"],
  ])("finds the expiring segment in %s", (input, expected) => {
    expect(versionSegment(input)).toBe(expected);
  });

  it.each([
    "/usr/bin/node",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    // Homebrew's per-major symlink is stable: brew re-points it on upgrade.
    "/opt/homebrew/opt/node@22/bin/node",
  ])("finds none in %s", (input) => {
    expect(versionSegment(input)).toBeNull();
  });
});

describe("resolveStableNodePath", () => {
  // The #90 regression test: process.execPath reports the Cellar path because
  // Node resolves symlinks, and brew upgrade deletes exactly that directory.
  it("prefers the Homebrew symlink over the Cellar path execPath reports", () => {
    const result = resolveStableNodePath(
      probe(
        CELLAR,
        { [CELLAR]: CELLAR, "/opt/homebrew/bin/node": CELLAR },
        ["/opt/homebrew/bin", "/usr/bin"],
      ),
    );

    expect(result).toEqual({ path: "/opt/homebrew/bin/node" });
  });

  it("keeps execPath and warns when every candidate is version-scoped", () => {
    const NVM = "/Users/x/.nvm/versions/node/v22.1.0/bin/node";

    const result = resolveStableNodePath(
      probe(NVM, { [NVM]: NVM }, ["/Users/x/.nvm/versions/node/v22.1.0/bin", "/usr/bin"]),
    );

    expect(result.path).toBe(NVM);
    expect(result.warning).toContain("v22.1.0");
  });

  it("returns an already-stable execPath without probing PATH at all", () => {
    const result = resolveStableNodePath({
      execPath: "/usr/bin/node",
      pathEntries: ["/usr/bin", "/opt/homebrew/bin"],
      realpath: () => {
        throw new Error("realpath must not be called for a stable execPath");
      },
    });

    expect(result).toEqual({ path: "/usr/bin/node" });
  });

  it("ignores a PATH entry that resolves to a different binary", () => {
    const result = resolveStableNodePath(
      probe(
        CELLAR,
        { [CELLAR]: CELLAR, "/usr/local/bin/node": "/usr/local/Cellar/node/18.0.0/bin/node" },
        ["/usr/local/bin"],
      ),
    );

    expect(result.path).toBe(CELLAR);
    expect(result.warning).toContain("26.5.0_1");
  });

  it("warns when the running binary can no longer be resolved", () => {
    // realpath(execPath) throws: there is nothing to compare candidates
    // against, so guessing at a replacement would be worse than saying so.
    const result = resolveStableNodePath(
      probe(CELLAR, { "/opt/homebrew/bin/node": CELLAR }, ["/opt/homebrew/bin"]),
    );

    expect(result.path).toBe(CELLAR);
    expect(result.warning).toContain("26.5.0_1");
  });
});
