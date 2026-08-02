import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-exit-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runSetupProcess(): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [DIST, "setup"], {
    env: { ...process.env, HOME: dir },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe.skipIf(!distExists)("gccusage setup exit code", () => {
  // Before the fix this exited 0 having printed nothing and changed nothing:
  // the throw was swallowed by main().catch(() => process.exit(0)), which is
  // graceful degradation meant for statusline mode only (#88).
  it("exits non-zero and explains itself on an unusable settings.json", () => {
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "null");

    const { status, stderr } = runSetupProcess();

    expect(status).toBe(1);
    expect(stderr).toContain("not a JSON object");
    expect(stderr).toContain("gccusage:");
  });

  it("still exits 0 on the success path", () => {
    const { status, stdout } = runSetupProcess();

    expect(status).toBe(0);
    expect(stdout).toContain("setup complete");
  });
});
