import { readStdin, parseStatusJson } from "./data/stdin-reader.js";
import { loadSettings } from "./config/loader.js";
import { runStatusline } from "./statusline.js";
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
  const output = await runStatusline(stdin, settings);
  process.stdout.write(output);
}

main().catch(() => {
  // Graceful degradation — output nothing on error
  process.exit(0);
});
