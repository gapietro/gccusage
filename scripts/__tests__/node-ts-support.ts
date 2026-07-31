/**
 * Whether a Node runtime can execute a `.ts` file directly.
 *
 * The scripts in this directory run under Node with no build step, which
 * relies on native TypeScript type stripping. That landed unflagged in Node
 * 23.6 and was backported to 22.x, so a hardcoded version floor would be
 * wrong on one side or the other — ask the runtime instead.
 *
 * `process.features.typescript` reports the mode as a string (`"strip"`, or
 * `"transform"` under --experimental-transform-types), `false` when stripping
 * is disabled, and is **absent** on Node older than the property itself —
 * which is exactly the range that cannot strip types at all. So this must be
 * a positive test for a mode string: a negative test against `false` reads
 * `undefined` as support and enables the tests on the very versions the
 * guard exists to protect.
 */
export function supportsTypeScript(feature: typeof process.features.typescript): boolean {
  return typeof feature === "string";
}

/**
 * Tests that spawn `process.execPath` against a `.ts` entry point must skip
 * when this is false, or `npm test` fails on a Node the package's `engines`
 * field still claims to support. Everything else in these suites runs under
 * vitest, which transpiles, and works on any supported Node.
 */
export const nodeRunsTypeScript = supportsTypeScript(process.features.typescript);
