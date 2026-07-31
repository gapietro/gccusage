import { readStdin, parseStatusJson } from "./data/stdin-reader.js";
import { loadSettings, getConfigPath } from "./config/loader.js";
import { formatConfigError } from "./config/error-line.js";
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
  const { settings, error } = loadSettings();
  if (error) {
    // Returning here — before the stdin read and before runStatusline — keeps
    // the statusline cache untouched, so a stale bar is never served over the
    // error and the first prompt after a fix renders normally.
    process.stdout.write(formatConfigError(error, getConfigPath()));
    return;
  }

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
