# `gccusage setup` Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gccusage setup` write an interpreter path that survives a Node upgrade, refuse an unusable `~/.claude/settings.json` instead of silently doing nothing, and never leave that file torn or un-backed-up.

**Architecture:** One new pure module (`src/utils/node-path.ts`) resolves a non-version-scoped Node path by scanning `PATH`, with an injectable probe so it is testable without a real Homebrew tree. `writeFileAtomic` is lifted out of the existing `writeJsonAtomic` so `runSetup` gets temp-file-plus-rename semantics while keeping settings.json human-readable. `runSetup` gains a validate-then-back-up-then-write ordering, and `src/index.ts` scopes its exit-0 graceful degradation to statusline mode so CLI failures surface.

**Tech Stack:** TypeScript, ESM, tsdown bundler, vitest, valibot (not needed here — settings.json shape checking is a three-clause predicate, not a schema).

**Spec:** `docs/superpowers/specs/2026-08-02-setup-cluster-design.md`
**Issues:** #90, #88, #89, #105
**Branch:** `setup-robustness` (already exists, spec committed at `5216eef`)

## Global Constraints

- **Rebuild the bundle in every commit that touches `src/`:** `npm run build` then `git add -f dist/index.js`. `dist/index.js` is gitignored but force-tracked; `gccusage setup` points `statusLine.command` at it, so a src-only commit leaves `git pull` upgraders on old code. CI's `bundle-drift` job fails the PR otherwise.
- **No new dependencies.** Everything here uses `node:fs`, `node:path`, `node:os`.
- **Node floor is `>=22`** after Task 5. Do not use APIs newer than that.
- **Every test must fail when the change it guards is reverted.** A test that passes against the old code is a defect in the test, not a bonus. See `docs/` memory on vacuous tests.
- **Error message format**, used verbatim in Task 3: `` `${settingsPath} <problem>. Fix or move it, then re-run \`gccusage setup\`.` `` — the caller in `src/index.ts` adds the `gccusage: ` prefix.
- **Backup path is `${settingsPath}.bak`** — the same name the current unparseable-file path already uses.
- **`AUDIT.md` is deliberately untracked. Never `git add` it.** Check `git status --short` before every commit.

---

### Task 1: `writeFileAtomic` primitive

Lift the temp-file-plus-rename body out of `writeJsonAtomic` so a caller can write pre-formatted text atomically. `runSetup` (Task 3) needs 2-space-indented JSON with a trailing newline, because settings.json is a file the user reads and edits.

**Files:**
- Modify: `src/utils/atomic-json.ts:20-38`
- Test: `src/__tests__/atomic-json.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `writeFileAtomic(filePath: string, contents: string): void` — throws on failure, creates the parent directory, leaves no temp file behind. Task 3 uses it twice.

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/atomic-json.test.ts`, after the existing `writeJsonAtomic` describe block. Note the import on line 6 must gain `writeFileAtomic`.

```ts
describe("writeFileAtomic", () => {
  it("writes the exact bytes given, with no JSON encoding", () => {
    const target = path.join(tmpDir, "settings.json");
    const contents = '{\n  "model": "opus"\n}\n';

    writeFileAtomic(target, contents);

    expect(fs.readFileSync(target, "utf-8")).toBe(contents);
  });

  it("creates the parent directory when it does not exist", () => {
    const target = path.join(tmpDir, "nested", "deeper", "settings.json");
    writeFileAtomic(target, "hello");
    expect(fs.readFileSync(target, "utf-8")).toBe("hello");
  });

  it("leaves no temporary file behind on success", () => {
    const target = path.join(tmpDir, "settings.json");
    writeFileAtomic(target, "hello");
    expect(siblings(tmpDir)).toEqual(["settings.json"]);
  });

  it("removes the temporary file and rethrows when the rename fails", () => {
    // A directory at the target path makes renameSync fail after the temp
    // file has already been written — the one path that can leak a temp file.
    const target = path.join(tmpDir, "settings.json");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "occupant"), "keeps the directory non-empty");

    expect(() => writeFileAtomic(target, "hello")).toThrow();
    expect(siblings(tmpDir)).toEqual(["settings.json"]);
  });
});
```

