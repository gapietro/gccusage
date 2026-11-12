/**
 * Read a millisecond deadline from an environment variable, falling back to
 * `fallback` for anything that is not an integer in [1, 2^31-1].
 *
 * One rule for every `GCCUSAGE_*_TIMEOUT_MS` override, because both consumers
 * fail the same silent way on a bad value — the bar loses something on every
 * render with no message — just through different Node APIs:
 *
 * - `setTimeout` (stdin, #87) fires immediately for NaN, and past 2^31-1 emits
 *   an invisible `TimeoutOverflowWarning` and clamps the delay to 1ms.
 * - `execSync` (git, #146) treats 0 as NO deadline, and throws
 *   `ERR_OUT_OF_RANGE` for NaN, negative, fractional and huge values — which
 *   the git helper's catch turns into "not a repo".
 *
 * Malformed values degrade to the default rather than being coerced.
 */
export function resolveTimeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    return fallback;
  }
  return parsed;
}
