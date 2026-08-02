/**
 * Stamp the README's version and build badges. Run by
 * .github/workflows/build-badge.yml on every push to main.
 *
 * Like the other scripts here it runs under Node with no build step, which
 * requires native TypeScript type stripping (unflagged in Node 23.6,
 * backported to 22.x). On an older Node it fails to parse before any of its
 * code runs, so it cannot report the problem itself; the workflow pins a Node
 * that qualifies.
 *
 *   npm run badge
 *
 * GCCUSAGE_BADGE_ROOT overrides the repository root, which is how the tests
 * drive it against a temp directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { nextBuild, renderBadges, todayInZone } from "./lib/build-badge.ts";

const STATE_PATH = [".github", "build-number.json"];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readState(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Absent or malformed: nextBuild treats it as a fresh day.
    return undefined;
  }
}

function main(): void {
  const root =
    process.env.GCCUSAGE_BADGE_ROOT ?? path.join(import.meta.dirname, "..");
  const statePath = path.join(root, ...STATE_PATH);
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

  const state = nextBuild(readState(statePath), todayInZone(new Date()));

  // Render before writing anything, so a README that has lost its markers
  // leaves both files as they were instead of burning a build number.
  const rendered = renderBadges(readme, { version, build: state.build });
  if (!rendered.ok) return fail(rendered.error);

  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(readmePath, rendered.readme);
  console.log(`build ${state.build} — version ${version}`);
}

main();
