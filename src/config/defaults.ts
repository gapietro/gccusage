import type { Settings } from "./schema.js";

export const DEFAULT_SETTINGS: Settings = {
  lines: [
    {
      widgets: [
        { type: "model", fg: "#ffffff", bg: "#1a5fb4" },
        { type: "session-cost", fg: "#ffffff", bg: "#26a269" },
        { type: "context-percent", fg: "#ffffff", bg: "#0d7377" },
        { type: "burn-rate", fg: "#ffffff", bg: "#555555" },
        { type: "cache-hit-rate", fg: "#ffffff", bg: "#1a5fb4" },
      ],
      flex: "left",
    },
    {
      widgets: [
        { type: "git-branch", fg: "#ffffff", bg: "#613583" },
        { type: "git-changes", fg: "#ffffff", bg: "#613583" },
        { type: "lines-changed", fg: "#ffffff", bg: "#0d7377" },
        { type: "today-spend", fg: "#ffffff", bg: "#26a269" },
        { type: "api-latency", fg: "#ffffff", bg: "#555555" },
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
  cache: {
    statuslineTtlMs: 5000,
    pricingTtlMs: 86400000,
  },
  costSource: "auto",
};
