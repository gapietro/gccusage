import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node18",
  clean: true,
  outputOptions: { banner: "#!/usr/bin/env node" },
  shims: true,
  noExternal: [/.*/],
});
