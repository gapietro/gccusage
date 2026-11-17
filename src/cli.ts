import { getTodayAggregate } from "./cache/today-aggregate-cache.js";
import { fetchPricing, refreshPricing } from "./data/pricing-fetcher.js";
import { calculateCostByModel, calculateTotalCost } from "./data/cost-calculator.js";
import { formatDollars, formatTokens, formatModelName } from "./utils/format.js";
import {
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  lstatSync,
  readlinkSync,
  statSync,
  accessSync,
  constants,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic, sweepStaleTempFiles } from "./utils/atomic-json.js";
import { resolveStableNodePath } from "./utils/node-path.js";
import { PREMIUM_PROMPT_THRESHOLD } from "./data/pricing-tiers.js";
import { getCacheDir, getHomeDir, narrowCacheModes } from "./utils/paths.js";
import { VERSION } from "./version.js";
import type { TokenMetrics } from "./types/token-metrics.js";

export async function runCli(args: string[]): Promise<void> {
  const command = args[0] ?? "today";

  switch (command) {
    case "today":
      await reportToday();
      break;
    case "setup":
      runSetup();
      break;
    // The flag spellings are aliases, not the canonical names, because
    // `gccusage help` predates them and is what the README documents. They
    // exist because `--help` and `--version` are the near-universal reflex and
    // both previously fell to `default:` — an error on stderr and exit 1 for
    // the two commands a user is most likely to try first (CLI-001).
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    case "version":
    case "--version":
    case "-v":
      // Bare, with no name prefix, so `gccusage --version` is directly
      // consumable by a script — the same shape as `npm --version`.
      console.log(VERSION);
      break;
    // Internal: what the detached refresher child runs. Undocumented in help
    // because it is an implementation detail of the render path, not a
    // command anyone needs to type.
    //
    // It also sweeps orphaned temp files from the cache (REL-008): this child
    // is already off the render path and rate-limited by the pricing TTL and
    // refresh backoff, which is the cadence a directory walk should run at.
    case "refresh-pricing": {
      // The refresher is never spawned without a cache dir, but the command
      // is reachable by hand, so it checks rather than assumes.
      // Narrowing a pre-SEC-003 cache tree runs here for the same reason.
      const cacheDir = getCacheDir();
      if (cacheDir !== null) {
        sweepStaleTempFiles(cacheDir);
        narrowCacheModes(cacheDir);
      }
      await refreshPricing();
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function reportToday(): Promise<void> {
  // Same per-file cache the statusline uses, so a `gccusage today` run right
  // after a render costs a stat sweep rather than a full re-parse (#94).
  const { byModel, totals, fileCount } = getTodayAggregate();
  const pricing = await fetchPricing(86400000);
  const { costs: costByModel, unpriced, approximated } = calculateCostByModel(byModel, pricing);
  const totalCost = calculateTotalCost(costByModel);

  const marker =
    unpriced.length > 0 ? " (partial)" : approximated.length > 0 ? " (approximate)" : "";

  console.log("=== Today's Usage ===\n");
  console.log(`Total Cost: ${formatDollars(totalCost)}${marker}`);
  console.log(`Total Tokens: ${formatTokens(totals.inputTokens + totals.outputTokens)}`);
  console.log();

  if (costByModel.size > 0) {
    console.log("By Model:");
    for (const [model, cost] of costByModel) {
      const tokens = byModel.get(model);
      const total = tokens
        ? tokens.inputTokens + tokens.outputTokens
        : 0;
      console.log(
        `  ${formatModelName(model)}: ${formatDollars(cost)} (${formatTokens(total)} tokens)`,
      );
    }
  }

  // Without this the usage of an unpriced model is simply absent from the
  // total, and the report looks complete (#82).
  if (unpriced.length > 0) {
    console.log(`\nNo pricing for ${unpriced.join(", ")} — their usage is missing from the total.`);
    console.log("Run `npm run pricing` to refresh the offline table.");
  }

  // Distinct from the unpriced sentence above, which would be false here: the
  // usage IS in the total, charged at the standard rate because the feed
  // publishes no premium rate for that model (#103).
  if (approximated.length > 0) {
    const premiumTokens = approximated.reduce(
      (sum, model) => sum + premiumTokenTotal(byModel.get(model)),
      0,
    );
    // PREMIUM_PROMPT_THRESHOLD is a fixed constant, not a measured quantity —
    // formatTokens is for humanising the latter, and would render this as
    // "200.0k" for no benefit. The measured premium token count above DOES
    // want formatTokens.
    //
    // premiumTokens sums all four counts (input + output + cacheCreation +
    // cacheRead), while "Total Tokens" above and the "By Model" line sum
    // input + output only — a real session's cache reads can make this figure
    // an order of magnitude larger than either. That is the CORRECT scope for
    // a sentence about billing (Anthropic bills the premium tier on all four),
    // so the fix is naming the scope in words, not changing the arithmetic.
    console.log(
      `\n${approximated.join(", ")} billed ${formatTokens(premiumTokens)} tokens (prompt, ` +
        `cache and completion) above the ${PREMIUM_PROMPT_THRESHOLD / 1000}k threshold; no ` +
        `premium rate is published for them, so those tokens are costed at the standard rate. ` +
        `The real total is higher.`,
    );
  }

  console.log(`\nSessions analyzed: ${fileCount} files`);
}

function premiumTokenTotal(metrics: TokenMetrics | undefined): number {
  const premium = metrics?.premium;
  if (!premium) return 0;
  return (
    premium.inputTokens +
    premium.outputTokens +
    premium.cacheCreationTokens +
    premium.cacheReadTokens
  );
}

/** POSIX shell single-quote escaping: ' becomes '\'' */
export function shellQuote(p: string): string {
  return `'${p.replaceAll("'", `'\\''`)}'`;
}

export function buildStatusLineCommand(execPath: string, scriptPath: string): string {
  return `${shellQuote(execPath)} ${shellQuote(scriptPath)}`;
}

const FIX_HINT = "Fix or move it, then re-run `gccusage setup`.";

function describeNonObject(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The user's settings, plus the bytes they came from, or null when the file
 * does not exist yet.
 *
 * Anything we cannot read as a JSON object is refused rather than replaced.
 * This file holds the user's permissions, hooks, MCP servers and model
 * selection; a convenience command has no business overwriting it with
 * `{statusLine}` on the strength of a `.bak` the user does not know exists
 * (#88). Note that an array root does not throw on assignment — it silently
 * loses the key at `JSON.stringify` — so it must be rejected explicitly.
 */
function readExistingSettings(
  settingsPath: string,
): { settings: Record<string, unknown>; raw: string } | null {
  if (!existsSync(settingsPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    throw new Error(`${settingsPath} could not be read (${messageOf(err)}). ${FIX_HINT}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${messageOf(err)}). ${FIX_HINT}`, {
      cause: err,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${settingsPath} contains ${describeNonObject(parsed)}, not a JSON object. ${FIX_HINT}`,
    );
  }

  return { settings: parsed as Record<string, unknown>, raw };
}

