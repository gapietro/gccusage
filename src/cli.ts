import { findTodayJsonlFiles, findSessionJsonlFiles } from "./utils/paths.js";
import { parseJsonlFile } from "./data/jsonl-reader.js";
import { aggregateTokens } from "./data/token-aggregator.js";
import { fetchPricing } from "./data/pricing-fetcher.js";
import { calculateCostByModel, calculateTotalCost } from "./data/cost-calculator.js";
import { formatDollars, formatTokens, formatModelName } from "./utils/format.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function reportToday(): Promise<void> {
  const files = findTodayJsonlFiles();
  const entries = files.flatMap(parseJsonlFile);
  const metrics = aggregateTokens(entries, entries);
  const pricing = await fetchPricing(86400000);
  const costByModel = calculateCostByModel(metrics.byModel, pricing);
  const totalCost = calculateTotalCost(costByModel);

  console.log("=== Today's Usage ===\n");
  console.log(`Total Cost: ${formatDollars(totalCost)}`);
  console.log(
    `Total Tokens: ${formatTokens(metrics.today.inputTokens + metrics.today.outputTokens)}`,
  );
  console.log();

  if (costByModel.size > 0) {
    console.log("By Model:");
    for (const [model, cost] of costByModel) {
      const tokens = metrics.byModel.get(model);
      const total = tokens
        ? tokens.inputTokens + tokens.outputTokens
        : 0;
      console.log(
        `  ${formatModelName(model)}: ${formatDollars(cost)} (${formatTokens(total)} tokens)`,
      );
    }
  }

  console.log(`\nSessions analyzed: ${files.length} files`);
}

function runSetup(): void {
  // Resolve the absolute path to this script's dist/index.js
  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "index.js",
  );

  const claudeDir = resolve(homedir(), ".claude");
  const settingsPath = resolve(claudeDir, "settings.json");

  // Ensure ~/.claude/ exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Read existing settings or start fresh
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.error(
        `Warning: Could not parse ${settingsPath}, creating backup and starting fresh`,
      );
      writeFileSync(`${settingsPath}.bak`, readFileSync(settingsPath));
      settings = {};
    }
  }

  // Merge statusLine config without overwriting other settings
  const command = `node ${scriptPath}`;
  settings.statusLine = { type: "command", command };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log("gccusage setup complete!\n");
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Command:  ${command}\n`);
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
