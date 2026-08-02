import { createHash } from "node:crypto";
import type { StatusJson } from "../types/status-json.js";

/**
 * Fields deliberately excluded from the cache key.
 *
 * Both are wall-clock counters that Claude Code recomputes on every spawn, so
 * keying on them would miss on every render — and each miss re-reads and
 * re-parses the whole transcript set (#94). Bounding their staleness is what
 * the TTL is for: `session-timer` and `api-latency` can lag by up to one TTL,
 * which is invisible on a counter that is already a duration.
 *
 * Nothing else is excluded. The key is built by removing from the payload
 * rather than by listing what to include, so a widget that starts reading a
 * field it did not read before is covered without anyone remembering to
 * extend a tuple — which is how the original key fell behind (#96).
 */
const VOLATILE_COST_FIELDS = ["total_duration_ms", "total_api_duration_ms"] as const;

/**
 * Serialise with object keys in sorted order, so two payloads that differ only
 * in property order hash the same. `JSON.stringify` alone preserves insertion
 * order, and the stdin object's order is whatever the upstream JSON had.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // JSON.stringify drops undefined-valued keys; drop them here too so a key
    // present-but-undefined hashes the same as a key that is absent.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}

/**
 * The identity of a rendered bar: every stdin input the render can depend on,
 * plus the terminal width the layout was computed against.
 *
 * Not included, deliberately: the git branch and working-tree status, which
 * live on disk rather than in stdin. Reading them would mean spawning git on
 * every invocation, including the cache hits this exists to make cheap; their
 * staleness stays TTL-bounded.
 */
export function computeCacheKey(
  stdin: StatusJson,
  terminalWidth: number | undefined,
): string {
  const { ...rest } = stdin;
  if (rest.cost && typeof rest.cost === "object") {
    const cost: Record<string, unknown> = { ...rest.cost };
    for (const field of VOLATILE_COST_FIELDS) delete cost[field];
    rest.cost = cost as StatusJson["cost"];
  }

  const payload = stableStringify({ stdin: rest, terminalWidth });
  return createHash("sha256").update(payload).digest("hex");
}
