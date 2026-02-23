import { readStdin, parseStatusJson } from "./data/stdin-reader.js";
import { loadSettings } from "./config/loader.js";
import { buildRenderContext } from "./data/pipeline.js";
import { renderStatusline } from "./render/renderer.js";
import { checkCache, writeCache } from "./cache/cache-manager.js";
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  // Direct invocation mode (CLI)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    await runCli(args);
    return;
  }

  // Statusline mode
  const settings = loadSettings();

  // Check cache first (hot path)
  const cached = checkCache(settings.cache?.statuslineTtlMs ?? 5000);
  if (cached !== null) {
    process.stdout.write(cached);
    return;
  }

  // Read stdin
  const isTTY = process.stdin.isTTY;
  let raw = "";
  if (!isTTY) {
    raw = await readStdin();
  }

  const stdin = parseStatusJson(raw) ?? {};
  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output);
  process.stdout.write(output);
}

main().catch(() => {
  // Graceful degradation — output nothing on error
  process.exit(0);
});
