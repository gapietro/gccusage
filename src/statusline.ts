import { buildRenderContext } from "./data/pipeline.js";
import { renderStatusline } from "./render/renderer.js";
import { checkCache, writeCache } from "./cache/cache-manager.js";
import type { Settings } from "./config/schema.js";
import type { StatusJson } from "./types/status-json.js";

export async function runStatusline(
  stdin: StatusJson,
  settings: Settings,
): Promise<string> {
  const sessionId = stdin.session_id;
  const stdinCost = stdin.cost?.total_cost_usd;

  // Check cache first (hot path). The stdin cost is part of the cache key:
  // a changed cumulative cost bypasses the cache so the pipeline re-runs and
  // trackDailyCost records the new spend (issue #30). While the cost is
  // unchanged, serving the cache is safe — the tracker already saw this
  // value on the last miss.
  const cached = checkCache(
    settings.cache?.statuslineTtlMs ?? 5000,
    sessionId,
    stdinCost,
  );
  if (cached !== null) {
    return cached;
  }

  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output, sessionId, stdinCost);
  return output;
}
