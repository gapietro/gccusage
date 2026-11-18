import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  // tsdown 0.23 defaults ESM output to .mjs; setup, postbuild and bundle-drift
  // all name dist/index.js.
  fixedExtension: false,
  outputOptions: { banner: "#!/usr/bin/env node" },
  shims: true,
  noExternal: [/.*/],
});
