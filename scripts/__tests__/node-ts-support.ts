/**
 * Whether this Node can execute a `.ts` file directly.
 *
 * The scripts in this directory are run by Node with no build step, which
 * relies on native TypeScript type stripping. That landed unflagged in Node
 * 23.6 and was backported to 22.x, so a hardcoded version floor would be
 * wrong on one side or the other — ask the runtime instead.
 *
 * Tests that spawn `process.execPath` against a `.ts` entry point must skip
 * when this is false, or `npm test` fails on a Node the package's `engines`
 * field still claims to support. Everything else in these suites runs under
 * vitest, which transpiles, and works on any supported Node.
 */
export const nodeRunsTypeScript = process.features.typescript !== false;
