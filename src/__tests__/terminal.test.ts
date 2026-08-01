import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTerminalWidth } from "../utils/terminal.js";

// process.stdout.columns exists only on a tty.WriteStream. Under vitest stdout
// is a pipe, so there is usually no own property at all — capture whatever is
// there and put it back exactly, rather than assuming either shape.
const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
let originalEnvColumns: string | undefined;

function setStdoutColumns(value: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  originalEnvColumns = process.env["COLUMNS"];
  delete process.env["COLUMNS"];
  setStdoutColumns(undefined);
});

afterEach(() => {
  if (originalColumns) Object.defineProperty(process.stdout, "columns", originalColumns);
  else delete (process.stdout as { columns?: number }).columns;
  if (originalEnvColumns === undefined) delete process.env["COLUMNS"];
  else process.env["COLUMNS"] = originalEnvColumns;
});

describe("getTerminalWidth", () => {
  it("uses a live TTY width when stdout is a terminal", () => {
    setStdoutColumns(137);
    expect(getTerminalWidth()).toBe(137);
  });

  it("prefers the live TTY width over a stale exported COLUMNS", () => {
    setStdoutColumns(137);
    process.env["COLUMNS"] = "80";
    expect(getTerminalWidth()).toBe(137);
  });

  it("falls back to COLUMNS when stdout is a pipe", () => {
    process.env["COLUMNS"] = "212";
    expect(getTerminalWidth()).toBe(212);
  });

  it("is undefined when neither source is available", () => {
    expect(getTerminalWidth()).toBeUndefined();
  });

  it.each(["0", "-5", "abc", "", "80.5"])(
    "treats the malformed COLUMNS value %j as unknown",
    (value) => {
      process.env["COLUMNS"] = value;
      expect(getTerminalWidth()).toBeUndefined();
    },
  );
});
