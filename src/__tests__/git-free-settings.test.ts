import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSettings } from "../config/loader.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";
import { writeGitFreeSettings } from "./helpers/git-free-settings.js";

/**
 * The bundle tests that use this helper (#148) only stay free of real git if
 * the file it writes is actually loaded. If it ever failed validation, the
 * loader would fall back to the default layout, git would come back, and
 * nothing in those tests would notice.
 */
describe("writeGitFreeSettings", () => {
  let dir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-gitfree-"));
    originalXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = dir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalXdg;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads cleanly with no git widgets and every other default widget", () => {
    writeGitFreeSettings(dir);

    const { settings, error } = loadSettings();
    const types = settings.lines.flatMap((l) => l.widgets.map((w) => w.type));
    const defaultTypes = DEFAULT_SETTINGS.lines.flatMap((l) => l.widgets.map((w) => w.type));

    expect(error).toBeUndefined();
    expect(types).not.toContain("git-branch");
    expect(types).not.toContain("git-changes");
    expect(types).toEqual(defaultTypes.filter((t) => t !== "git-branch" && t !== "git-changes"));
  });
});
