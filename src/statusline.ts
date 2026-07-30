import { buildRenderContext } from "./data/pipeline.js";
import { renderStatusline } from "./render/renderer.js";
import { checkCache, writeCache } from "./cache/cache-manager.js";
import { trackDailyCost } from "./data/daily-cost-tracker.js";
import type { Settings } from "./config/schema.js";
import type { StatusJson } from "./types/status-json.js";

export async function runStatusline(
  stdin: StatusJson,
  settings: Settings,
): Promise<string> {
  const sessionId = stdin.session_id;

  // Check cache first (hot path)
  const cached = checkCache(settings.cache?.statuslineTtlMs ?? 5000, sessionId);
  if (cached !== null) {
    // Fresh stdin carries an updated cumulative cost even when the rendered
    // output is served from cache — persist it so daily accounting never
    // misses the final invocations of a session. In "calculated" mode the
    // tracker is fed JSONL-derived costs by the pipeline instead; mixing in
    // stdin costs here would corrupt its restart detection.
    const stdinCost = stdin.cost?.total_cost_usd;
    if (stdinCost !== undefined && settings.costSource !== "calculated") {
      trackDailyCost(sessionId, stdinCost);
    }
    return cached;
  }

  const context = await buildRenderContext(stdin, settings);
  const output = renderStatusline(context, settings);

  writeCache(output, sessionId);
  return output;
}
