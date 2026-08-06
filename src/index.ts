import { readStdin, parseStatusJson } from "./data/stdin-reader.js";
import { loadSettings, getConfigPath } from "./config/loader.js";
import {
  formatConfigError,
  formatStdinError,
  formatStdinReadError,
  formatStdinTimeout,
} from "./config/error-line.js";
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
    // The stream can fail outright — EIO once the controlling terminal is gone,
    // ECONNRESET on a socket stdin. That rejection used to propagate to the
    // blanket catch at the bottom of this file, which writes nothing, and empty
    // stdout makes Claude Code erase the bar rather than keep the previous one.
    // Every other unusable-input path here renders a line; this was the last
    // one that did not (REL-004, deferred from #87).
    let result: Awaited<ReturnType<typeof readStdin>>;
    try {
      result = await readStdin();
    } catch (err) {
      process.stdout.write(
        formatStdinReadError(err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    const { raw: payload, timedOut, timeoutMs } = result;
    if (timedOut) {
      // Returning here — before the parse and before runStatusline — keeps the
      // statusline cache untouched, matching the two paths above. It matters:
      // the empty-object bar used to be *written* to the cache under the empty
      // payload's key, so a second timeout inside the TTL served the wrong bar
      // from cache without even reading stdin.
      //
      // Partial bytes still report a timeout rather than being parsed. Claude
      // Code end()s stdin immediately after writing, so bytes without an end
      // mean truncation, and "stdin is not valid JSON" would misdiagnose the
      // cause in the one place the user gets to read (#87).
      process.stdout.write(formatStdinTimeout(timeoutMs));
      return;
    }
    raw = payload;
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
