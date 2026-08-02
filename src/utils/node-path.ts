import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A path segment naming a specific Node version — the thing that makes an
 * interpreter path expire. Homebrew's Cellar, nvm, nodenv, fnm and volta all
 * encode the version this way, so one pattern covers every layout that has
 * the problem. Homebrew's per-major symlink (`opt/node@22/bin/node`) is
 * deliberately not matched: brew re-points it on upgrade, so it is stable.
 */
const VERSION_SEGMENT = /\/(v?\d+\.\d+\.\d+[^/]*)/;

export function versionSegment(p: string): string | null {
  return VERSION_SEGMENT.exec(p)?.[1] ?? null;
}

export interface NodePathProbe {
  execPath: string;
  pathEntries: string[];
  /** Resolves symlinks; throws if the path does not exist. */
  realpath(p: string): string;
}

function defaultProbe(): NodePathProbe {
  return {
    execPath: process.execPath,
    pathEntries: (process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter((entry) => entry.length > 0),
    realpath: (p: string) => fs.realpathSync(p),
  };
}

function versionWarning(version: string): string {
  return (
    `Warning: this Node path contains a version (${version}) and will stop ` +
    "working when that version is removed. Re-run `gccusage setup` after " +
    "upgrading Node."
  );
}

/**
 * The interpreter path to persist in `statusLine.command`.
 *
 * `process.execPath` is the obvious choice and the wrong one: Node resolves
 * symlinks for it, so on Homebrew it reports the Cellar path that the next
 * `brew upgrade node` deletes, silently breaking the statusline (#90). Bare
 * `node` was the alternative considered and rejected — Claude Code also runs
 * as a desktop app, which may spawn with a minimal PATH that omits
 * `/opt/homebrew/bin`.
 */
export function resolveStableNodePath(
  probe: NodePathProbe = defaultProbe(),
): { path: string; warning?: string } {
  const version = versionSegment(probe.execPath);

  // Already stable (/usr/bin/node, /usr/local/bin/node): nothing to look up.
  if (version === null) return { path: probe.execPath };

  let target: string;
  try {
    target = probe.realpath(probe.execPath);
  } catch {
    return { path: probe.execPath, warning: versionWarning(version) };
  }

  // PATH order is the tie-break: the user's own precedence is more defensible
  // than any ranking we invent, and every candidate resolving to `target` is
  // equally correct.
  for (const dir of probe.pathEntries) {
    const candidate = path.join(dir, "node");
    if (versionSegment(candidate) !== null) continue;

    let resolved: string;
    try {
      resolved = probe.realpath(candidate);
    } catch {
      continue;
    }

    if (resolved === target) return { path: candidate };
  }

  return { path: probe.execPath, warning: versionWarning(version) };
}
