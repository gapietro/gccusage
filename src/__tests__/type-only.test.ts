import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TYPE_ONLY_FILES } from "./fixtures/type-only-files.js";

/**
 * Guards the coverage exclusion list.
 *
 * `TYPE_ONLY_FILES` exists because v8 scores a file with no executable
 * statements as 0%, which would fail the per-file threshold for a file that
 * cannot be tested. That is a legitimate exclusion and also an obvious hiding
 * place: adding a line to it is all it takes to make untested production code
 * stop counting. So each entry has to prove it emits nothing (#95).
 *
 * The transpile here is `tsc`'s own, not a regex over the source: a file that
 * looks type-only is not the question, a file that COMPILES to nothing is.
 * An `enum`, a parameter property, or a `namespace` all read as type syntax
 * and all emit runtime code.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

/** The JavaScript a file compiles to, minus the empty-module marker. */
function emittedJs(relPath: string): string {
  const source = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
  return ts
    .transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/export\s*\{\s*\};?/g, "")
    .trim();
}

describe("coverage exclusions", () => {
  it.each(TYPE_ONLY_FILES)("%s exists", (relPath) => {
    // A stale path would exclude nothing and be invisible: coverage does not
    // complain about an exclude glob that matches no file.
    expect(fs.existsSync(path.join(REPO_ROOT, relPath))).toBe(true);
  });

  it.each(TYPE_ONLY_FILES)("%s emits no JavaScript", (relPath) => {
    expect(emittedJs(relPath)).toBe("");
  });

  it("would reject a file carrying runtime code", () => {
    // Proves the check above can fail. `block-metrics.ts` sits in src/types/
    // beside four genuinely type-only files and exports a real constant —
    // which is why the exclusion is a file list and not `src/types/**`.
    expect(emittedJs("src/types/block-metrics.ts")).not.toBe("");
  });
});
