import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "../version.js";

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = path.join(ROOT, "dist", "index.js");
const distExists = fs.existsSync(DIST);

/**
 * The manifest is read at runtime rather than imported: `rootDir` is `src`, so
 * a `../../package.json` specifier fails typecheck even though vitest would
 * resolve it happily — the same class of trap as the `.js`/`.ts` specifier
 * split between `src/` and `scripts/`.
 */
function manifestVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

describe("VERSION", () => {
  // The whole reason src/version.ts is allowed to duplicate the manifest. Bump
  // one without the other and this is red, rather than `gccusage --version`
  // confidently reporting a version that was never released.
  it("matches package.json", () => {
    expect(VERSION).toBe(manifestVersion());
  });

  it("is a plain semver triple, so a tag can be derived from it", () => {
    // `v${VERSION}` is the release tag. A pre-release suffix or a stray `v`
    // here would produce `vv1.0.0` or a tag git already holds.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe.skipIf(!distExists)("version and help flags against the shipped bundle", () => {
  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    // A throwaway HOME: `today` is the default command, and letting it read the
    // developer's real transcripts would make this test's runtime depend on the
    // machine it runs on.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-version-"));
    try {
      const r = spawnSync(process.execPath, [DIST, ...args], {
        env: { ...process.env, HOME: dir, XDG_CACHE_HOME: path.join(dir, "cache") },
        encoding: "utf8",
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every one of these exited 1 with "Unknown command" on stderr before
  // CLI-001 — the two commands a new user is most likely to type first.
  it.each(["version", "--version", "-v"])("%s prints the bare version and exits 0", (flag) => {
    const { status, stdout, stderr } = run([flag]);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    // Bare and trailing-newline-only, so `$(gccusage --version)` is the version
    // and nothing else.
    expect(stdout).toBe(`${VERSION}\n`);
  });

  it.each(["help", "--help", "-h"])("%s prints usage to stdout and exits 0", (flag) => {
    const { status, stdout, stderr } = run([flag]);

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Powerline statusline for Claude Code");
    // The help text has to name the aliases, or they are undiscoverable.
    expect(stdout).toContain("--version");
    expect(stdout).toContain("--help");
  });

  // The over-correction guard. Widening the switch to swallow anything
  // flag-shaped would make a typo silently succeed, which is strictly worse
  // than the behaviour CLI-001 fixed: `gccusage --verison` must still fail
  // loudly rather than printing help and exiting 0.
  it.each(["--verison", "-V", "--vers", "bogus"])("%s still exits 1 on stderr", (flag) => {
    const { status, stderr } = run([flag]);

    expect(status).toBe(1);
    expect(stderr).toContain(`Unknown command: ${flag}`);
  });
});
