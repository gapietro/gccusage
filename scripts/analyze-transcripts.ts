/**
 * Transcript analysis for issue #49 — what a token-efficiency meter should measure.
 *
 * Requires Node >= 23.6, which strips TypeScript types natively. On older
 * Node this file fails to parse; there is no build step and no dependency
 * to install.
 *
 *   npm run analyze                    # markdown tables
 *   npm run analyze -- --json          # machine-readable aggregates
 *   npm run analyze -- --projects-dir /path/to/projects
 *
 * Output is anonymised: project directories are reported as proj-a, proj-b,
 * and so on, and no prompt text, file contents, or paths are ever emitted.
 */
import { defaultProjectsDir } from "./lib/discover.ts";
import { buildReport, renderMarkdown } from "./lib/report.ts";

function main(argv: string[]): void {
  const asJson = argv.includes("--json");
  const dirFlag = argv.indexOf("--projects-dir");
  const projectsDir = dirFlag !== -1 ? argv[dirFlag + 1] : undefined;

  if (dirFlag !== -1 && !projectsDir) {
    console.error("--projects-dir requires a path");
    process.exit(1);
  }

  const report = buildReport(projectsDir ?? defaultProjectsDir());
  process.stdout.write(
    asJson ? `${JSON.stringify(report, null, 2)}\n` : `${renderMarkdown(report)}\n`,
  );
}

main(process.argv.slice(2));
