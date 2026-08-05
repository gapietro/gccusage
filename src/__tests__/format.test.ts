import { describe, it, expect } from "vitest";
import {
  formatDollars,
  formatTokens,
  formatDuration,
  formatPercent,
  formatModelName,
  formatCostPerHour,
} from "../utils/format.js";

describe("formatDollars", () => {
  it("formats zero", () => {
    expect(formatDollars(0)).toBe("$0.00");
  });

  it("formats small amounts", () => {
    expect(formatDollars(0.05)).toBe("$0.05");
  });

  it("formats normal amounts", () => {
    expect(formatDollars(2.45)).toBe("$2.45");
  });

  it("formats large amounts", () => {
    expect(formatDollars(150.5)).toBe("$151");
  });

  // A non-finite amount reaches this function straight from stdin, with no
  // schema in between to reject it (see the comment on formatDollars). "$0.00"
  // would be a silent lie — it claims a known, zero cost — so the guard must
  // render something that says "unknown" instead.
  describe("non-finite amounts (#131)", () => {
    it("renders Infinity as an uncertainty marker, not the literal string", () => {
      expect(formatDollars(Infinity)).toBe("$?");
    });

    it("renders -Infinity as the same marker", () => {
      expect(formatDollars(-Infinity)).toBe("$?");
    });

    it("renders NaN as the same marker", () => {
      expect(formatDollars(NaN)).toBe("$?");
    });
  });
});

describe("formatTokens", () => {
  it("formats small counts", () => {
    expect(formatTokens(500)).toBe("500");
  });

  it("formats thousands", () => {
    expect(formatTokens(42500)).toBe("42.5k");
  });

  it("formats millions", () => {
    expect(formatTokens(1500000)).toBe("1.50M");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(194000)).toBe("3m 14s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(12120000)).toBe("3hr 22m");
  });
});

describe("formatPercent", () => {
  it("formats ratio", () => {
    expect(formatPercent(0.45)).toBe("45%");
  });
});

describe("formatModelName", () => {
  it("formats Sonnet", () => {
    expect(formatModelName("claude-sonnet-4-20250514")).toBe("Sonnet 4");
  });

  it("formats Opus", () => {
    expect(formatModelName("claude-opus-4-20250514")).toBe("Opus 4");
  });

  it("formats Opus 4.6 (dash-separated minor version)", () => {
    expect(formatModelName("claude-opus-4-6-20250219")).toBe("Opus 4.6");
  });

  it("formats Sonnet 4.6 (dash-separated minor version)", () => {
    expect(formatModelName("claude-sonnet-4-6-20250219")).toBe("Sonnet 4.6");
  });

  it("formats Haiku 4.5 (dash-separated minor version)", () => {
    expect(formatModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("formats Haiku 3.5 (dot-separated minor version)", () => {
    expect(formatModelName("claude-haiku-3.5-20241001")).toBe("Haiku 3.5");
  });

  it("returns raw for unknown", () => {
    expect(formatModelName("gpt-4")).toBe("gpt-4");
  });
});

describe("formatCostPerHour", () => {
  it("formats a sub-cent rate as zero rather than a misleading fraction", () => {
    expect(formatCostPerHour(0.004)).toBe("$0.00/hr");
  });

  it("formats a rate under a dollar to cents", () => {
    expect(formatCostPerHour(0.42)).toBe("$0.42/hr");
  });

  it("formats a typical rate to cents", () => {
    expect(formatCostPerHour(4.2)).toBe("$4.20/hr");
  });

  it("drops the cents on large rates to save bar width", () => {
    expect(formatCostPerHour(120.5)).toBe("$121/hr");
  });

  // Same non-finite hazard as formatDollars, reachable via burn-rate's own
  // division (costUsd / elapsedMinutes) rather than through formatDollars.
  describe("non-finite rates (#131)", () => {
    it("renders Infinity as an uncertainty marker, not the literal string", () => {
      expect(formatCostPerHour(Infinity)).toBe("$?/hr");
    });

    it("renders -Infinity as the same marker", () => {
      expect(formatCostPerHour(-Infinity)).toBe("$?/hr");
    });

    it("renders NaN as the same marker", () => {
      expect(formatCostPerHour(NaN)).toBe("$?/hr");
    });
  });
});
