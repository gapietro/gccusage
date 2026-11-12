import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS } from "../../config/defaults.js";
import type { Settings } from "../../config/schema.js";

const GIT_WIDGETS = new Set(["git-branch", "git-changes"]);

/**
 * The default layout with the git widgets removed, for bundle-spawning tests
 * that don't assert on git output.
 *
 * With no settings file, a spawned render uses the default layout, and its
 * `git-branch`/`git-changes` run real git in the test runner's directory: the
 * developer's checkout or the CI clone. Under suite load those calls take up
 * to ~1.1 s each, against a 2 s production deadline (#146). In a test that
 * times renders or makes several of them, that is noise large enough to fail
 * the test (#148). Keeping every other default widget means the rest of the
 * default bar is still exercised.
 */
export function gitFreeDefaultSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    lines: DEFAULT_SETTINGS.lines.map((line) => ({
      ...line,
      widgets: line.widgets.filter((w) => !GIT_WIDGETS.has(w.type)),
    })),
  };
}

/**
 * Write `gitFreeDefaultSettings()` where a render with
 * `XDG_CONFIG_HOME=configHome` will load it.
 */
export function writeGitFreeSettings(configHome: string): void {
  const dir = path.join(configHome, "gccusage");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(gitFreeDefaultSettings()));
}
