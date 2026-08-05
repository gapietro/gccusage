import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BADGE_END,
  BADGE_START,
  REPO_SLUG,
  renderBadges,
  shieldsEscape,
} from "../lib/build-badge.ts";
import { nodeRunsTypeScript } from "./node-ts-support.ts";

const readme = (badges: string): string =>
  ["# gccusage", "", BADGE_START, badges, BADGE_END, "", "A statusline.", ""].join("\n");

describe("shieldsEscape", () => {
  it("doubles dashes and underscores so shields renders them literally", () => {
    expect(shieldsEscape("1.0.0-rc1")).toBe("1.0.0--rc1");
    expect(shieldsEscape("1.0.0")).toBe("1.0.0");
    expect(shieldsEscape("a_b")).toBe("a__b");
    expect(shieldsEscape("two words")).toBe("two_words");
  });
});

describe("renderBadges", () => {
  it("writes the version badge and the CI badge between the markers", () => {
    const result = renderBadges(readme("![build](old)"), { version: "1.0.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readme).toContain("https://img.shields.io/badge/version-1.0.0-blue");
    expect(result.readme).toContain(
      `https://github.com/${REPO_SLUG}/actions/workflows/ci.yml/badge.svg?branch=main`,
    );
    // The retired build counter must not come back with it.
    expect(result.readme).not.toContain("![build](old)");
    expect(result.readme).not.toContain("badge/build-");
  });

  it("links the CI badge to the run history rather than leaving it inert", () => {
    const result = renderBadges(readme(""), { version: "1.0.0" });
    // A bare `![ci](…badge.svg)` renders but goes nowhere, which is the whole
    // point of showing build state — the reader has to be able to click into
    // the failing run.
    expect(result.ok && result.readme).toContain(
      `](https://github.com/${REPO_SLUG}/actions/workflows/ci.yml)`,
    );
  });

  it("is idempotent — a second run with the same version changes nothing", () => {
    const once = renderBadges(readme("stale"), { version: "1.0.0" });
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = renderBadges(once.readme, { version: "1.0.0" });
    expect(twice.ok && twice.readme).toBe(once.readme);
  });

  it("leaves everything outside the markers untouched", () => {
    const result = renderBadges(readme("![build](old)"), { version: "1.0.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readme.startsWith("# gccusage\n")).toBe(true);
    expect(result.readme.endsWith("A statusline.\n")).toBe(true);
  });

  it("escapes a version that would otherwise break the shields path", () => {
    const result = renderBadges(readme(""), { version: "1.0.0-rc1" });
    expect(result.ok && result.readme).toContain("badge/version-1.0.0--rc1-blue");
  });

  it("fails loudly when a marker is missing rather than appending", () => {
    for (const broken of [
      "# gccusage\n\nno markers at all\n",
      `# gccusage\n\n${BADGE_START}\n![x](y)\n`,
      `# gccusage\n\n![x](y)\n${BADGE_END}\n`,
      `# gccusage\n\n${BADGE_END}\n![x](y)\n${BADGE_START}\n`,
    ]) {
      const result = renderBadges(broken, { version: "1.0.0" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("badges:");
    }
  });
});

describe.skipIf(!nodeRunsTypeScript)("build-badge entry point", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-badge-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(dir, "README.md"), readme("stale"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (): string =>
    execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "build-badge.ts")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GCCUSAGE_BADGE_ROOT: dir },
    });

  it("stamps the version from package.json and writes no state file", () => {
    run();
    const after = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(after).toContain("badge/version-1.2.3-blue");
    expect(after).toContain("actions/workflows/ci.yml/badge.svg");
    // The retired counter's state file must not be recreated: it only existed
    // to feed a workflow that can no longer push to a protected main.
    expect(fs.existsSync(path.join(dir, ".github", "build-number.json"))).toBe(false);
  });

  it("is idempotent across runs, so re-stamping produces no diff", () => {
    run();
    const first = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    run();
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe(first);
  });

  it("exits non-zero and leaves the README alone when it has no markers", () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# gccusage\n\nno markers\n");
    expect(() => run()).toThrow();
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# gccusage\n\nno markers\n");
  });
});
