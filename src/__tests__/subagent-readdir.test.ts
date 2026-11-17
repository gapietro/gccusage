import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findSessionJsonlFiles, findTodayJsonlFileStats } from "../utils/paths.js";

/**
 * COR-007 follow-up: the subagent lookup runs once per project dir on every
 * session read, and once per session dir on every Today walk. Most of those
 * dirs have no `subagents/` at all, and when `subagents/` is missing its
 * `workflows/` child cannot exist, so reading it is a second failed syscall
 * per dir for nothing.
 *
 * `readdirSync` is wrapped in a pass-through spy, so the walk runs for real
 * and only the paths it tried are observed.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

const SESSION = "0c070007-aaaa-4bbb-8ccc-0000000000aa";

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-cor007-readdir-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;
  vi.mocked(fs.readdirSync).mockClear();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readdirTargets(): string[] {
  return vi.mocked(fs.readdirSync).mock.calls.map((c) => String(c[0]));
}

function workflowReads(): string[] {
  return readdirTargets().filter((p) => p.endsWith(path.join("subagents", "workflows")));
}

describe("the subagent lookup's syscalls (COR-007)", () => {
  it("does not read workflows/ for a session with no subagents dir", () => {
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    fs.mkdirSync(path.join(dir, SESSION, "tool-results"), { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), "{}\n");

    findSessionJsonlFiles(SESSION);
    findTodayJsonlFileStats();

    // Control: the subagents lookup itself did run, in both walks.
    expect(readdirTargets().filter((p) => p.endsWith("subagents"))).toHaveLength(2);
    expect(workflowReads()).toEqual([]);
  });

  it("still reads workflows/ when subagents/ exists", () => {
    const dir = path.join(tmpDir, ".claude", "projects", "-proj");
    const run = path.join(dir, SESSION, "subagents", "workflows", "wf_1");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, "agent-w1.jsonl"), "{}\n");
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), "{}\n");

    expect(findSessionJsonlFiles(SESSION)).toContain(path.join(run, "agent-w1.jsonl"));
    expect(workflowReads()).toHaveLength(1);
  });
});