/**
 * Remove the turn store the pre-#129 tracker left behind.
 *
 * `trackTurn` owned both the 48h prune and the legacy-file unlink, so deleting
 * it stranded whatever was on disk. This runs in `setup` rather than on the
 * render path: an unconditional unlink per render is exactly the I/O #99
 * removed, and the leftovers are ~110 bytes of inert JSON.
 *
 * Best effort. A cache directory we cannot clean is not a reason to fail the
 * command that configures the statusline.
 */
function removeLegacyTurnStore(): void {
  const cacheDir = getCacheDir();
  if (cacheDir === null) return;
  for (const target of [resolve(cacheDir, "turns"), resolve(cacheDir, "turn-count.json")]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Best effort — see above.
    }
  }
}

/** Owner read/write only: for files that may hold `env` secrets. */
const PRIVATE_FILE_MODE = 0o600;

/**
 * The file a write to `settingsPath` should actually replace.
 *
 * `writeFileAtomic` renames a temp file over its target, and a rename over a
 * symlink replaces the link, not the file it points to. Dotfiles managers
 * link `~/.claude/settings.json` into a repo, so setup was silently turning
 * that link into a detached regular file (SEC-003). Writing to the resolved
 * path keeps the link and updates the file the user actually manages.
 *
 * Only the write is redirected. Reads, error messages and the `.bak` stay on
 * the logical path: it is the one the user knows, and a backup beside the
 * real target could land inside their dotfiles repo.
 *
 * A dangling link (its target does not exist yet) is followed, so setup
 * creates the file the link names rather than replacing the link. Each hop
 * resolves the link's text against its directory's REAL path, as the kernel
 * does: `..` in a relative link means the parent of where the link really
 * lives, so lexical resolution from a symlinked `~/.claude` wrote somewhere
 * the link never pointed (review of #154). The final directory must already
 * exist — a link into an unmounted volume is refused rather than recreated
 * as a shadow directory chain — and a loop is refused rather than "repaired"
 * by replacing one of its links with a file.
 */