Change line 6 of the same file to:

```ts
import { writeJsonAtomic, writeFileAtomic, readJsonValidated } from "../utils/atomic-json.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/atomic-json.test.ts`
Expected: FAIL — `writeFileAtomic is not a function` (or a TypeScript/import resolution error naming it).

- [ ] **Step 3: Implement**

In `src/utils/atomic-json.ts`, replace the body of `writeJsonAtomic` (lines 20-38) with:

```ts
export function writeFileAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmpPath = `${filePath}.${process.pid}.${counter++}.tmp`;

  fs.writeFileSync(tmpPath, contents, "utf-8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing more to do; the rename failure is the error that matters.
    }
    throw err;
  }
}

/**
 * Write JSON to `filePath` so that readers see either the previous contents
 * or the new ones, never a partial file: serialise into a uniquely named
 * sibling, then rename it over the target. Same directory means same
 * filesystem, which is what makes the rename atomic.
 *
 * Throws on failure; callers keep whatever error posture they already have.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(data));
}
```

Add a doc comment above `writeFileAtomic`:

```ts
/**
 * The same atomicity guarantee as `writeJsonAtomic`, for content that is
 * already a string. `gccusage setup` needs this: `~/.claude/settings.json` is
 * a file the user reads and edits, so it keeps its 2-space indentation and
 * trailing newline rather than the compact encoding `writeJsonAtomic` emits.
 */
```

Leave the module-level `counter` comment (lines 6-10) exactly where it is — it now documents a shared counter, which is still correct.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/atomic-json.test.ts`
Expected: PASS, including all six pre-existing `writeJsonAtomic` tests — the refactor must not change their behaviour.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
npm run build
git status --short          # confirm AUDIT.md is NOT staged
git add src/utils/atomic-json.ts src/__tests__/atomic-json.test.ts
git add -f dist/index.js
git commit -m "Extract writeFileAtomic so a caller can write formatted text atomically"
```

---

### Task 2: `resolveStableNodePath`

The core of #90. Given the running interpreter, find an equivalent path that a Node upgrade will not delete.

