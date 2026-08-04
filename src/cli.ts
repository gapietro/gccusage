import { getTodayAggregate } from "./cache/today-aggregate-cache.js";
import { fetchPricing, refreshPricing } from "./data/pricing-fetcher.js";
import { calculateCostByModel, calculateTotalCost } from "./data/cost-calculator.js";
import { formatDollars, formatTokens, formatModelName } from "./utils/format.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./utils/atomic-json.js";
import { resolveStableNodePath } from "./utils/node-path.js";
import { PREMIUM_PROMPT_THRESHOLD } from "./data/pricing-tiers.js";
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
    case "help":
      printHelp();
      break;
    // Internal: what the detached refresher child runs. Undocumented in help
    // because it is an implementation detail of the render path, not a
    // command anyone needs to type.
    case "refresh-pricing":
      await refreshPricing();
      break;
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
    console.log(
      `\n${approximated.join(", ")} billed ${formatTokens(premiumTokens)} tokens above the ` +
        `${formatTokens(PREMIUM_PROMPT_THRESHOLD)} threshold; no premium rate is published for ` +
        `them, so those tokens are costed at the standard rate. The real total is higher.`,
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
    throw new Error(`${settingsPath} could not be read (${messageOf(err)}). ${FIX_HINT}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${messageOf(err)}). ${FIX_HINT}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${settingsPath} contains ${describeNonObject(parsed)}, not a JSON object. ${FIX_HINT}`,
    );
  }

  return { settings: parsed as Record<string, unknown>, raw };
}

function runSetup(): void {
  // Resolve the absolute path to this script's dist/index.js
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  const settingsPath = resolve(homedir(), ".claude", "settings.json");

  // Validate before writing anything at all: a refused file leaves no .bak
  // and no partial write.
  const existing = readExistingSettings(settingsPath);
  const settings = existing?.settings ?? {};

  // The backup is for the success path — the common case, and the one that
  // previously got none (#89).
  if (existing) writeFileAtomic(`${settingsPath}.bak`, existing.raw);

  const node = resolveStableNodePath();
  const command = buildStatusLineCommand(node.path, scriptPath);
  settings["statusLine"] = { type: "command", command };

  // Indented with a trailing newline: this is a file the user reads and edits.
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log("gccusage setup complete!\n");
  console.log(`  Settings: ${settingsPath}`);
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
  gccusage help         Show this help

Quick Start:
  git clone https://github.com/gapietro/gccusage.git
  cd gccusage && npm link
  gccusage setup

Config: ~/.config/gccusage/settings.json`);
}
