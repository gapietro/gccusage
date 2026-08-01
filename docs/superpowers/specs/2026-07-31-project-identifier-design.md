# Project identifier on the default bar (#48, #59)

**Date:** 2026-07-31
**Issues:** [#48](https://github.com/gapietro/gccusage/issues/48) (feature),
[#59](https://github.com/gapietro/gccusage/issues/59) (blocker / respecification)
**Status:** approved

## Problem

With several sessions open it is not obvious which project a given statusline belongs
to. `git-branch` narrows it down but says nothing outside a repo.

#48 originally specified showing `basename(stdin.cwd)`. #59 established that this is the
wrong source. The #47 reality harness captured a real Claude Code 2.1.220 payload whose
`cwd` was:

```
/Users/x/projects/gccusage/src/widgets
```

`basename()` of that is `widgets` — not `gccusage`. `stdin.cwd` is wherever the shell
happened to be when Claude Code started, so basename-of-cwd names a subdirectory
whenever the session did not start at the repo root. That is the exact question the
feature was filed to answer, answered wrongly.

The payload does carry the right source, `workspace.project_dir` (the repo root), but
`src/types/status-json.ts` parses only 7 top-level fields and valibot's default object
schema silently strips `workspace`. The correct value is unreachable by any widget
today.

## What this is not

**It does not disambiguate two checkouts of the same repo.** `~/projects/gccusage` and
`~/work/gccusage` both render `gccusage`. #48's rationale mentions that case; a basename
of any kind cannot deliver it, and this design does not attempt to. Recorded here so the
gap is not rediscovered as a bug.

## Design

### 1. Schema — `src/types/status-json.ts`

```ts
const WorkspaceSchema = v.object({
  project_dir: v.optional(v.string()),
});
```

added to `StatusJsonSchema` as `workspace: v.optional(WorkspaceSchema)`.

`project_dir` only. The real payload's `workspace` also carries `current_dir` (a
duplicate of `cwd`), `added_dirs[]` and `repo{host,owner,name}`; none has a consumer, so
valibot keeps stripping them until one does.

### 2. New widget — `src/widgets/project.ts`, registered as `project`

Widget #26. Reads `workspace.project_dir`, never `cwd`.

| `workspace.project_dir` | renders |
|---|---|
| `/Users/x/projects/gccusage` | `gccusage` |
| `/Users/x/projects/gccusage` while `cwd` is `.../gccusage/src/widgets` | `gccusage` |
| `/Users/x/projects/gccusage/` (trailing slash) | `gccusage` |
| `/Users/x` (equals `$HOME`) | `~` |
| `/` | `/` |
| absent, or empty string | `null` — the segment disappears |

`config.label` is honoured the way `cwd` already does it: the label is prefixed with a
space when set, and the bare text is rendered when it is not.

The `$HOME` case compares the resolved `project_dir` against `process.env.HOME`, as
`cwd.ts` does. When `HOME` is unset the comparison is skipped and the plain basename is
rendered.

**Missing `project_dir` declines rather than falling back to `basename(cwd)`.** A
fallback would be correct whenever the session started at the repo root and silently
reintroduce the #59 defect whenever it did not — a wrong project name with no signal
that it is wrong. Failing closed matches the repo's existing habit
(`findSessionJsonlFiles` returning `[]` without a session id). Cost: on a Claude Code
build that does not send `workspace`, the default bar loses this segment.

### 3. `src/widgets/cwd.ts` is not modified

It keeps rendering the full path with `$HOME` → `~`. #48 asks that the `~` abbreviation
logic not be deleted and floats a `full: true` option; leaving the widget alone
satisfies that without adding an option. `cwd` and `project` are different quantities —
where you are, versus which project — so they are different widgets and each name stays
honest. No new field is added to `WidgetConfigSchema`.

### 4. Defaults — `src/config/defaults.ts`

`project` becomes the first segment of line 2, before `git-branch`:

```ts
{ type: "project", fg: "#ffffff", bg: "#264653", priority: 5 },
```

**Colour `#264653`.** All figures are CIEDE2000 from the repo's own `colorDistance`
(`src/render/color-compare.ts`), against every background the bar can paint including
all alert states:

| against | ΔE |
|---|---|
| `git-branch` `#613583` — its static neighbour | 17.3 |
| `burn-rate` `#555555` — worst case, reachable only via compact-mode adjacency | 13.5 |
| all others | ≥ 16.8 |

`MIN_SEPARATOR_DELTA` is 8, so the worst case clears it by ~1.7×. Rejected: `#3a3a5c`
(worst case 12.8, and it lands on `git-branch`, the one neighbour it always has);
`#8f4700` and `#5c3d2e`, which separate further numerically but sit in the amber/red hue
family the bar reserves for alerts.

**Priority 5.** Every widget currently numbered 5 or above shifts up by one:

| priority | widget |
|---:|---|
| 1 | model |
| 2 | session-cost |
| 3 | context-percent |
| 4 | compact-countdown |
| 5 | **project** |
| 6 | git-branch (was 5) |
| 7 | today-spend (was 6) |
| 8 | burn-rate (was 7) |
| 9 | git-changes (was 8) |
| 10 | lines-changed (was 9) |

`priority` is keep-first: `renderCompact` sorts ascending and greedily fits until the
terminal runs out. On a narrow terminal, "which project" is the question #48 was filed
to answer — a bare branch name without it is the ambiguity, not the fix. Note that
`renderCompact` flattens both lines before sorting, so this creates compact-mode
adjacencies the per-line layout never has; that is why the colour was checked against
the whole palette rather than only `git-branch`.

## Testing

- **`src/__tests__/widgets.test.ts`** — the six input cases in the table above.

- **`src/__tests__/fixtures/widget-expectations.ts`** — add `project` → `"demo-project"`
  (the sanitized fixtures' project name). **Remove `knownWrong: 59` from the `cwd`
  entry** and rewrite its `why`: `cwd` renders the cwd correctly, and the project
  identifier now lives in a different widget. Forcing that deliberate edit is what the
  #47 harness is for.

- **`src/__tests__/defaults.test.ts`** — `makeSweepContext()` currently builds a `stdin`
  with no `workspace` key. Combined with decline-on-absent, the new segment would render
  `null` through the entire rendered-adjacency sweep: the ΔE and invisible-piece guards
  would pass while covering nothing. **`makeSweepContext` must gain a
  `workspace.project_dir`.** This is the same failure shape as the 12 dormant widgets in
  #47 and is the single easiest thing to get wrong in this change. The distinct-priority
  test at `defaults.test.ts:37` covers the renumber.

- **Look at the real bar.** Render the default layout against
  `src/__tests__/fixtures/real-payloads/opus5-1m-early.json` — the fixture whose `cwd` is
  a subdirectory and where the original #48 spec would have printed `widgets` — and
  inspect the output. #48 asks for this by name; this widget has never been seen on a
  real statusline.

- **README** — add a `project` row to the widget table (`README.md:184` area, beside the
  existing `cwd` row).

- **Build** — `npm run build` and `git add -f dist/index.js` in the same commit.
  `gccusage setup` points `statusLine.command` at `dist/index.js`, so a src-only commit
  leaves `git pull` upgraders running the old bundle.

## Resolution

- #59 is resolved: the correct source is parsed and used, and the `cwd` widget is no
  longer tagged as the wrong answer to a question it was never asked.
- #48 is delivered as respecified — project name only, from `project_dir` — with its
  two-checkouts rationale explicitly out of scope.
