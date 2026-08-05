/**
 * README badges: a stamped version badge and a live CI status badge.
 *
 * There used to be a third, a `MMDD.<pushes today>` build counter, stamped by
 * a workflow that committed to `main` on every push. Protecting `main` with
 * required status checks made that push impossible — `GH006: protected branch
 * hook declined` — and the counter was decorative anyway. The CI badge
 * replaces it: it reports something load-bearing (whether the suite is green)
 * and costs no commits, because GitHub renders it from the workflow's own
 * state.
 *
 * Everything here is pure so it can be tested without a filesystem; the entry
 * point in ../build-badge.ts does the reading and writing.
 */

export const BADGE_START = "<!-- badges:start -->";
export const BADGE_END = "<!-- badges:end -->";

/**
 * Hardcoded rather than derived from the git remote: the badge has to resolve
 * for anyone reading the README on npm or a mirror, where no remote exists.
 * package.json's `repository` and `homepage` already pin the same slug.
 */
export const REPO_SLUG = "gapietro/gccusage";

export type RenderResult = { ok: true; readme: string } | { ok: false; error: string };

/**
 * Escape a value for a shields.io path segment, where `-` and `_` are
 * separators: they must be doubled to render literally, and a space is `_`.
 * Without this a prerelease like `1.0.0-rc1` splits into the wrong fields and
 * the badge renders as garbage instead of failing visibly.
 */
export function shieldsEscape(value: string): string {
  return value.replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_");
}

function shieldsBadge(label: string, message: string, color: string): string {
  const url = `https://img.shields.io/badge/${shieldsEscape(label)}-${shieldsEscape(message)}-${color}`;
  return `![${label}](${url})`;
}

/**
 * GitHub's own workflow badge, linked to the run history.
 *
 * Deliberately unstamped — it carries no value this script computes, so it is
 * identical on every run and reflects the real state of `main` the moment
 * someone loads the page, not the state at the last time anyone ran `npm run
 * badge`. A stamped CI badge could claim green while main was red.
 */
function ciBadge(): string {
  const workflow = `https://github.com/${REPO_SLUG}/actions/workflows/ci.yml`;
  return `[![ci](${workflow}/badge.svg?branch=main)](${workflow})`;
}

/**
 * Replace the marked block with freshly built badges.
 *
 * A missing marker is an error, not a fallback: appending or silently
 * returning the input would leave the badge permanently stale while every run
 * reported success.
 */
export function renderBadges(readme: string, values: { version: string }): RenderResult {
  const start = readme.indexOf(BADGE_START);
  const end = readme.indexOf(BADGE_END);
  if (start === -1) return { ok: false, error: `README is missing the ${BADGE_START} marker` };
  if (end === -1) return { ok: false, error: `README is missing the ${BADGE_END} marker` };
  if (end < start) {
    return { ok: false, error: `README has ${BADGE_END} before ${BADGE_START}` };
  }

  const block = [
    BADGE_START,
    shieldsBadge("version", values.version, "blue"),
    ciBadge(),
    BADGE_END,
  ].join("\n");

  return { ok: true, readme: readme.slice(0, start) + block + readme.slice(end + BADGE_END.length) };
}
