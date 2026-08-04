/**
 * Files that declare types and emit no JavaScript at all.
 *
 * v8 reports these as 0% rather than 100% — there is no statement to execute,
 * so nothing ever "runs" — which would fail the per-file coverage threshold
 * for a file that cannot be tested and does not ship. `vitest.config.ts`
 * excludes them so that 0% anywhere else stays a failure.
 *
 * This is deliberately a file list and not `src/types/**`: `block-metrics.ts`
 * lives there and exports a real constant. `../type-only.test.ts` fails if any
 * entry here stops being type-only or stops existing, so the list cannot
 * quietly become a place to park untested code.
 *
 * It lives under `src/` rather than beside the vitest config because `tsc`
 * sets `rootDir: "src"`, so a test may not import from the repo root. The
 * config is not in `tsconfig.json`'s `include`, so the dependency only works
 * in this direction.
 */
export const TYPE_ONLY_FILES = [
  "src/types/burn-rate.ts",
  "src/types/pricing.ts",
  "src/types/render-context.ts",
  "src/types/token-metrics.ts",
  "src/widgets/base.ts",
];
