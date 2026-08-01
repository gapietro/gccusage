import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findSessionJsonlFiles,
  getCacheDir,
  getClaudeDataDir,
  getProjectsDir,
} from "../utils/paths.js";

let tmpHome: string;
let originalHome: string | undefined;
let originalXdg: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-home-"));
  originalHome = process.env["HOME"];
  originalXdg = process.env["XDG_CACHE_HOME"];
  process.env["HOME"] = tmpHome;

  const projectDir = path.join(tmpHome, ".claude", "projects", "-some-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "session-1.jsonl"), "{}\n");
  fs.writeFileSync(path.join(projectDir, "session-2.jsonl"), "{}\n");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (originalXdg === undefined) delete process.env["XDG_CACHE_HOME"];
  else process.env["XDG_CACHE_HOME"] = originalXdg;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("home directory resolution", () => {
  it("uses HOME when it is set", () => {
    expect(getClaudeDataDir()).toBe(path.join(tmpHome, ".claude"));
  });

  it("resolves an absolute data dir when HOME is unset", () => {
    delete process.env["HOME"];
    expect(path.isAbsolute(getClaudeDataDir())).toBe(true);
  });

  it("resolves an absolute data dir when HOME is empty", () => {
    process.env["HOME"] = "";
    expect(path.isAbsolute(getClaudeDataDir())).toBe(true);
  });

  it("never resolves the data dir under a directory literally named ~", () => {
    delete process.env["HOME"];
    expect(getClaudeDataDir().split(path.sep)).not.toContain("~");
  });

  it("resolves an absolute projects dir when HOME is unset", () => {
    delete process.env["HOME"];
    expect(path.isAbsolute(getProjectsDir())).toBe(true);
  });

  it("resolves an absolute cache dir when HOME and XDG_CACHE_HOME are unset", () => {
    delete process.env["HOME"];
    delete process.env["XDG_CACHE_HOME"];
    const dir = getCacheDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.split(path.sep)).not.toContain("~");
  });

  it("resolves an absolute cache dir when HOME is empty and XDG_CACHE_HOME is unset", () => {
    process.env["HOME"] = "";
    delete process.env["XDG_CACHE_HOME"];
    expect(path.isAbsolute(getCacheDir())).toBe(true);
  });

  it("still prefers XDG_CACHE_HOME when it is set", () => {
    process.env["XDG_CACHE_HOME"] = path.join(tmpHome, "xdg");
    expect(getCacheDir()).toBe(path.join(tmpHome, "xdg", "gccusage"));
  });
});

describe("findSessionJsonlFiles", () => {
  it("returns only the matching session file", () => {
    const files = findSessionJsonlFiles("session-1");
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!)).toBe("session-1.jsonl");
  });

  it("fails closed when no session id is given", () => {
    expect(findSessionJsonlFiles(undefined)).toHaveLength(0);
    expect(findSessionJsonlFiles("")).toHaveLength(0);
  });
});
