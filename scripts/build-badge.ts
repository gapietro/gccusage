/**
 * Stamp the README's version badge from package.json.
 *
 * Run by hand at release time — `npm version` does not touch the README — not
 * by a workflow. The build-counter workflow that used to run this on every
 * push to `main` was retired when `main` became a protected branch: its commit
 * could no longer land, and the counter it maintained was decorative. The CI
 * badge that replaced it needs no stamping.
 *
 * Like the other scripts here it runs under Node with no build step, which
 * requires native TypeScript type stripping (unflagged in Node 23.6,
 * backported to 22.x). On an older Node it fails to parse before any of its
 * code runs, so it cannot report the problem itself.
 *
 *   npm run badge
 *
 * GCCUSAGE_BADGE_ROOT overrides the repository root, which is how the tests
 * drive it against a temp directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { renderBadges } from "./lib/build-badge.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const root =
    process.env.GCCUSAGE_BADGE_ROOT ?? path.join(import.meta.dirname, "..");
  const readmePath = path.join(root, "README.md");
  const packagePath = path.join(root, "package.json");

  let version: string;
  try {
    version = JSON.parse(fs.readFileSync(packagePath, "utf8")).version;
  } catch (error) {
    return fail(`cannot read ${packagePath}: ${error instanceof Error ? error.message : error}`);
  }
  if (typeof version !== "string" || version === "") {
    return fail(`${packagePath} has no version`);
  }

  let readme: string;
  try {
    readme = fs.readFileSync(readmePath, "utf8");
  } catch (error) {
    return fail(`cannot read ${readmePath}: ${error instanceof Error ? error.message : error}`);
  }

  // Render before writing, so a README that has lost its markers is left
  // exactly as it was rather than half-rewritten.
  const rendered = renderBadges(readme, { version });
  if (!rendered.ok) return fail(rendered.error);

  fs.writeFileSync(readmePath, rendered.readme);
  console.log(`version ${version}`);
}

main();
