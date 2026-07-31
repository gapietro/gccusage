# Config Color Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject widget `fg`/`bg` values that are neither a known color name nor an anchored hex color, and surface every config-load failure as a visible line in the statusline instead of silently falling back to defaults.

**Architecture:** A single predicate (`isValidColor`) in `src/render/colors.ts` becomes the grammar, wired into the valibot schema as a `v.check`. `loadSettings` stops swallowing failures — it returns `{ settings, error? }`, and `src/index.ts` prints the error line in place of the bar when `error` is set, returning before the statusline cache is touched.

**Tech Stack:** TypeScript, valibot@1 (`v.pipe` / `v.check` / `v.safeParse` / `v.getDotPath`), vitest, tsdown, chalk@5.

**Spec:** `docs/superpowers/specs/2026-07-30-config-color-validation-design.md` (issue #42)

## Global Constraints

- **`dist/index.js` is gitignored but force-tracked.** Every commit that touches `src/` must run `npm run build` and stage the bundle with `git add -f dist/index.js`. `gccusage setup` points `statusLine.command` at that file, so a src-only commit ships nothing to anyone who pulls.
- **No new dependencies.** Everything here uses valibot, vitest and the standard library.
- **Do not import `chalk` in `src/config/`.** `chalk.level` is 0 when stdout is a pipe and is only forced to 3 inside `src/render/powerline.ts`; the error line writes its ANSI escape literally.
- **valibot@1 facts verified against the installed copy** — rely on them, don't re-derive:
  - `issue.received` already carries its own quotes: the string `196` comes back as `"196"` (5 characters, quotes included). Never wrap it in another pair.
  - `v.safeParse` collects *all* issues; it does not stop at the first. No `{ abortEarly: false }` needed.
  - `v.getDotPath(issue)` returns e.g. `lines.0.widgets.2.bg`, or `null` for a root-level issue.
- **`npm test` and `npm run typecheck` must both be clean before every commit.**
- Error message text, used verbatim in both the schema and the tests: `must be a color name or #rgb/#rrggbb hex`

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/render/colors.ts` | modify | Owns `NAMED_COLORS`, `resolveColor`, and now `isValidColor` — the single source of truth for what a color may be |
| `src/__tests__/colors.test.ts` | create | Tests for `isValidColor` |
| `src/config/error-line.ts` | create | Formats the one-line statusline error. Separate from `index.ts` so it is testable without invoking `main()` |
| `src/__tests__/error-line.test.ts` | create | Tests for `formatConfigError` |
| `src/config/loader.ts` | modify | Returns `{ settings, error? }` instead of swallowing failures |
| `src/__tests__/loader.test.ts` | modify | Updated for the new return shape, plus error cases |
| `src/config/schema.ts` | modify | `ColorSchema` gains the `v.check(isValidColor, …)` constraint |
| `src/index.ts` | modify | Prints the error line and returns, before stdin and before the cache |
| `src/__tests__/defaults.test.ts` | modify | Guard: every shipped default color passes its own validator |
| `src/__tests__/themes.test.ts` | modify | Guard: every theme color passes its own validator |
| `README.md` | modify | Documents the new strictness, replacing the "silently renders as black" paragraph |

**Task ordering rationale:** Task 2 (loader + error line) lands *before* Task 3 (schema strictness) so that no commit is ever a regression. If the schema became strict first, a single bad color would silently discard the whole config — a quieter failure than the wrong color it replaces.

---

### Task 1: `isValidColor` — the color grammar

**Files:**
- Modify: `src/render/colors.ts`
- Test: `src/__tests__/colors.test.ts` (create)

**Interfaces:**
- Consumes: `NAMED_COLORS` (already exported from `src/render/colors.ts`)
- Produces: `export function isValidColor(color: string): boolean` — used by `ColorSchema` in Task 3 and by the guard tests in Task 4

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/colors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isValidColor, NAMED_COLORS } from "../render/colors.js";

describe("isValidColor", () => {
  // Table-driven over the map itself: adding a name to NAMED_COLORS without
  // it validating fails here rather than at render time.
  it.each(Object.keys(NAMED_COLORS))("accepts the named color %s", (name) => {
    expect(isValidColor(name)).toBe(true);
  });

  it.each(["RED", "Red", "  red  ", "\tblue\n"])(
    "normalizes %j the way resolveColor does",
    (input) => {
      expect(isValidColor(input)).toBe(true);
    },
  );

  it.each(["#abc", "#fff", "#AABBCC", "#000000", "#1a5fb4"])(
    "accepts the hex color %s",
    (hex) => {
      expect(isValidColor(hex)).toBe(true);
    },
  );

  // Issue #42: these are the ansi256 codes chalk's unanchored regex
  // misparses into unrelated colors ("196" paints #119966).
  it.each(["196", "255", "100", "21", "9"])(
    "rejects the ansi256 code %s",
    (code) => {
      expect(isValidColor(code)).toBe(false);
    },
  );

  it.each(["#12345", "#abcd", "#gg0000", "#", "#1234567", "##fff"])(
    "rejects the near-miss hex %s",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  it.each(["abc", "aabbcc"])(
    "rejects hex without a leading #: %s",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  it.each(["grey1", "banana", "", "   "])(
    "rejects the unknown name %j",
    (value) => {
      expect(isValidColor(value)).toBe(false);
    },
  );

  // resolveColor uses Object.hasOwn rather than a truthiness check for this
  // reason; isValidColor must agree or a prototype key would validate and
  // then resolve to a function.
  it.each(["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"])(
    "rejects the Object.prototype key %s",
    (key) => {
      expect(isValidColor(key)).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/__tests__/colors.test.ts`

Expected: FAIL — `isValidColor` is not exported from `../render/colors.js` (vitest reports it as an import/type error, or every case fails with "isValidColor is not a function").

- [ ] **Step 3: Write the implementation**

In `src/render/colors.ts`, add the regex directly above `resolveColor` and the function directly below it:

```ts
// Anchored, unlike chalk's own hex regex. chalk's `hexToRgb` scans for a hex
// run *anywhere* inside the string, so "196" (an ansi256 code) reads as the
// 3-digit hex #119966 and "#12345" reads as #112233. Those silent wrong
// colors are what issue #42 is about; this grammar rejects them.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
```

```ts
/**
 * Whether a config value is a color this project can actually paint: a
 * `NAMED_COLORS` key or an anchored 3- or 6-digit hex.
 *
 * Normalization must stay identical to `resolveColor` — same `trim()`, same
 * `toLowerCase()`, same `Object.hasOwn` — or a value could pass validation
 * here and resolve to something else at render time.
 */
export function isValidColor(color: string): boolean {
  const trimmed = color.trim();
  return HEX_COLOR.test(trimmed) || Object.hasOwn(NAMED_COLORS, trimmed.toLowerCase());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/colors.test.ts && npm run typecheck`

Expected: PASS, all cases; typecheck clean.

- [ ] **Step 5: Commit**

No `src/index.ts` behavior changes yet, but `src/` changed, so the bundle is rebuilt and staged per the global constraint.

```bash
npm run build
git add src/render/colors.ts src/__tests__/colors.test.ts
git add -f dist/index.js
git commit -m "Add isValidColor, the color grammar for config validation (#42)"
```

---

### Task 2: Surface config-load failures in the statusline

**Files:**
- Create: `src/config/error-line.ts`
- Test: `src/__tests__/error-line.test.ts` (create)
- Modify: `src/config/loader.ts` (the `ConfigLoad` type and `loadSettings`)
- Modify: `src/__tests__/loader.test.ts` (all six existing cases + new error cases)
- Modify: `src/index.ts:15`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS`, `SettingsSchema`, `mergeSettings` (all already in place)
- Produces:
  - `export interface ConfigLoad { settings: Settings; error?: string }`
  - `export function loadSettings(): ConfigLoad` — **breaking change**, was `Settings`
  - `export function formatConfigError(error: string, configPath: string): string`

This task deliberately does *not* touch `ColorSchema`. It makes malformed JSON, unreadable files and schema mismatches visible; Task 3 then routes bad colors through the same mechanism.

- [ ] **Step 1: Write the failing test for the error line**

Create `src/__tests__/error-line.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { formatConfigError } from "../config/error-line.js";

const CONFIG = "/home/u/.config/gccusage/settings.json";
const MESSAGE = "lines.0.widgets.2.bg: must be a color name or #rgb/#rrggbb hex (got \"196\")";

describe("formatConfigError", () => {
  const originalHome = process.env["HOME"];

  afterEach(() => {
    process.env["HOME"] = originalHome;
  });

  it("is a single line with no trailing newline", () => {
    const line = formatConfigError(MESSAGE, CONFIG);
    expect(line).not.toContain("\n");
  });

  it("opens with a bold-red marker so it cannot be mistaken for a segment", () => {
    const line = formatConfigError(MESSAGE, CONFIG);
    expect(line.startsWith("[1;31m⚠ gccusage config[0m")).toBe(true);
  });

  it("includes the message verbatim", () => {
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(MESSAGE);
  });

  it("collapses $HOME to ~ so the line stays short", () => {
    process.env["HOME"] = "/home/u";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain("~/.config/gccusage/settings.json");
  });

  it("leaves a path outside $HOME alone", () => {
    process.env["HOME"] = "/home/other";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });

  it("does not collapse when HOME is / (every path starts with it)", () => {
    process.env["HOME"] = "/";
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });

  it("survives HOME being unset", () => {
    delete process.env["HOME"];
    expect(formatConfigError(MESSAGE, CONFIG)).toContain(CONFIG);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/error-line.test.ts`

Expected: FAIL — cannot resolve `../config/error-line.js`.

- [ ] **Step 3: Write the error-line module**

Create `src/config/error-line.ts`:

```ts
// The statusline's stdout is the only channel a user reliably sees — there is
// no visible stderr in statusline mode — so a config failure is rendered as
// the bar rather than beside it.

// Written as a literal escape rather than via chalk: chalk.level is 0 when
// stdout is a pipe and is only forced to 3 inside render/powerline.ts, so
// using chalk here would mean importing that module for its side effect to
// color a single line.
const BOLD_RED = "[1;31m";
const RESET = "[0m";

/** Collapse $HOME to `~` so the line stays short enough to read at a glance. */
function shortenPath(filePath: string): string {
  const home = process.env["HOME"];
  // A HOME of "/" would prefix-match every absolute path.
  if (!home || home === "/" || !filePath.startsWith(home)) return filePath;
  return `~${filePath.slice(home.length)}`;
}

/**
 * One line, no trailing newline — matching what `runStatusline` returns, since
 * this replaces it. U+26A0 is not a Nerd Font glyph, so it renders in the same
 * terminals the default `▶` separator targets.
 */
export function formatConfigError(error: string, configPath: string): string {
  return `${BOLD_RED}⚠ gccusage config${RESET}  ${shortenPath(configPath)} — ${error}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/__tests__/error-line.test.ts`

Expected: PASS, 7 cases.

- [ ] **Step 5: Write the failing loader tests**

In `src/__tests__/loader.test.ts`, first update all six existing cases to the new return shape — replace every occurrence of

```ts
    const settings = loadSettings();
```

with

```ts
    const { settings } = loadSettings();
```

and rewrite the invalid-JSON case (currently at the bottom of the file) to assert the error as well:

```ts
  it("returns defaults and reports an error on invalid JSON", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json{{{");

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("invalid JSON");
  });
```

Then append these new cases inside the same `describe` block:

```ts
  it("reports no error when the config file is absent", () => {
    const { error } = loadSettings();
    expect(error).toBeUndefined();
  });

  it("reports no error for a valid config", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ powerline: { theme: "ocean" } }),
    );

    const { error } = loadSettings();
    expect(error).toBeUndefined();
  });

  it("reports a schema mismatch with its dot path and the received value", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ lines: "nope" }));

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("lines");
    // `received` already carries its own quotes — one pair, not two.
    expect(error).toContain('"nope"');
    expect(error).not.toContain('""nope""');
  });

  it("counts additional issues rather than listing them all", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ lines: "nope", costSource: "bogus" }),
    );

    const { error } = loadSettings();
    expect(error).toContain("(+1 more)");
  });

  it("reports an unreadable config file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("cannot read config");
    expect(error).toContain("EACCES");
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run src/__tests__/loader.test.ts`

Expected: FAIL — destructuring `{ settings }` from a `Settings` return yields `undefined`, and `error` does not exist.

- [ ] **Step 7: Rewrite `loadSettings`**

In `src/config/loader.ts`, replace the existing `loadSettings` (the final function in the file) with the type, the message builder and the new implementation:

```ts
export interface ConfigLoad {
  settings: Settings;
  /**
   * Present when a config file existed but could not be used. An absent file
   * is not an error — having no config is the normal case.
   */
  error?: string;
}

/** One line describing why the config file was rejected. */
function describeIssues(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string {
  const [first, ...rest] = issues;
  const dotPath = v.getDotPath(first);
  const where = dotPath ? `${dotPath}: ` : "";
  const more = rest.length > 0 ? ` (+${rest.length} more)` : "";
  // `first.received` is already quoted by valibot ("196" comes back as the
  // 5-character string `"196"`), so it is interpolated bare.
  return `${where}${first.message} (got ${first.received})${more}`;
}

export function loadSettings(): ConfigLoad {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return { settings: DEFAULT_SETTINGS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      settings: DEFAULT_SETTINGS,
      error: err instanceof SyntaxError ? `invalid JSON: ${detail}` : `cannot read config: ${detail}`,
    };
  }

  const result = v.safeParse(SettingsSchema, parsed);
  if (!result.success) {
    return { settings: DEFAULT_SETTINGS, error: describeIssues(result.issues) };
  }

  return {
    settings: mergeSettings(DEFAULT_SETTINGS, parsed as Record<string, unknown>, result.output),
  };
}
```

Notes for the implementer:

- `v.safeParse` is used rather than `v.parse` in a `try` so the issues arrive typed, with no `ValiError` narrowing. It collects every issue, which is where `(+N more)` comes from.
- `JSON.parse` on a non-object (e.g. the file contains `3`) is caught by `safeParse` as a root-level issue; `v.getDotPath` returns `null` there and the `where` prefix is omitted rather than printing `null`.
- Keep `getConfigPath`, `mergeIfPresent` and `mergeSettings` exactly as they are.
- The `describeIssues` signature above was compiled against this project's `tsconfig` before this plan was written: `result.issues` from `v.safeParse(SettingsSchema, …)` is assignable to `[v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]` and `v.getDotPath` accepts it. It typechecks as written — if it does not, something else changed.

- [ ] **Step 8: Run the loader tests to verify they pass**

Run: `npx vitest run src/__tests__/loader.test.ts`

Expected: PASS — 6 updated cases + 5 new ones.

- [ ] **Step 9: Wire it into `src/index.ts`**

Update the imports and the statusline branch:

```ts
import { loadSettings, getConfigPath } from "./config/loader.js";
import { formatConfigError } from "./config/error-line.js";
```

```ts
  // Statusline mode
  const { settings, error } = loadSettings();
  if (error) {
    // Returning here — before the stdin read and before runStatusline — keeps
    // the statusline cache untouched, so a stale bar is never served over the
    // error and the first prompt after a fix renders normally.
    process.stdout.write(formatConfigError(error, getConfigPath()));
    return;
  }
```

`src/index.ts` has no unit test (it is the `main()` entry point); this wiring is covered by the manual verification in Task 4.

- [ ] **Step 10: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: PASS, everything green. `src/cli.ts` does not call `loadSettings`, so no other call site needs updating.

- [ ] **Step 11: Commit**

```bash
npm run build
git add src/config/error-line.ts src/config/loader.ts src/index.ts \
        src/__tests__/error-line.test.ts src/__tests__/loader.test.ts
git add -f dist/index.js
git commit -m "Report config load failures in the statusline instead of silently using defaults (#42)"
```

---

### Task 3: Make `ColorSchema` strict

**Files:**
- Modify: `src/config/schema.ts:3-9` (the `ColorSchema` declaration and its comment)
- Test: `src/__tests__/loader.test.ts` (append the color cases)
- Modify: `README.md:210-215` (the `fg`/`bg` paragraph)

**Interfaces:**
- Consumes: `isValidColor` from Task 1, `ConfigLoad`/`loadSettings` from Task 2
- Produces: no new exports — `ColorSchema` stays module-private

- [ ] **Step 1: Write the failing tests**

Append to the `describe("loadSettings", …)` block in `src/__tests__/loader.test.ts`:

```ts
  // Issue #42: "196" is an ansi256 code that chalk's unanchored hex regex
  // paints as #119966. It must be rejected, not silently misparsed.
  it("rejects an ansi256 code in a widget color", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", bg: "196" }] }],
      }),
    );

    const { settings, error } = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(error).toContain("lines.0.widgets.0.bg");
    expect(error).toContain("must be a color name or #rgb/#rrggbb hex");
    expect(error).toContain('"196"');
  });

  it("rejects a near-miss hex typo", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", fg: "#12345" }] }],
      }),
    );

    const { error } = loadSettings();
    expect(error).toContain("lines.0.widgets.0.fg");
    expect(error).toContain('"#12345"');
  });

  it("counts the second bad color rather than listing it", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [
          { widgets: [{ type: "model", bg: "196" }, { type: "cwd", bg: "grey1" }] },
        ],
      }),
    );

    const { error } = loadSettings();
    expect(error).toContain("lines.0.widgets.0.bg");
    expect(error).toContain("(+1 more)");
  });

  it("accepts a named color and hex side by side", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        lines: [{ widgets: [{ type: "model", fg: "red", bg: "#1a5fb4" }] }],
      }),
    );

    const { settings, error } = loadSettings();
    expect(error).toBeUndefined();
    expect(settings.lines[0]?.widgets[0]?.fg).toBe("red");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/__tests__/loader.test.ts`

Expected: FAIL — the three rejection cases get `error === undefined`, because `ColorSchema` accepts any string today. The "accepts" case already passes.

- [ ] **Step 3: Add the constraint**

In `src/config/schema.ts`, add the import at the top:

```ts
import { isValidColor } from "../render/colors.js";
```

and replace the whole `ColorSchema` declaration (the `v.union` wrapper and its comment) with:

```ts
// A widget color: a named color from NAMED_COLORS (src/render/colors.ts) or an
// anchored `#rgb`/`#rrggbb` hex. Anything else is a config load error rather
// than a render-time fallback — chalk's hex regex is unanchored, so values
// like "196" or "#12345" would otherwise paint an unrelated color instead of
// failing. ansi256 codes are deliberately unsupported (issue #42).
const ColorSchema = v.pipe(
  v.string(),
  v.check(isValidColor, "must be a color name or #rgb/#rrggbb hex"),
);
```

The `v.union([...])` wrapper goes away — it wrapped a single member and added nothing.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`

Expected: PASS. Watch for fallout in `defaults.test.ts` or `renderer.test.ts` — the shipped defaults are all hex and should be unaffected, but any test fixture using a sloppy color value will now fail to parse and must be corrected to a valid color (that is the fixture being wrong, not the schema).

- [ ] **Step 5: Update the README**

In `README.md`, replace the paragraph beginning "`fg`/`bg` accept a hex color" (immediately below the widget options table) with:

```markdown
`fg`/`bg` accept a hex color (`"#ff0000"` or the 3-digit `"#f00"`) or one of
these named colors: `red`, `green`, `blue`, `yellow`, `cyan`, `magenta`,
`white`, `black`, `gray` (and `grey`), `orange`, `pink`.

Anything else is rejected when the config loads, and gccusage renders a single
error line naming the offending field instead of the statusline. This is
stricter than it looks: `"#12345"` (a typo) and `"196"` (an ansi256 code) are
errors, not colors. ansi256 codes are not supported — see
[issue #42](https://github.com/gapietro/gccusage/issues/42).
```

- [ ] **Step 6: Verify the README claim by hand**

Run:

```bash
npm run build
mkdir -p /tmp/gcc-bad/gccusage
printf '{"lines":[{"widgets":[{"type":"model","bg":"196"}]}]}' > /tmp/gcc-bad/gccusage/settings.json
echo '{}' | XDG_CONFIG_HOME=/tmp/gcc-bad node dist/index.js; echo
```

Expected: one red-marked line naming `lines.0.widgets.0.bg` and `"196"` — not a rendered bar, not black segments.

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts src/__tests__/loader.test.ts README.md
git add -f dist/index.js
git commit -m "Reject config colors that are neither a known name nor anchored hex (#42)"
```

---

### Task 4: Guard the shipped colors and verify end to end

**Files:**
- Modify: `src/__tests__/defaults.test.ts`
- Modify: `src/__tests__/themes.test.ts`

**Interfaces:**
- Consumes: `isValidColor` (Task 1), `SettingsSchema` (Task 3), `DEFAULT_SETTINGS`, `THEMES`
- Produces: nothing — this task is guards and verification only

Rationale: the validator now stands between the user and the renderer, so the product must not be able to trip its own validator. A default or theme color that fails `isValidColor` would mean shipping a bar that a user could not reproduce in their own config.

- [ ] **Step 1: Write the failing guard tests**

Append to `src/__tests__/defaults.test.ts`:

```ts
import * as v from "valibot";
import { SettingsSchema } from "../config/schema.js";
import { isValidColor } from "../render/colors.js";

describe("shipped default colors", () => {
  it("uses only colors a user could write in their own config", () => {
    for (const [lineIndex, line] of DEFAULT_SETTINGS.lines.entries()) {
      for (const [widgetIndex, widget] of line.widgets.entries()) {
        const where = `lines.${lineIndex}.widgets.${widgetIndex} (${widget.type})`;
        if (widget.fg !== undefined) {
          expect(isValidColor(widget.fg), `${where}.fg = ${widget.fg}`).toBe(true);
        }
        if (widget.bg !== undefined) {
          expect(isValidColor(widget.bg), `${where}.bg = ${widget.bg}`).toBe(true);
        }
      }
    }
  });

  it("round-trips through its own schema", () => {
    expect(v.safeParse(SettingsSchema, DEFAULT_SETTINGS).success).toBe(true);
  });
});
```

`describe`/`it`/`expect` and `DEFAULT_SETTINGS` are already imported at the top of that file — add only the two new import lines shown above, do not duplicate the existing ones.

Append to `src/__tests__/themes.test.ts`:

```ts
import { isValidColor } from "../render/colors.js";

describe("theme colors", () => {
  it("uses only colors a user could write in their own config", () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      for (const [index, segment] of theme.segments.entries()) {
        expect(isValidColor(segment.fg), `${name}.segments.${index}.fg = ${segment.fg}`).toBe(true);
        expect(isValidColor(segment.bg), `${name}.segments.${index}.bg = ${segment.bg}`).toBe(true);
      }
    }
  });
});
```

`describe`/`it`/`expect` and `THEMES` are already imported at the top of that file — add only the `isValidColor` line.

- [ ] **Step 2: Run them**

Run: `npx vitest run src/__tests__/defaults.test.ts src/__tests__/themes.test.ts`

Expected: PASS immediately — every shipped color is already a clean 6-digit hex. These are regression guards, so passing on first run is the correct outcome; the assertion messages name the offending field if a future color ever breaks them.

- [ ] **Step 3: Verify the good path end to end**

Run:

```bash
npm run build
rm -f ~/.cache/gccusage/statusline-cache.json
echo '{"session_id":"plan-check","model":{"id":"claude-opus-5","display_name":"Opus 5"},"cost":{"total_cost_usd":1.23},"context_window":{"used_percentage":42}}' | node dist/index.js; echo
```

Expected: the normal two-line powerline bar. Confirm it is unchanged from before this branch — the defaults are all hex, so nothing should move.

- [ ] **Step 4: Verify the error path does not poison the cache**

Run:

```bash
mkdir -p /tmp/gcc-bad/gccusage
printf '{"lines":[{"widgets":[{"type":"model","bg":"196"}]}]}' > /tmp/gcc-bad/gccusage/settings.json
echo '{"session_id":"plan-check"}' | XDG_CONFIG_HOME=/tmp/gcc-bad node dist/index.js; echo
printf '{"lines":[{"widgets":[{"type":"model","bg":"#26a269"}]}]}' > /tmp/gcc-bad/gccusage/settings.json
echo '{"session_id":"plan-check"}' | XDG_CONFIG_HOME=/tmp/gcc-bad node dist/index.js; echo
```

Expected: the first command prints the error line; the second immediately prints a rendered bar. If the second still shows the error, the early return is happening after the cache write — go back to Task 2 Step 9.

- [ ] **Step 5: Verify a malformed config file**

Run:

```bash
printf 'not json{{{' > /tmp/gcc-bad/gccusage/settings.json
echo '{"session_id":"plan-check"}' | XDG_CONFIG_HOME=/tmp/gcc-bad node dist/index.js; echo
rm -rf /tmp/gcc-bad
```

Expected: an error line containing `invalid JSON`, not a silently-default bar.

- [ ] **Step 6: Full verification**

Run: `npm test && npm run typecheck && npm run build && git status --short`

Expected: all tests pass, typecheck clean, and `git status` shows nothing unexpected (`dist/index.js` is force-tracked; if it differs, stage it).

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/defaults.test.ts src/__tests__/themes.test.ts
git add -f dist/index.js
git commit -m "Guard that shipped default and theme colors pass config validation (#42)"
```

---

## Follow-ups (do not implement here)

Note these on issue #42 when closing it, rather than expanding this plan:

- `powerline.theme` accepts any string; an unknown theme name silently falls back. Same silent-fallback class, but it is a name, not a color.
- Widget `type` accepts any string; an unknown type silently renders nothing.
- `NAMED_COLORS` holds harsh primaries (`red` → `#ff0000`) that suit a statusline poorly. Re-picking them is a subjective call that would also change the working non-powerline path.
