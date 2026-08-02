import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "./paths.js";

// Distinguishes concurrent writes from within one process; the pid
// distinguishes them across processes. A fixed ".tmp" name would let two
// writers interleave into the same temp file and rename the mixture into
// place — the corruption this helper exists to prevent.
let counter = 0;

/**
 * Write JSON to `filePath` so that readers see either the previous contents
 * or the new ones, never a partial file: serialise into a uniquely named
 * sibling, then rename it over the target. Same directory means same
 * filesystem, which is what makes the rename atomic.
 *
 * Throws on failure; callers keep whatever error posture they already have.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const serialised = JSON.stringify(data);
  const tmpPath = `${filePath}.${process.pid}.${counter++}.tmp`;

  fs.writeFileSync(tmpPath, serialised, "utf-8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing more to do; the rename failure is the error that matters.
    }
    throw err;
  }
}
