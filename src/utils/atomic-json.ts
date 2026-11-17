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
 * The same atomicity guarantee as `writeJsonAtomic`, for content that is
 * already a string. `gccusage setup` needs this: `~/.claude/settings.json` is
 * a file the user reads and edits, so it keeps its 2-space indentation and
 * trailing newline rather than the compact encoding `writeJsonAtomic` emits.
 *
 * `mode`, when given, is the exact permission set the file ends up with. The
 * rename replaces the target's inode, so the target's own mode never survives
 * a write: without this the result is whatever the umask gives a new file,
 * and setup turned a 0600 settings.json holding `env` secrets into 0644
 * (SEC-003). It is applied to the temp file before the rename, so the target
 * is never visible with a wider mode, even briefly.
 */
export function writeFileAtomic(filePath: string, contents: string, mode?: number): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  // Must keep matching TEMP_FILE_PATTERN below, or the sweep stops seeing
  // this writer's orphans.
  const tmpPath = `${filePath}.${process.pid}.${counter++}.tmp`;

  // The write is inside the try, not before it: open(2) creates the temp file
  // before a single byte lands, so a write failing part-way (ENOSPC, EIO)
  // used to leave it behind with nothing to remove it (REL-008).
  try {
    createExclusive(tmpPath, contents, mode);
    if (mode !== undefined) {
      // Creation is masked by the umask (0640 under 077 would land as 0600),
      // so the mode is made exact here. The file is the one createExclusive
      // just made; swapping it for a link before this chmod would need write
      // access to the target's directory, which already lets anyone replace
      // the target itself.
      try {
        fs.chmodSync(tmpPath, mode);
      } catch {
        // A filesystem that refuses chmod (vfat, some network mounts). The
        // file was freshly created with `mode`, so it is already at or below
        // it — true only because createExclusive never reuses a file.
        // Failing the write instead would throw from every cache write, and
        // the daily-shard write on the render path is not yet caught
        // (REL-005), so that would erase the bar.
      }
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing more to do; the write or rename failure is the error that
      // matters, and an ENOENT here just means no temp file was created.
    }
    throw err;
  }
}

/**
 * Write `contents` to a file at `tmpPath` that this call creates, never one
 * that was already there.
 *
 * The temp name is predictable (`<target>.<pid>.<n>.tmp`). With flag "w" a
 * symlink planted at that name was followed, so the write — and the chmod
 * after it — landed on whatever the link pointed at, and a leftover regular
 * file from a reused pid kept its own, possibly wider, mode (SEC-003, review
 * of #154). "wx" (O_CREAT|O_EXCL) refuses to open anything that exists,
 * symlinks included. On EEXIST the squatter is unlinked — which removes a
 * link, never its target — and the create is retried once. A second EEXIST
 * means someone is racing us for the name, and the write fails rather than
 * loop.
 */
function createExclusive(tmpPath: string, contents: string, mode: number | undefined): void {
  const options: fs.WriteFileOptions = { encoding: "utf-8", flag: "wx", ...(mode === undefined ? {} : { mode }) };
  try {
    fs.writeFileSync(tmpPath, contents, options);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    fs.unlinkSync(tmpPath);
    fs.writeFileSync(tmpPath, contents, options);
  }
}

/**
 * The exact shape of the temp names `writeFileAtomic` generates —
 * `<target>.<pid>.<counter>.tmp` — so the sweep cannot touch a user's own
 * `notes.tmp` or anything else that merely ends in `.tmp`.
 */
const TEMP_FILE_PATTERN = /\.\d+\.\d+\.tmp$/;

/**
 * Old enough that no live write can still own the file. A write is one
 * `writeFileSync` and one `rename` of a few KB; an hour is many orders of
 * magnitude past that, so a younger temp file is left alone in case another
 * process is mid-write to it.
 */
export const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

/**
 * Remove orphaned `writeFileAtomic` temp files from `dir` and its immediate
 * subdirectories (the cache keeps targets in `daily/` and `blocks/` as well as
 * at the root, and an orphan lands beside its target).
 *
 * Moving the write into the try stops a failed write leaking one, but nothing
 * in-process can clean up after a SIGKILL between open and rename — the real
 * cache held one from October when REL-008 was found. So this sweeps after the
 * fact.
 *
 * Not called on the render path: it is a directory walk, and renders are the
 * one place this tool has a latency budget. Its caller is the detached
 * `refresh-pricing` child, which is already off the render path and already
 * rate-limited — it runs only when pricing is stale, and at most once per
 * refresh backoff — so the walk costs nothing a user waits for, and an orphan
 * lives about a day at worst.
 *
 * Symlinks are skipped, not followed: the cache directory is ours, but a link
 * inside it could point anywhere. Best-effort throughout — a sweep that cannot
 * finish just leaves the files for the next one.
 */
export function sweepStaleTempFiles(dir: string): void {
  sweepDir(dir, Date.now(), 1);
}

function sweepDir(dir: string, now: number, depthLeft: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        if (depthLeft > 0) sweepDir(full, now, depthLeft - 1);
      } else if (
        stat.isFile() &&
        TEMP_FILE_PATTERN.test(name) &&
        now - stat.mtimeMs > STALE_TEMP_FILE_AGE_MS
      ) {
        fs.unlinkSync(full);
      }
    } catch {
      // Vanished or unreadable since readdir; leave it for the next sweep.
    }
  }
}

/**
 * Write JSON to `filePath` so that readers see either the previous contents
 * or the new ones, never a partial file: serialise into a uniquely named
 * sibling, then rename it over the target. Same directory means same
 * filesystem, which is what makes the rename atomic.
 *
 * Throws on failure; callers keep whatever error posture they already have.
 *
 * Always 0600: every caller is a cache file under `getCacheDir()` — session
 * ids, per-session spend, transcript-derived aggregates — and nobody but the
 * user needs to read them (SEC-003).
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data), 0o600);
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
