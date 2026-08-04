import { defineConfig } from "vitest/config";
import { TYPE_ONLY_FILES } from "./src/__tests__/fixtures/type-only-files.js";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "scripts/**/__tests__/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      // TYPE_ONLY_FILES emit no JavaScript, so v8 scores them 0% and they
      // would fail the per-file threshold below. See that file for why the
      // list is enumerated rather than globbed, and which test guards it.
      exclude: ["src/**/__tests__/**", ...TYPE_ONLY_FILES],
      // The audit's bar (#95): coverage was 87.78% overall but collapsed at
      // the I/O boundaries, and every correctness defect it found lived in a
      // file on the low-coverage list. A global average cannot express that,
      // so the threshold is per-file — a floor against a new blind spot, not
      // a target. The suite currently sits far above it.
      thresholds: {
        perFile: true,
        statements: 70,
      },
    },
  },
});
