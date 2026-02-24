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

  // Read stdin
  const isTTY = process.stdin.isTTY;
  let raw = "";
  if (!isTTY) {
    raw = await readStdin();
  }

  const stdin = parseStatusJson(raw) ?? {};
  const sessionId = stdin.session_id;

  // Check cache first (hot path)
  const cached = checkCache(settings.cache?.statuslineTtlMs ?? 5000, sessionId);
  if (cached !== null) {
    process.stdout.write(cached);
    return;
  }

  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output, sessionId);
  process.stdout.write(output);
}

main().catch(() => {
  // Graceful degradation — output nothing on error
  process.exit(0);
});
