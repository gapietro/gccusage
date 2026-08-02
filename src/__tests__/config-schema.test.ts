import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfigJsonSchema } from "../config/json-schema.js";
import { getWidgetTypes } from "../widgets/registry.js";
import { DEFAULT_SETTINGS } from "../config/defaults.js";

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../config-schema.json",
);

/**
 * The published JSON Schema is a build artifact of `buildConfigJsonSchema()`,
 * committed so it can be referenced by URL. This file is the link that was
 * missing (#75): without it, the schema drifted to 17 of 26 widget types and
 * nothing failed.
 *
 * Regenerate with `npm run schema`, which runs this file with
 * UPDATE_CONFIG_SCHEMA=1 and rewrites the artifact instead of asserting.
 *
 * The generator lives under `src/` rather than `scripts/` because it imports
 * from `src/`, whose `.js` specifiers only the bundler and vitest resolve —
 * plain Node throws ERR_MODULE_NOT_FOUND on them (see CLAUDE.md and
 * scripts/__tests__/cli.test.ts).
 */
describe("config-schema.json", () => {
  const generated = buildConfigJsonSchema();

  if (process.env["UPDATE_CONFIG_SCHEMA"]) {
    it("regenerates the committed artifact", () => {
      fs.writeFileSync(SCHEMA_PATH, JSON.stringify(generated, null, 2) + "\n");
      expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    });
    return;
  }

  const committed = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

  it("matches what the code implies — run `npm run schema` if this fails", () => {
    expect(committed).toEqual(generated);
  });

  it("is committed in the exact formatting the generator emits", () => {
    // Deep equality above passes on any whitespace, so a hand-edit that
    // reflowed the file would leave `npm run schema` producing a diff forever.
    expect(fs.readFileSync(SCHEMA_PATH, "utf8")).toBe(JSON.stringify(generated, null, 2) + "\n");
  });

  // The three assertions below name the specific drifts #75 recorded. The
  // equality check above would catch them, but only as one opaque object diff;
  // these say which property regressed and why it mattered.
  it("offers every registered widget type", () => {
    const widgetEnum = (committed as never as SchemaShape).properties.lines.items.properties.widgets
      .items.properties.type.enum;
    expect([...widgetEnum].sort()).toEqual([...getWidgetTypes()].sort());
  });

  it("offers every widget type the default layout actually uses", () => {
    // The drift's sharpest symptom: the schema rejected four widgets that
    // ship in DEFAULT_SETTINGS, so it flagged the tool's own defaults invalid.
    const widgetEnum = new Set(
      (committed as never as SchemaShape).properties.lines.items.properties.widgets.items.properties
        .type.enum,
    );
    const shipped = DEFAULT_SETTINGS.lines.flatMap((line) => line.widgets.map((w) => w.type));
    expect(shipped.filter((t) => !widgetEnum.has(t))).toEqual([]);
  });

  it("documents the powerline defaults that actually ship", () => {
    // separatorThin was documented as U+E0B1, the dead-config value from
    // before PRs #39/#41 made thin separators live.
    const powerline = (committed as never as SchemaShape).properties.powerline.properties;
    expect(powerline.enabled.default).toBe(DEFAULT_SETTINGS.powerline.enabled);
    expect(powerline.separator.default).toBe(DEFAULT_SETTINGS.powerline.separator);
    expect(powerline.separatorThin.default).toBe(DEFAULT_SETTINGS.powerline.separatorThin);
  });

  it("describes the compact and alerts sections the loader accepts", () => {
    const properties = (committed as never as SchemaShape).properties;
    expect(Object.keys(properties.compact.properties).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS.compact).sort(),
    );
    expect(Object.keys(properties.alerts.properties).sort()).toEqual(
      Object.keys(DEFAULT_SETTINGS.alerts).sort(),
    );
  });
});

/** Just enough of the schema's shape to index into it without `any`. */
interface SchemaShape {
  properties: {
    lines: {
      items: {
        properties: {
          widgets: { items: { properties: { type: { enum: string[] } } } };
        };
      };
    };
    powerline: {
      properties: Record<"enabled" | "separator" | "separatorThin", { default: unknown }>;
    };
    compact: { properties: Record<string, unknown> };
    alerts: { properties: Record<string, unknown> };
  };
}
