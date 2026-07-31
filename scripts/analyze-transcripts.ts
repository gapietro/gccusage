/**
 * Transcript analysis for issue #49 — what a token-efficiency meter should measure.
 *
 * Runs under Node with no build step and no dependency to install, which
 * requires native TypeScript type stripping — unflagged in Node 23.6 and
 * backported to 22.x. On a Node without it this file fails to parse before
 * any of its code runs, so it cannot report the problem itself; the symptom
 * is a SyntaxError on a type annotation. `process.features.typescript`
 * tells you whether the current Node qualifies.
 *
 * This is a development tool. It is not part of the published package
 * (`files` ships `dist` only), so it does not constrain `engines.node`,
 * which governs the bundled statusline that consumers actually install.
 *
 *   npm run analyze                    # markdown tables
 *   npm run analyze -- --json          # machine-readable aggregates
 *   npm run analyze -- --projects-dir /path/to/projects
 *
 * Output is anonymised: project directories are reported as proj-a, proj-b,
 * and so on, and no prompt text, file contents, or paths are ever emitted.
 */
import { parseArgs, resolveProjectsDir, USAGE } from "./lib/cli.ts";
import { defaultProjectsDir } from "./lib/discover.ts";
import { buildReport, renderMarkdown } from "./lib/report.ts";

function main(argv: string[]): void {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }

  const resolved = resolveProjectsDir(parsed.options, defaultProjectsDir);
  if (!resolved.ok) {
    console.error(resolved.error);
    process.exit(1);
  }

  const report = buildReport(resolved.dir);
  process.stdout.write(
    parsed.options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderMarkdown(report)}\n`,
  );
}

main(process.argv.slice(2));
