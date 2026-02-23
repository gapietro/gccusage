import { findTodayJsonlFiles, findSessionJsonlFiles } from "./utils/paths.js";
import { parseJsonlFile } from "./data/jsonl-reader.js";
import { aggregateTokens } from "./data/token-aggregator.js";
import { fetchPricing } from "./data/pricing-fetcher.js";
import { calculateCostByModel, calculateTotalCost } from "./data/cost-calculator.js";
import { formatDollars, formatTokens, formatModelName } from "./utils/format.js";

export async function runCli(args: string[]): Promise<void> {
  const command = args[0] ?? "today";

  switch (command) {
    case "today":
      await reportToday();
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

function printHelp(): void {
  console.log(`gccusage - Claude Code usage analytics

Usage:
  gccusage              Statusline mode (reads stdin JSON)
  gccusage today        Show today's usage report
  gccusage help         Show this help

Statusline Installation:
  Add to ~/.claude/settings.json:
  {
    "hooks": {
      "StatusLine": [{ "type": "command", "command": "npx gccusage@latest" }]
    }
  }

Config: ~/.config/gccusage/settings.json`);
}
