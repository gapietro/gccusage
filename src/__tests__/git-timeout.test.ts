import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getGitChanges, resolveGitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS } from "../utils/git.js";
import { makeDeterministicGitRepo } from "./fixtures/git-repo-fixture.js";

/**
 * #146. `GCCUSAGE_GIT_TIMEOUT_MS` replaces the hardcoded 2000ms `execSync`
 * deadline on the render-time git calls, so tests that assert on real git
 * output can stop racing the production budget under suite load.
 */
const ENV = "GCCUSAGE_GIT_TIMEOUT_MS";
const saved = process.env[ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe("resolveGitTimeoutMs (#146)", () => {
  it("defaults to 2000ms when unset", () => {
    delete process.env[ENV];
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(2000);
    expect(resolveGitTimeoutMs()).toBe(2000);
  });

  it.each([
    ["5000", 5000],
    ["1", 1],
    ["2147483647", 2_147_483_647],
  ])("honours a valid override %j, both bounds included", (raw, expected) => {
    process.env[ENV] = raw;
    expect(resolveGitTimeoutMs()).toBe(expected);
  });

  // Each rejected value is one `execSync` mishandles, measured on Node 26:
  // 0 means NO deadline (a hung git would hold the bar for Claude Code's 600s
  // wait), and NaN, negative, fractional and 1e300 throw ERR_OUT_OF_RANGE
  // synchronously, which `exec()`'s catch would turn into BOTH git widgets
  // vanishing on every render. The ceiling matches GCCUSAGE_STDIN_TIMEOUT_MS.
  it.each(["", "   ", "abc", "0", "-5", "1.5", "1e300", "Infinity", "2147483648"])(
    "falls back to the default for %j",
    (raw) => {
      process.env[ENV] = raw;
      expect(resolveGitTimeoutMs()).toBe(2000);
    },
  );
});

describe("getGitChanges honours GCCUSAGE_GIT_TIMEOUT_MS (#146)", () => {
  // A `git` that answers 300ms late, first on PATH. Installed only after the
  // repo is built, so the fixture's own git calls are not slowed.
  let repoDir: string;
  let shimDir: string;
  const savedPath = process.env["PATH"];

  beforeAll(() => {
    repoDir = makeDeterministicGitRepo();
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    shimDir = mkdtempSync(path.join(tmpdir(), "gccusage-slow-git-"));
    const shim = path.join(shimDir, "git");
    writeFileSync(shim, `#!/bin/sh\nsleep 0.3\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    process.env["PATH"] = `${shimDir}${path.delimiter}${savedPath}`;
  });

  afterAll(() => {
    process.env["PATH"] = savedPath;
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("gives up on git that outlives a short override", () => {
    process.env[ENV] = "100";
    expect(getGitChanges(repoDir)).toBeNull();
  });

  it("waits for git within a longer override (control)", () => {
    process.env[ENV] = "5000";
    expect(getGitChanges(repoDir)).toEqual({ added: 2, modified: 0, deleted: 0 });
  });
});
