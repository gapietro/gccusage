import type { Settings } from "./schema.js";

export const DEFAULT_SETTINGS: Settings = {
  lines: [
    {
      widgets: [
        { type: "model", fg: "#ffffff", bg: "#1a5fb4", priority: 1 },
        { type: "session-cost", fg: "#ffffff", bg: "#26a269", priority: 2 },
        { type: "context-percent", fg: "#ffffff", bg: "#0d7377", priority: 3 },
        { type: "burn-rate", fg: "#ffffff", bg: "#555555", priority: 7 },
        { type: "cache-hit-rate", fg: "#ffffff", bg: "#1a5fb4", priority: 8 },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "git-branch", fg: "#ffffff", bg: "#613583", priority: 4 },
        { type: "git-changes", fg: "#ffffff", bg: "#613583", priority: 9 },
        { type: "lines-changed", fg: "#ffffff", bg: "#0d7377", priority: 10 },
        { type: "today-spend", fg: "#ffffff", bg: "#26a269", priority: 5 },
        { type: "api-latency", fg: "#ffffff", bg: "#555555", priority: 6 },
        { type: "vim-mode" },
      ],
      flex: "left",
    },
  ],
  powerline: {
    enabled: true,
    theme: "default",
    separator: "\u25B6",
    separatorThin: "\u2502",
  },
  compact: {
    mode: "auto",
    threshold: 80,
  },
  alerts: {
    sessionWarn: 5,
    sessionDanger: 15,
    dailyWarn: 10,
    dailyDanger: 25,
  },
  cache: {
    statuslineTtlMs: 5000,
    pricingTtlMs: 86400000,
  },
  costSource: "auto",
};
