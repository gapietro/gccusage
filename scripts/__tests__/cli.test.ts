import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, resolveProjectsDir } from "../lib/cli.ts";
import { defaultProjectsDir } from "../lib/discover.ts";
import { nodeRunsTypeScript } from "./node-ts-support.ts";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cli-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("defaults to markdown against the default projects directory", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ ok: true, options: { projectsDir: undefined, json: false } });
  });

  it("accepts --json", () => {
    const result = parseArgs(["--json"]);
    expect(result.ok && result.options.json).toBe(true);
  });

  it("accepts --projects-dir with a real directory, in both spellings", () => {
    expect(parseArgs(["--projects-dir", dir])).toEqual({
      ok: true,
      options: { projectsDir: dir, json: false },
    });
    expect(parseArgs([`--projects-dir=${dir}`, "--json"])).toEqual({
      ok: true,
      options: { projectsDir: dir, json: true },
    });
  });

  it("rejects a --projects-dir value that is itself a flag", () => {
    const result = parseArgs(["--projects-dir", "--json"]);
    expect(result).toEqual({ ok: false, error: "--projects-dir requires a path" });
  });

  it("rejects a missing --projects-dir value", () => {
    expect(parseArgs(["--projects-dir"]).ok).toBe(false);
    expect(parseArgs(["--projects-dir="]).ok).toBe(false);
  });

  it("rejects an unrecognised flag rather than silently scanning $HOME", () => {
    const result = parseArgs(["--projekts-dir", dir, "--json"]);
    expect(result).toEqual({ ok: false, error: "unrecognised argument: --projekts-dir" });
  });

  it("rejects a bare positional argument", () => {
    expect(parseArgs([dir])).toEqual({ ok: false, error: `unrecognised argument: ${dir}` });
  });

  it("rejects a projects directory that does not exist or is not a directory", () => {
    const missing = path.join(dir, "nowhere");
    expect(parseArgs(["--projects-dir", missing]).ok).toBe(false);

    const file = path.join(dir, "a-file");
    fs.writeFileSync(file, "");
    const result = parseArgs(["--projects-dir", file]);
    expect(result).toEqual({ ok: false, error: `--projects-dir: not a directory: ${file}` });
  });
});

// Spawns the real entry point, so it needs a Node that runs .ts directly.
describe.skipIf(!nodeRunsTypeScript)("analyze-transcripts CLI", () => {
  function run(args: string[]): { status: number; stderr: string; stdout: string } {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["scripts/analyze-transcripts.ts", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, stderr: "", stdout };
    } catch (error) {
      const e = error as { status: number; stderr: string; stdout: string };
      return { status: e.status, stderr: e.stderr, stdout: e.stdout };
    }
  }

  it("exits non-zero on a bad --projects-dir value instead of reporting zeros", () => {
    const result = run(["--projects-dir", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--projects-dir requires a path");
    expect(result.stdout).toBe("");
  });

  it("exits non-zero on a misspelled flag instead of scanning the real corpus", () => {
    const result = run(["--projekts-dir", "/nowhere", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unrecognised argument: --projekts-dir");
    expect(result.stdout).toBe("");
  });
});

describe("resolveProjectsDir", () => {
  it("passes an explicit directory straight through", () => {
    const result = resolveProjectsDir({ projectsDir: dir, json: false }, () => "/unused");
    expect(result).toEqual({ ok: true, dir });
  });

  it("accepts a default directory that exists", () => {
    const result = resolveProjectsDir({ projectsDir: undefined, json: false }, () => dir);
    expect(result).toEqual({ ok: true, dir });
  });

  it("rejects a missing default instead of reporting an empty corpus", () => {
    // The dangerous case: before this check, an unresolvable home directory
    // produced a full all-zero report at exit 0, which reads as "your corpus
    // is empty" rather than "I could not find your corpus".
    const missing = path.join(dir, "not-there");
    const result = resolveProjectsDir({ projectsDir: undefined, json: false }, () => missing);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("default projects directory");
    expect(result.error).toContain("--projects-dir");
  });

  it("rejects a relative default, which is what an unset HOME used to produce", () => {
    const result = resolveProjectsDir(
      { projectsDir: undefined, json: false },
      () => path.join(".claude", "projects"),
    );
    expect(result.ok).toBe(false);
  });
});

describe("defaultProjectsDir", () => {
  it("is absolute, so it cannot resolve against the current directory", () => {
    expect(path.isAbsolute(defaultProjectsDir())).toBe(true);
    expect(defaultProjectsDir().endsWith(path.join(".claude", "projects"))).toBe(true);
  });
});