**Files:**
- Create: `src/utils/node-path.ts`
- Test: `src/__tests__/node-path.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `versionSegment(p: string): string | null`
  - `interface NodePathProbe { execPath: string; pathEntries: string[]; realpath(p: string): string }`
  - `resolveStableNodePath(probe?: NodePathProbe): { path: string; warning?: string }`

  Task 3 calls `resolveStableNodePath()` with no argument and uses both fields.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/node-path.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  versionSegment,
  resolveStableNodePath,
  type NodePathProbe,
} from "../utils/node-path.js";

const CELLAR = "/opt/homebrew/Cellar/node/26.5.0_1/bin/node";

/** A probe backed by a fixed symlink table; realpath throws for absent paths. */
function probe(
  execPath: string,
  links: Record<string, string>,
  pathEntries: string[],
): NodePathProbe {
  return {
    execPath,
    pathEntries,
    realpath: (p: string) => {
      const resolved = links[p];
      if (resolved === undefined) throw new Error(`ENOENT: ${p}`);
      return resolved;
    },
  };
}

describe("versionSegment", () => {
  it.each([
    [CELLAR, "26.5.0_1"],
    ["/opt/homebrew/Cellar/node@22/22.1.0/bin/node", "22.1.0"],
    ["/Users/x/.nvm/versions/node/v22.1.0/bin/node", "v22.1.0"],
    ["/Users/x/.nodenv/versions/22.1.0/bin/node", "22.1.0"],
    ["/Users/x/.volta/tools/image/node/22.1.0/bin/node", "22.1.0"],
  ])("finds the expiring segment in %s", (input, expected) => {
    expect(versionSegment(input)).toBe(expected);
  });

  it.each([
    "/usr/bin/node",
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    // Homebrew's per-major symlink is stable: brew re-points it on upgrade.
    "/opt/homebrew/opt/node@22/bin/node",
  ])("finds none in %s", (input) => {
    expect(versionSegment(input)).toBeNull();
  });
});

describe("resolveStableNodePath", () => {
  // The #90 regression test: process.execPath reports the Cellar path because
  // Node resolves symlinks, and brew upgrade deletes exactly that directory.
  it("prefers the Homebrew symlink over the Cellar path execPath reports", () => {
    const result = resolveStableNodePath(
      probe(
        CELLAR,
        { [CELLAR]: CELLAR, "/opt/homebrew/bin/node": CELLAR },
        ["/opt/homebrew/bin", "/usr/bin"],
      ),
    );

    expect(result).toEqual({ path: "/opt/homebrew/bin/node" });
  });

  it("keeps execPath and warns when every candidate is version-scoped", () => {
    const NVM = "/Users/x/.nvm/versions/node/v22.1.0/bin/node";

    const result = resolveStableNodePath(
      probe(NVM, { [NVM]: NVM }, ["/Users/x/.nvm/versions/node/v22.1.0/bin", "/usr/bin"]),
    );

    expect(result.path).toBe(NVM);
    expect(result.warning).toContain("v22.1.0");
  });

  it("returns an already-stable execPath without probing PATH at all", () => {
    const result = resolveStableNodePath({
      execPath: "/usr/bin/node",
      pathEntries: ["/usr/bin", "/opt/homebrew/bin"],
      realpath: () => {
        throw new Error("realpath must not be called for a stable execPath");
      },
    });

    expect(result).toEqual({ path: "/usr/bin/node" });
  });

  it("ignores a PATH entry that resolves to a different binary", () => {
    const result = resolveStableNodePath(
      probe(
        CELLAR,
        { [CELLAR]: CELLAR, "/usr/local/bin/node": "/usr/local/Cellar/node/18.0.0/bin/node" },
        ["/usr/local/bin"],
      ),
    );

    expect(result.path).toBe(CELLAR);
    expect(result.warning).toContain("26.5.0_1");
  });

  it("warns when the running binary can no longer be resolved", () => {
    // realpath(execPath) throws: there is nothing to compare candidates
    // against, so guessing at a replacement would be worse than saying so.
    const result = resolveStableNodePath(
      probe(CELLAR, { "/opt/homebrew/bin/node": CELLAR }, ["/opt/homebrew/bin"]),
    );

    expect(result.path).toBe(CELLAR);
    expect(result.warning).toContain("26.5.0_1");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/node-path.test.ts`
Expected: FAIL — cannot resolve `../utils/node-path.js`.

- [ ] **Step 3: Implement**

Create `src/utils/node-path.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A path segment naming a specific Node version — the thing that makes an
 * interpreter path expire. Homebrew's Cellar, nvm, nodenv, fnm and volta all
 * encode the version this way, so one pattern covers every layout that has
 * the problem. Homebrew's per-major symlink (`opt/node@22/bin/node`) is
 * deliberately not matched: brew re-points it on upgrade, so it is stable.
 */
const VERSION_SEGMENT = /\/(v?\d+\.\d+\.\d+[^/]*)/;

export function versionSegment(p: string): string | null {
  return VERSION_SEGMENT.exec(p)?.[1] ?? null;
}

export interface NodePathProbe {
  execPath: string;
  pathEntries: string[];
  /** Resolves symlinks; throws if the path does not exist. */
  realpath(p: string): string;
}

function defaultProbe(): NodePathProbe {
  return {
    execPath: process.execPath,
    pathEntries: (process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter((entry) => entry.length > 0),
    realpath: (p: string) => fs.realpathSync(p),
  };
}

function versionWarning(version: string): string {
  return (
    `Warning: this Node path contains a version (${version}) and will stop ` +
    "working when that version is removed. Re-run `gccusage setup` after " +
    "upgrading Node."
  );
}

/**
 * The interpreter path to persist in `statusLine.command`.
 *
 * `process.execPath` is the obvious choice and the wrong one: Node resolves
 * symlinks for it, so on Homebrew it reports the Cellar path that the next
 * `brew upgrade node` deletes, silently breaking the statusline (#90). Bare
 * `node` was the alternative considered and rejected — Claude Code also runs
 * as a desktop app, which may spawn with a minimal PATH that omits
 * `/opt/homebrew/bin`.
 */
export function resolveStableNodePath(
  probe: NodePathProbe = defaultProbe(),
): { path: string; warning?: string } {
  const version = versionSegment(probe.execPath);

  // Already stable (/usr/bin/node, /usr/local/bin/node): nothing to look up.
  if (version === null) return { path: probe.execPath };

  let target: string;
  try {
    target = probe.realpath(probe.execPath);
  } catch {
    return { path: probe.execPath, warning: versionWarning(version) };
  }

  // PATH order is the tie-break: the user's own precedence is more defensible
  // than any ranking we invent, and every candidate resolving to `target` is
  // equally correct.
  for (const dir of probe.pathEntries) {
    const candidate = path.join(dir, "node");
    if (versionSegment(candidate) !== null) continue;

    let resolved: string;
    try {
      resolved = probe.realpath(candidate);
    } catch {
      continue;
    }

    if (resolved === target) return { path: candidate };
  }

  return { path: probe.execPath, warning: versionWarning(version) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/node-path.test.ts`
