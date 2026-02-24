import type { Widget } from "./base.js";
import { modelWidget } from "./model.js";
import { sessionCostWidget } from "./session-cost.js";
import { todaySpendWidget } from "./today-spend.js";
import { blockTimerWidget } from "./block-timer.js";
import { burnRateWidget } from "./burn-rate.js";
import { contextPercentWidget } from "./context-percent.js";
import { gitBranchWidget } from "./git-branch.js";
import { gitChangesWidget } from "./git-changes.js";
import { tokensInputWidget } from "./tokens-input.js";
import { tokensOutputWidget } from "./tokens-output.js";
import { tokensCachedWidget } from "./tokens-cached.js";
import { perModelBreakdownWidget } from "./per-model-breakdown.js";
import { sessionClockWidget } from "./session-clock.js";
import { cwdWidget } from "./cwd.js";
import { customTextWidget } from "./custom-text.js";
import { customCommandWidget } from "./custom-command.js";
import { separatorWidget } from "./separator.js";
import { cacheHitRateWidget } from "./cache-hit-rate.js";
import { linesChangedWidget } from "./lines-changed.js";
import { vimModeWidget } from "./vim-mode.js";
import { apiLatencyWidget } from "./api-latency.js";
import { tokenBreakdownWidget } from "./token-breakdown.js";
import { sessionTimerWidget } from "./session-timer.js";

const WIDGET_MAP: Record<string, Widget> = {
  model: modelWidget,
  "session-cost": sessionCostWidget,
  "today-spend": todaySpendWidget,
  "block-timer": blockTimerWidget,
  "burn-rate": burnRateWidget,
  "context-percent": contextPercentWidget,
  "git-branch": gitBranchWidget,
  "git-changes": gitChangesWidget,
  "tokens-input": tokensInputWidget,
  "tokens-output": tokensOutputWidget,
  "tokens-cached": tokensCachedWidget,
  "per-model": perModelBreakdownWidget,
  "session-clock": sessionClockWidget,
  cwd: cwdWidget,
  "custom-text": customTextWidget,
  "custom-command": customCommandWidget,
  separator: separatorWidget,
  "cache-hit-rate": cacheHitRateWidget,
  "lines-changed": linesChangedWidget,
  "vim-mode": vimModeWidget,
  "api-latency": apiLatencyWidget,
  "token-breakdown": tokenBreakdownWidget,
  "session-timer": sessionTimerWidget,
};

export function getWidget(type: string): Widget | null {
  return WIDGET_MAP[type] ?? null;
}

export function getWidgetTypes(): string[] {
  return Object.keys(WIDGET_MAP);
}
