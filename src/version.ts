/**
 * The shipped version, mirrored from package.json's `version`.
 *
 * Not imported from the manifest directly: `rootDir` is `src`, so tsc rejects
 * a specifier that escapes it, and inlining the whole manifest to read one
 * string ships every field of it in `dist/index.js`.
 *
 * `version.test.ts` fails when this and package.json disagree, which is the
 * same posture as `config-schema.json` (#75): duplicated state is held by a
 * test, not by remembering to update both. A release that bumps one and not
 * the other turns the suite red rather than shipping a binary that misreports
 * itself — the exact gap OPS-007 named.
 */
export const VERSION = "0.2.0";