function resolveWriteTarget(settingsPath: string): string {
  try {
    return realpathSync(settingsPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw symlinkLoopError(settingsPath, err);
    if (code !== "ENOENT") throw err;
    // Missing, or a dangling link: followed below.
  }

  let current = settingsPath;
  for (let hops = 0; isSymlink(current); hops++) {
    if (hops >= MAX_SYMLINK_HOPS) throw symlinkLoopError(settingsPath);
    current = resolve(realDirOf(settingsPath, current), readlinkSync(current));
  }
  if (current === settingsPath) return settingsPath; // No link: a new file.
  return resolve(realDirOf(settingsPath, current), basename(current));
}

/** The same bound the kernel applies (Linux MAXSYMLINKS). */
const MAX_SYMLINK_HOPS = 40;

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `dirname(p)` with symlinks resolved; refuses when it does not exist. */
function realDirOf(settingsPath: string, p: string): string {
  try {
    return realpathSync(dirname(p));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    throw new Error(
      `${settingsPath} is a symlink to ${p}, whose directory does not exist ` +
        "(an unmounted volume, or a moved dotfiles repo?). Nothing was changed. " +
        "Restore the link's target, or remove the link, and re-run `gccusage setup`.",
      { cause: err },
    );
  }
}

function symlinkLoopError(settingsPath: string, cause?: unknown): Error {
  return new Error(
    `${settingsPath} is part of a symlink loop. Nothing was changed. ` +
      "Point it at a real file and re-run `gccusage setup`.",
    { cause },
  );
}

/**
 * Refuse, with a message that says what to do, when settings.json is a
 * symlink into a directory setup cannot write.
 *
 * The atomic writer creates its temp file beside the target, so it needs
 * the target's DIRECTORY writable, not just the file. nix home-manager links
 * settings.json into the read-only store: the write failed with a bare
 * EACCES naming a temp file the user never heard of, and only after the
 * .bak was written, contradicting "a refused file leaves no .bak" (review
 * of #154). Replacing the link instead would silently detach a managed
 * file. The file is theirs to edit through whatever manages it.
 *
 * Other errors (ENOENT for a missing directory, say) are left to surface
 * from the write itself.
 */
function assertRedirectedTargetWritable(settingsPath: string, target: string): void {
  try {
    accessSync(dirname(target), constants.W_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EROFS" && code !== "EPERM") throw err;
    throw new Error(
      `${settingsPath} is a symlink to ${target}, and ${dirname(target)} is not writable ` +
        `(${code}) — is it managed by home-manager or a dotfiles tool? ` +
        "Nothing was changed. Add the statusLine entry there yourself, through that tool.",
      { cause: err },
    );
  }
}

/**
 * The permission bits `target` already has, so a rewrite does not change them,
 * or 0600 for a file setup is creating. settings.json often carries `env`
 * secrets, and the atomic writer's temp file would otherwise take the umask
 * default: 0600 came back as 0644 (SEC-003). Preserved rather than forced to
 * 0600, because a user who chose a mode for their own file chose it.
 *
 * Less group and other write. The writer applies the mode with an explicit
 * chmod, which bypasses the umask, so a 0666 file would come back 0666 —
 * setup re-emitting a file anyone on the machine can rewrite, and through
 * its `hooks` and `statusLine`, run commands as the user (review of #154).
 */
function existingModeOr(target: string): number {
  try {
    return statSync(target).mode & 0o777 & ~0o022;
  } catch {
    return PRIVATE_FILE_MODE;
  }
}

function runSetup(): void {
  // Resolve the absolute path to this script's dist/index.js
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  // getHomeDir(), not os.homedir(): the latter returns "" for HOME="", and
  // resolve("", ".claude", …) would edit a settings.json in the cwd — the
  // same relative-home class as SEC-004. With no home at all there is no
  // ~/.claude to configure, and guessing one (the old tmpdir fallback) wrote
  // into a shared directory, so refuse before touching anything.
  const home = getHomeDir();
  if (home === null) {
    throw new Error(
      "cannot determine home directory: HOME is unset or empty and there is no passwd entry. " +
        "Set HOME and re-run `gccusage setup`.",
    );
  }
  const settingsPath = resolve(home, ".claude", "settings.json");

  // Validate before writing anything at all: a refused file leaves no .bak
  // and no partial write. That includes the write target — resolved and, if
  // a symlink redirected it, checked writable here, before the .bak.
  const existing = readExistingSettings(settingsPath);
  const settings = existing?.settings ?? {};
  const target = resolveWriteTarget(settingsPath);
  // A redirect means settings.json ITSELF is a link. `target !== settingsPath`
  // is not the test: realpath also differs whenever any ancestor is a link
  // (macOS /var, Fedora Atomic /home -> /var/home, a linked ~/.claude), and
  // a regular file there is not "a symlink to" anything.
  const redirected = isSymlink(settingsPath);
  if (redirected) assertRedirectedTargetWritable(settingsPath, target);

  // The backup is for the success path — the common case, and the one that
  // previously got none (#89). Always 0600: it holds the same `env` secrets
  // as the original, whatever the original's mode (SEC-003).
  if (existing) writeFileAtomic(`${settingsPath}.bak`, existing.raw, PRIVATE_FILE_MODE);

  const node = resolveStableNodePath();
  const command = buildStatusLineCommand(node.path, scriptPath);
  settings["statusLine"] = { type: "command", command };

  // Indented with a trailing newline: this is a file the user reads and edits.
  writeFileAtomic(target, JSON.stringify(settings, null, 2) + "\n", existingModeOr(target));

  removeLegacyTurnStore();
  // Off the render path, like the refresh child: narrow a pre-SEC-003 cache.
  const cacheDir = getCacheDir();
  if (cacheDir !== null) narrowCacheModes(cacheDir);

  console.log("gccusage setup complete!\n");
  // Name the file actually written when a symlink redirected it, so a
  // dotfiles user can see which copy changed (review of #154).
  console.log(`  Settings: ${settingsPath}${redirected ? ` -> ${target}` : ""}`);
  console.log(`  Command:  ${command}`);
  if (existing) console.log(`  Backup:   ${settingsPath}.bak`);
  console.log();
  if (node.warning) console.log(`${node.warning}\n`);
  console.log("Restart Claude Code to activate the statusline.");
}

function printHelp(): void {
  console.log(`gccusage - Powerline statusline for Claude Code

Usage:
  gccusage              Statusline mode (reads stdin JSON)
  gccusage setup        Configure Claude Code to use gccusage
  gccusage today        Show today's usage report
  gccusage help         Show this help (also --help, -h)
  gccusage version      Print the version (also --version, -v)

Quick Start:
  git clone https://github.com/gapietro/gccusage.git
  cd gccusage && npm link
  gccusage setup

Config: ~/.config/gccusage/settings.json`);
}