Expected: PASS, 14 assertions across 7 tests.

- [ ] **Step 5: Verify the tests are not vacuous**

Temporarily change the first line of `resolveStableNodePath`'s body to `return { path: probe.execPath };` and re-run. Expected: the "prefers the Homebrew symlink" test FAILS. Revert the sabotage.

This is the repo's standing rule — a test that passes against the old code guards nothing.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
npm run build
git status --short          # confirm AUDIT.md is NOT staged
git add src/utils/node-path.ts src/__tests__/node-path.test.ts
git add -f dist/index.js
git commit -m "Resolve a Node path that survives an upgrade (#90)"
```

---

### Task 3: `runSetup` — validate, back up, write atomically

Rewrites the body of `runSetup` to fix #88's first half, #89, and to consume Task 2.

**Files:**
- Modify: `src/cli.ts:7` (imports), `src/cli.ts:85-124` (`runSetup`)
- Test: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` (Task 1), `resolveStableNodePath` (Task 2).
- Produces: `runSetup` now **throws** `Error` instead of returning on a bad settings file. Task 4 catches it. `buildStatusLineCommand` and `shellQuote` are unchanged and stay exported.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/cli.test.ts`. The `HOME`-into-a-tmpdir pattern matches the existing `gccusage today` block; `os.homedir()` honours `$HOME` on POSIX, which is what makes it work.

```ts
describe("gccusage setup", () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const settingsPath = (): string => path.join(tmpDir, ".claude", "settings.json");
  const backupPath = (): string => `${settingsPath()}.bak`;
  const read = (p: string): string => fs.readFileSync(p, "utf8");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-setup-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;
    fs.mkdirSync(path.join(tmpDir, ".claude"), { recursive: true });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds statusLine without disturbing unrelated keys", async () => {
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ model: "opus", permissions: { allow: ["Bash"] } }),
    );

    await runCli(["setup"]);

    const after = JSON.parse(read(settingsPath()));
    expect(after.model).toBe("opus");
    expect(after.permissions).toEqual({ allow: ["Bash"] });
    expect(after.statusLine.type).toBe("command");
    expect(after.statusLine.command).toContain("index.js");
  });

  it("writes a backup holding the exact pre-setup bytes", async () => {
    const before = '{\n  "model": "opus"\n}\n';
    fs.writeFileSync(settingsPath(), before);

    await runCli(["setup"]);

    expect(read(backupPath())).toBe(before);
  });

  it("writes settings.json as indented JSON with a trailing newline", async () => {
    await runCli(["setup"]);

    const raw = read(settingsPath());
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "statusLine"');
  });

  it("creates settings.json when none exists, and takes no backup", async () => {
    await runCli(["setup"]);

    expect(JSON.parse(read(settingsPath())).statusLine.type).toBe("command");
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  // #88: each of these previously exited 0 having written nothing (null,
  // scalar) or having silently dropped statusLine (array).
  it.each([
    ["a null document", "null", "not a JSON object"],
    ["a bare string", '"oops"', "not a JSON object"],
    ["an array root", "[]", "not a JSON object"],
    ["malformed JSON", "{oops", "not valid JSON"],
  ])("refuses %s and changes nothing", async (_label, contents, expectedMessage) => {
    fs.writeFileSync(settingsPath(), contents);

    await expect(runCli(["setup"])).rejects.toThrow(expectedMessage);

    expect(read(settingsPath())).toBe(contents);
    expect(fs.existsSync(backupPath())).toBe(false);
  });

  it("names the offending file and how to recover", async () => {
    fs.writeFileSync(settingsPath(), "null");

    await expect(runCli(["setup"])).rejects.toThrow(settingsPath());
    await expect(runCli(["setup"])).rejects.toThrow("re-run `gccusage setup`");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: FAIL. The backup test fails (no `.bak` on the success path). The four refusal cases fail — `null` and `"oops"` reject with a `TypeError` rather than the expected message, and `[]` and `{oops` do not reject at all.

- [ ] **Step 3: Implement**

In `src/cli.ts`, change the imports on lines 7-10 to:

```ts
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./utils/atomic-json.js";
import { resolveStableNodePath } from "./utils/node-path.js";
```

(`writeFileSync` and `mkdirSync` are no longer used: `writeFileAtomic` creates the parent directory itself via `ensureDir`.)

Replace `runSetup` (lines 85-124) with:

```ts
const FIX_HINT = "Fix or move it, then re-run `gccusage setup`.";

function describeNonObject(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a JSON array";
  return `a JSON ${typeof value}`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The user's settings, plus the bytes they came from, or null when the file
 * does not exist yet.
 *
 * Anything we cannot read as a JSON object is refused rather than replaced.
 * This file holds the user's permissions, hooks, MCP servers and model
 * selection; a convenience command has no business overwriting it with
 * `{statusLine}` on the strength of a `.bak` the user does not know exists
 * (#88). Note that an array root does not throw on assignment — it silently
 * loses the key at `JSON.stringify` — so it must be rejected explicitly.
 */
function readExistingSettings(
  settingsPath: string,
): { settings: Record<string, unknown>; raw: string } | null {
  if (!existsSync(settingsPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    throw new Error(`${settingsPath} could not be read (${messageOf(err)}). ${FIX_HINT}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON (${messageOf(err)}). ${FIX_HINT}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${settingsPath} contains ${describeNonObject(parsed)}, not a JSON object. ${FIX_HINT}`,
    );
  }

  return { settings: parsed as Record<string, unknown>, raw };
}

function runSetup(): void {
  // Resolve the absolute path to this script's dist/index.js
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
  const settingsPath = resolve(homedir(), ".claude", "settings.json");

  // Validate before writing anything at all: a refused file leaves no .bak
  // and no partial write.
  const existing = readExistingSettings(settingsPath);
  const settings = existing?.settings ?? {};

  // The backup is for the success path — the common case, and the one that
  // previously got none (#89).
  if (existing) writeFileAtomic(`${settingsPath}.bak`, existing.raw);

  const node = resolveStableNodePath();
  const command = buildStatusLineCommand(node.path, scriptPath);
  settings["statusLine"] = { type: "command", command };

  // Indented with a trailing newline: this is a file the user reads and edits.
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log("gccusage setup complete!\n");
  console.log(`  Settings: ${settingsPath}`);
  console.log(`  Command:  ${command}`);
  if (existing) console.log(`  Backup:   ${settingsPath}.bak`);
  console.log();
  if (node.warning) console.log(`${node.warning}\n`);
  console.log("Restart Claude Code to activate the statusline.");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/cli.test.ts`
Expected: PASS — the two pre-existing `gccusage today` tests, the two `shellQuote`/`buildStatusLineCommand` tests, and all ten new ones.

- [ ] **Step 5: Verify the refusal tests are not vacuous**

Temporarily delete the `Array.isArray(parsed)` clause from the shape check and re-run. Expected: the `"an array root"` case FAILS. Revert.

Then temporarily move the `writeFileAtomic(\`${settingsPath}.bak\`, ...)` line above the `readExistingSettings` call (not literally executable as written — `existing.raw` is referenced before `existing` is defined; do the equivalent by reordering to back up before validating, e.g. read the raw file and write the `.bak` first, then validate/parse it). Expected: the refusal cases FAIL on the `.bak` assertion. Revert.

- [ ] **Step 6: Run the whole suite, typecheck, commit**

```bash
npm test
npm run typecheck
npm run build
git status --short          # confirm AUDIT.md is NOT staged
git add src/cli.ts src/__tests__/cli.test.ts
git add -f dist/index.js
git commit -m "Refuse an unusable settings.json instead of silently doing nothing (#88, #89)"
```

---

### Task 4: Scope graceful degradation to statusline mode

#88's second half. `main().catch(() => process.exit(0))` is right for the statusline — never break the user's prompt — and wrong for every CLI subcommand, where it turns a thrown error into a silent success.

**Files:**
- Modify: `src/index.ts:10-13`
- Test: Create `src/__tests__/cli-exit-code.test.ts`

**Interfaces:**
- Consumes: `runSetup`'s throwing behaviour (Task 3).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/cli-exit-code.test.ts`. This must be a real spawn: exit codes are a process-level property, and `statusline-width.test.ts` sets the precedent of exec'ing the built bundle for exactly this reason.

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// package.json sets "type": "module", so __dirname does not exist here.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../../dist/index.js");
const distExists = fs.existsSync(DIST);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gccusage-exit-"));
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runSetupProcess(): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [DIST, "setup"], {
    env: { ...process.env, HOME: dir },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

describe.skipIf(!distExists)("gccusage setup exit code", () => {
  // Before the fix this exited 0 having printed nothing and changed nothing:
  // the throw was swallowed by main().catch(() => process.exit(0)), which is
  // graceful degradation meant for statusline mode only (#88).
  it("exits non-zero and explains itself on an unusable settings.json", () => {
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), "null");

    const { status, stderr } = runSetupProcess();

    expect(status).toBe(1);
    expect(stderr).toContain("not a JSON object");
    expect(stderr).toContain("gccusage:");
  });

  it("still exits 0 on the success path", () => {
    const { status, stdout } = runSetupProcess();

    expect(status).toBe(0);
    expect(stdout).toContain("setup complete");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run src/__tests__/cli-exit-code.test.ts`
Expected: the first test FAILS with `expected 0 to be 1` — Task 3 made `runSetup` throw, but `src/index.ts` still converts that into exit 0. The second test passes already; that is not a guard against over-correcting (wrapping all of `main()` in the same try/catch would still pass it unchanged). What it actually covers is the only real-spawn coverage of the setup success path against the shipped bundle: it fails on a load crash, on bundling-only breakage that unit tests against source cannot see, or if the exit(1) path became unconditional and started firing on success too.

Note the `npm run build` — this test reads `dist/index.js`, so the bundle must be current for the test to mean anything.

- [ ] **Step 3: Implement**

In `src/index.ts`, replace lines 10-13:

```ts
  if (args.length > 0) {
    await runCli(args);
    return;
  }
```

with:

```ts
  if (args.length > 0) {
    // A CLI failure must be visible. The blanket catch below is graceful
    // degradation for statusline mode — never break the user's prompt — and
    // applying it here turned `setup` into a command that reported success
    // having done nothing (#88).
    try {
      await runCli(args);
    } catch (err) {
      console.error(`gccusage: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }
```

Leave `main().catch(() => process.exit(0))` at lines 47-50 **byte-for-byte unmodified**. The scoping is structural — the new catch sits inside the `args.length > 0` branch — and that is what a reviewer checks in the diff.

- [ ] **Step 4: Rebuild and run the test to verify it passes**

Run: `npm run build && npx vitest run src/__tests__/cli-exit-code.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
npm test
npm run typecheck
git status --short          # confirm AUDIT.md is NOT staged
git add src/index.ts src/__tests__/cli-exit-code.test.ts
git add -f dist/index.js
git commit -m "Let CLI failures surface instead of exiting 0 (#88)"
```

---

### Task 5: One supported Node version

#105. `engines.node: ">=18"` is contradicted by `devEngines` (`>=23.6.0`), unexercised by CI (22 and 24), and impossible for `scripts/*.ts`, which Node runs directly and which need native type stripping.

**Files:**
- Modify: `package.json` (`engines`, `devEngines`)
- Modify: `tsdown.config.ts:6`
- Modify: `.github/workflows/ci.yml:40-43` (the matrix comment)
- Test: none — this is metadata; CI's existing 22/24 matrix is the test.

**Interfaces:**
- Consumes: nothing. Produces: nothing.

- [ ] **Step 1: Update `package.json`**

Change:

```json
  "engines": {
    "node": ">=22"
  },
  "devEngines": {
    "runtime": {
      "name": "node",
      "version": ">=22.18.0",
      "onFail": "warn"
    }
  }
```

`22.18` is the real threshold — the release where type stripping runs unflagged, which is what `node scripts/build-badge.ts` needs. `>=23.6.0` was stricter than reality.

- [ ] **Step 2: Update `tsdown.config.ts`**

Change line 6 from `target: "node18",` to `target: "node22",`. The bundle should not advertise a floor nothing exercises either.

- [ ] **Step 3: Update the CI comment**

In `.github/workflows/ci.yml`, replace the matrix comment (lines 40-43) with:

```yaml
        # 22 is the floor the whole project claims: package.json engines,
        # devEngines and tsdown's target all say 22, and scripts/ are .ts
        # files Node runs directly, needing native type stripping (22.18+).
```

The old comment ended "package.json still advertises engines.node >=18, which is untested here and tracked separately" — that is now false and must go.

- [ ] **Step 4: Verify nothing depended on the old target**

```bash
npm run build
git diff --stat dist/index.js
```

Expected: `dist/index.js` either unchanged or trivially different. If the diff is large, stop and inspect — `target: "node22"` should only relax downlevelling, never change semantics. Report what changed rather than committing a surprise.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
npm run typecheck
npm run typecheck:scripts
git status --short          # confirm AUDIT.md is NOT staged
git add package.json tsdown.config.ts .github/workflows/ci.yml
git add -f dist/index.js
git commit -m "State one supported Node version, the one CI tests (#105)"
```

---

### Task 6: End-to-end verification against a real settings file

Nothing here changes source. It proves the four issues are actually closed on the real production path, which for this repo means the shipped bundle, not the vitest-resolved source.

**Files:** none modified.

- [ ] **Step 1: Confirm the full gate passes**

```bash
npm run typecheck
npm run typecheck:scripts
npm test
npm run build
git diff --exit-code -- dist/index.js && echo "bundle is current"
```

Expected: all pass, and `bundle is current`. A non-empty diff here is what CI's `bundle-drift` job fails on.

- [ ] **Step 2: Prove #90 against your real Node install**

```bash
TMP=$(mktemp -d) && mkdir -p "$TMP/.claude"
HOME="$TMP" node dist/index.js setup
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.T+'/.claude/settings.json','utf8')).statusLine.command)" T="$TMP"
```

Expected on a Homebrew machine: the command names `/opt/homebrew/bin/node`, **not** `/opt/homebrew/Cellar/node/<version>/bin/node`. Confirm the printed path still exists after a hypothetical upgrade by checking it is the symlink: `ls -l /opt/homebrew/bin/node`.

If you are on nvm/nodenv instead, expect the version-scoped path plus the warning on stdout — that is the designed fallback, not a failure.

- [ ] **Step 3: Prove #88 and #89 against the shipped bundle**

```bash
TMP=$(mktemp -d) && mkdir -p "$TMP/.claude"

echo 'null' > "$TMP/.claude/settings.json"
HOME="$TMP" node dist/index.js setup; echo "exit: $?"
cat "$TMP/.claude/settings.json"; ls "$TMP/.claude/"

printf '{\n  "model": "opus"\n}\n' > "$TMP/.claude/settings.json"
HOME="$TMP" node dist/index.js setup; echo "exit: $?"
cat "$TMP/.claude/settings.json.bak"
```

Expected: the first run prints `gccusage: <path> contains null, not a JSON object. Fix or move it, then re-run \`gccusage setup\`.` to stderr, exits 1, leaves the file as `null` and creates no `.bak`. The second exits 0, preserves `model`, adds `statusLine`, and writes a `.bak` containing the original three lines byte-for-byte.

- [ ] **Step 4: Confirm the statusline still renders**

```bash
echo '{"session_id":"verify","model":{"id":"claude-opus-5","display_name":"Opus 5"},"cost":{"total_cost_usd":1.23}}' | node dist/index.js; echo "exit: $?"
```

Expected: a rendered bar, exit 0. This is the regression check on Task 4 — scoping the CLI error path must not have disturbed statusline mode.

- [ ] **Step 5: Update `AUDIT.md` locally, do not stage it**

Add a remediation-log row for each of OPS-002 (#88), OPS-003 (#89), OPS-004 (#90) and #105, following the format of the existing rows: what closed it, what the issue got wrong, and what was deliberately not done. Specifically worth recording:

- #88's Fix section and its acceptance criteria contradicted each other; we took the acceptance criteria and extended refusal to the unparseable case, changing behaviour beyond the filed issue.
- #89's literal criterion ("never observed in a partial state") is not testable from this suite; the mechanism is tested instead.
- The "statusline still exits 0 on a forced error" test named in the spec was dropped as unwritable — every render-path I/O site is individually defended, so no reachable sabotage throws.

`AUDIT.md` is deliberately untracked. Confirm with `git status --short` that it is not staged.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin setup-robustness
gh pr create --title "Make \`setup\` survive a Node upgrade and refuse a settings.json it cannot read" --body "$(cat <<'EOF'
Closes #90, #88, #89, #105.

`setup` wrote `process.execPath` into `statusLine.command`. Node resolves
symlinks for it, so on Homebrew that is the Cellar path — the one
`brew upgrade node` deletes, silently ending the statusline. It now scans
`PATH` for a `node` resolving to the same binary with no version segment
(`/opt/homebrew/bin/node`), and where no stable path exists (nvm, nodenv,
volta) it keeps `execPath` and says so.

An unusable `~/.claude/settings.json` no longer exits 0 having done nothing.
`null` and scalars threw into the statusline's graceful-degradation handler;
an array root did not throw at all — the assignment succeeded and
`JSON.stringify` dropped the key. All are now refused, with the file named
and nothing written. That refusal extends to unparseable files, which
previously got backed up and clobbered: this file holds the user's
permissions, hooks and MCP config, and #88's own Fix and acceptance criteria
disagreed on the disposition.

Writes go through `writeFileAtomic` (temp file + rename, lifted out of
`writeJsonAtomic`), and `.bak` is now written on the success path — the case
that previously got no backup at all.

`engines.node`, `devEngines` and tsdown's target now all say 22, which is
what CI tests.

Design: `docs/superpowers/specs/2026-08-02-setup-cluster-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for the implementer

**Two things that have bitten this repo before, both live in this plan:**

1. **The bundle.** `dist/index.js` is gitignored but force-tracked. Every commit above that touches `src/` ends with `npm run build && git add -f dist/index.js`. PR #38 shipped three commits without it and the fix reached nobody. CI's `bundle-drift` job now catches it, but catching it in review is slower than not doing it.

2. **Vacuous tests.** Tasks 2 and 3 have explicit sabotage steps — break the fix, watch the specific named test fail, revert. Do not skip them. This repo has had five planned tests that could not fail under the regressions they were written for.

**Windows is out of scope.** `resolveStableNodePath` joins `node` with no `.exe` and `statusLine.command` is a POSIX shell string; the tool already assumes a POSIX shell.
