import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
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

/**
 * Read a JSON file and validate it, or get nothing. Every cache file in this
 * codebase used to be read with `JSON.parse(raw) as SomeType` — a cast that
 * checks nothing at runtime — while config got full valibot validation. The
 * caches are the files that can actually be corrupted, by a torn write or by
 * hand (#92).
 *
 * Returns null for a missing file, an unreadable one, malformed JSON, or a
 * document that does not match `schema`. Callers treat null as "rebuild from
 * scratch", which is the posture they already had for a missing file.
 */
export function readJsonValidated<S extends v.GenericSchema>(
  filePath: string,
  schema: S,
): v.InferOutput<S> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = v.safeParse(schema, parsed);
  return result.success ? result.output : null;
}
