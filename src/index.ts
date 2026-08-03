import { readStdin, parseStatusJson } from "./data/stdin-reader.js";
import { loadSettings, getConfigPath } from "./config/loader.js";
import { formatConfigError, formatStdinError } from "./config/error-line.js";
import { runStatusline } from "./statusline.js";
import { runCli } from "./cli.js";

async function main(): Promise<void> {
  // Direct invocation mode (CLI)
  const args = process.argv.slice(2);
  if (args.length > 0) {
    // A CLI failure must be visible. The blanket catch below is graceful
    // degradation for statusline mode — never break the user's prompt — and
    // applying it here turned `setup` into a command that reported success
    // having done nothing (#88).
    try {
      await runCli(args);
    } catch (err) {
      console.error(`gccusage: ${err instanceof Error ? err.message : String(err)}`);
      // Not process.exit(1): stderr to a pipe is asynchronous on macOS, so an
      // immediate exit can terminate the process before the write drains and
      // truncate the message. Setting exitCode and letting main() return
      // naturally lets Node flush stdio before it exits with the same status.
      process.exitCode = 1;
    }
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
    const result = await readStdin();
    raw = result.raw;
  }

  // A bad FIELD is absorbed by the schema and costs only that field. An error
  // here means the payload was unusable as a whole, which is reported for the
  // same reason a config error is: the alternative was a confident $0.00 bar
  // built from {} (#83). Returning before runStatusline leaves the statusline
  // cache untouched, matching the config-error path above.
  const { stdin, error: stdinError } = parseStatusJson(raw);
  if (stdinError) {
    process.stdout.write(formatStdinError(stdinError));
    return;
  }

  const output = await runStatusline(stdin, settings);
  process.stdout.write(output);
}

main().catch(() => {
  // Graceful degradation — output nothing on error
  process.exit(0);
});
