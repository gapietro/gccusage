#!/usr/bin/env node
import * as fs$7 from "node:fs";
import * as fs$6 from "node:fs";
import * as fs$5 from "node:fs";
import * as fs$4 from "node:fs";
import * as fs$3 from "node:fs";
import * as fs$2 from "node:fs";
import * as fs$1 from "node:fs";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path$6 from "node:path";
import * as path$5 from "node:path";
import * as path$4 from "node:path";
import * as path$3 from "node:path";
import * as path$2 from "node:path";
import * as path$1 from "node:path";
import * as path from "node:path";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import process$1 from "node:process";
import os, { homedir } from "node:os";
import tty from "node:tty";
import { fileURLToPath } from "node:url";

//#region node_modules/valibot/dist/index.mjs
let store$4;
/**
* Returns the global configuration.
*
* @param config The config to merge.
*
* @returns The configuration.
*/
/* @__NO_SIDE_EFFECTS__ */
function getGlobalConfig(config$1) {
	return {
		lang: config$1?.lang ?? store$4?.lang,
		message: config$1?.message,
		abortEarly: config$1?.abortEarly ?? store$4?.abortEarly,
		abortPipeEarly: config$1?.abortPipeEarly ?? store$4?.abortPipeEarly
	};
}
let store$3;
/**
* Returns a global error message.
*
* @param lang The language of the message.
*
* @returns The error message.
*/
/* @__NO_SIDE_EFFECTS__ */
function getGlobalMessage(lang) {
	return store$3?.get(lang);
}
let store$2;
/**
* Returns a schema error message.
*
* @param lang The language of the message.
*
* @returns The error message.
*/
/* @__NO_SIDE_EFFECTS__ */
function getSchemaMessage(lang) {
	return store$2?.get(lang);
}
let store$1;
/**
* Returns a specific error message.
*
* @param reference The identifier reference.
* @param lang The language of the message.
*
* @returns The error message.
*/
/* @__NO_SIDE_EFFECTS__ */
function getSpecificMessage(reference, lang) {
	return store$1?.get(reference)?.get(lang);
}
/**
* Stringifies an unknown input to a literal or type string.
*
* @param input The unknown input.
*
* @returns A literal or type string.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _stringify(input) {
	const type = typeof input;
	if (type === "string") return `"${input}"`;
	if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
	if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
	return type;
}
/**
* Adds an issue to the dataset.
*
* @param context The issue context.
* @param label The issue label.
* @param dataset The input dataset.
* @param config The configuration.
* @param other The optional props.
*
* @internal
*/
function _addIssue(context, label, dataset, config$1, other) {
	const input = other && "input" in other ? other.input : dataset.value;
	const expected = other?.expected ?? context.expects ?? null;
	const received = other?.received ?? /* @__PURE__ */ _stringify(input);
	const issue = {
		kind: context.kind,
		type: context.type,
		input,
		expected,
		received,
		message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
		requirement: context.requirement,
		path: other?.path,
		issues: other?.issues,
		lang: config$1.lang,
		abortEarly: config$1.abortEarly,
		abortPipeEarly: config$1.abortPipeEarly
	};
	const isSchema = context.kind === "schema";
	const message$1 = other?.message ?? context.message ?? /* @__PURE__ */ getSpecificMessage(context.reference, issue.lang) ?? (isSchema ? /* @__PURE__ */ getSchemaMessage(issue.lang) : null) ?? config$1.message ?? /* @__PURE__ */ getGlobalMessage(issue.lang);
	if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
	if (isSchema) dataset.typed = false;
	if (dataset.issues) dataset.issues.push(issue);
	else dataset.issues = [issue];
}
/**
* Returns the Standard Schema properties.
*
* @param context The schema context.
*
* @returns The Standard Schema properties.
*/
/* @__NO_SIDE_EFFECTS__ */
function _getStandardProps(context) {
	return {
		version: 1,
		vendor: "valibot",
		validate(value$1) {
			return context["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig());
		}
	};
}
/**
* Joins multiple `expects` values with the given separator.
*
* @param values The `expects` values.
* @param separator The separator.
*
* @returns The joined `expects` property.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _joinExpects(values$1, separator) {
	const list = [...new Set(values$1)];
	if (list.length > 1) return `(${list.join(` ${separator} `)})`;
	return list[0] ?? "never";
}
/**
* A Valibot error with useful information.
*/
var ValiError = class extends Error {
	/**
	* Creates a Valibot error with useful information.
	*
	* @param issues The error issues.
	*/
	constructor(issues) {
		super(issues[0].message);
		this.name = "ValiError";
		this.issues = issues;
	}
};
/**
* Returns the fallback value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The output dataset if available.
* @param config The config if available.
*
* @returns The fallback value.
*/
/* @__NO_SIDE_EFFECTS__ */
function getFallback(schema, dataset, config$1) {
	return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
/**
* Returns the default value of the schema.
*
* @param schema The schema to get it from.
* @param dataset The input dataset if available.
* @param config The config if available.
*
* @returns The default value.
*/
/* @__NO_SIDE_EFFECTS__ */
function getDefault(schema, dataset, config$1) {
	return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
/* @__NO_SIDE_EFFECTS__ */
function array(item, message$1) {
	return {
		kind: "schema",
		type: "array",
		reference: array,
		expects: "Array",
		async: false,
		item,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (Array.isArray(input)) {
				dataset.typed = true;
				dataset.value = [];
				for (let key = 0; key < input.length; key++) {
					const value$1 = input[key];
					const itemDataset = this.item["~run"]({ value: value$1 }, config$1);
					if (itemDataset.issues) {
						const pathItem = {
							type: "array",
							origin: "value",
							input,
							key,
							value: value$1
						};
						for (const issue of itemDataset.issues) {
							if (issue.path) issue.path.unshift(pathItem);
							else issue.path = [pathItem];
							dataset.issues?.push(issue);
						}
						if (!dataset.issues) dataset.issues = itemDataset.issues;
						if (config$1.abortEarly) {
							dataset.typed = false;
							break;
						}
					}
					if (!itemDataset.typed) dataset.typed = false;
					dataset.value.push(itemDataset.value);
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function boolean(message$1) {
	return {
		kind: "schema",
		type: "boolean",
		reference: boolean,
		expects: "boolean",
		async: false,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "boolean") dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function nullable(wrapped, default_) {
	return {
		kind: "schema",
		type: "nullable",
		reference: nullable,
		expects: `(${wrapped.expects} | null)`,
		async: false,
		wrapped,
		default: default_,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (dataset.value === null) {
				if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
				if (dataset.value === null) {
					dataset.typed = true;
					return dataset;
				}
			}
			return this.wrapped["~run"](dataset, config$1);
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function number(message$1) {
	return {
		kind: "schema",
		type: "number",
		reference: number,
		expects: "number",
		async: false,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function object(entries$1, message$1) {
	return {
		kind: "schema",
		type: "object",
		reference: object,
		expects: "Object",
		async: false,
		entries: entries$1,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			const input = dataset.value;
			if (input && typeof input === "object") {
				dataset.typed = true;
				dataset.value = {};
				for (const key in this.entries) {
					const valueSchema = this.entries[key];
					if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
						const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
						const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
						if (valueDataset.issues) {
							const pathItem = {
								type: "object",
								origin: "value",
								input,
								key,
								value: value$1
							};
							for (const issue of valueDataset.issues) {
								if (issue.path) issue.path.unshift(pathItem);
								else issue.path = [pathItem];
								dataset.issues?.push(issue);
							}
							if (!dataset.issues) dataset.issues = valueDataset.issues;
							if (config$1.abortEarly) {
								dataset.typed = false;
								break;
							}
						}
						if (!valueDataset.typed) dataset.typed = false;
						dataset.value[key] = valueDataset.value;
					} else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
					else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
						_addIssue(this, "key", dataset, config$1, {
							input: void 0,
							expected: `"${key}"`,
							path: [{
								type: "object",
								origin: "key",
								input,
								key,
								value: input[key]
							}]
						});
						if (config$1.abortEarly) break;
					}
				}
			} else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function optional(wrapped, default_) {
	return {
		kind: "schema",
		type: "optional",
		reference: optional,
		expects: `(${wrapped.expects} | undefined)`,
		async: false,
		wrapped,
		default: default_,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (dataset.value === void 0) {
				if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
				if (dataset.value === void 0) {
					dataset.typed = true;
					return dataset;
				}
			}
			return this.wrapped["~run"](dataset, config$1);
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function picklist(options, message$1) {
	return {
		kind: "schema",
		type: "picklist",
		reference: picklist,
		expects: /* @__PURE__ */ _joinExpects(options.map(_stringify), "|"),
		async: false,
		options,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (this.options.includes(dataset.value)) dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/* @__NO_SIDE_EFFECTS__ */
function string(message$1) {
	return {
		kind: "schema",
		type: "string",
		reference: string,
		expects: "string",
		async: false,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			if (typeof dataset.value === "string") dataset.typed = true;
			else _addIssue(this, "type", dataset, config$1);
			return dataset;
		}
	};
}
/**
* Returns the sub issues of the provided datasets for the union issue.
*
* @param datasets The datasets.
*
* @returns The sub issues.
*
* @internal
*/
/* @__NO_SIDE_EFFECTS__ */
function _subIssues(datasets) {
	let issues;
	if (datasets) for (const dataset of datasets) if (issues) issues.push(...dataset.issues);
	else issues = dataset.issues;
	return issues;
}
/* @__NO_SIDE_EFFECTS__ */
function union(options, message$1) {
	return {
		kind: "schema",
		type: "union",
		reference: union,
		expects: /* @__PURE__ */ _joinExpects(options.map((option) => option.expects), "|"),
		async: false,
		options,
		message: message$1,
		get "~standard"() {
			return /* @__PURE__ */ _getStandardProps(this);
		},
		"~run"(dataset, config$1) {
			let validDataset;
			let typedDatasets;
			let untypedDatasets;
			for (const schema of this.options) {
				const optionDataset = schema["~run"]({ value: dataset.value }, config$1);
				if (optionDataset.typed) if (optionDataset.issues) if (typedDatasets) typedDatasets.push(optionDataset);
				else typedDatasets = [optionDataset];
				else {
					validDataset = optionDataset;
					break;
				}
				else if (untypedDatasets) untypedDatasets.push(optionDataset);
				else untypedDatasets = [optionDataset];
			}
			if (validDataset) return validDataset;
			if (typedDatasets) {
				if (typedDatasets.length === 1) return typedDatasets[0];
				_addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(typedDatasets) });
				dataset.typed = true;
			} else if (untypedDatasets?.length === 1) return untypedDatasets[0];
			else _addIssue(this, "type", dataset, config$1, { issues: /* @__PURE__ */ _subIssues(untypedDatasets) });
			return dataset;
		}
	};
}
/**
* Parses an unknown input based on a schema.
*
* @param schema The schema to be used.
* @param input The input to be parsed.
* @param config The parse configuration.
*
* @returns The parsed input.
*/
function parse(schema, input, config$1) {
	const dataset = schema["~run"]({ value: input }, /* @__PURE__ */ getGlobalConfig(config$1));
	if (dataset.issues) throw new ValiError(dataset.issues);
	return dataset.value;
}

//#endregion
//#region src/types/status-json.ts
const ModelSchema = union([string(), object({
	id: optional(string()),
	display_name: optional(string())
})]);
const CostSchema = object({
	total_cost_usd: optional(number()),
	total_duration_ms: optional(number()),
	total_api_duration_ms: optional(number()),
	total_lines_added: optional(number()),
	total_lines_removed: optional(number())
});
const CurrentUsageSchema = object({
	input_tokens: optional(number(), 0),
	output_tokens: optional(number(), 0),
	cache_creation_input_tokens: optional(number(), 0),
	cache_read_input_tokens: optional(number(), 0)
});
const ContextWindowSchema = union([number(), object({
	context_window_size: optional(number()),
	used_percentage: optional(nullable(number())),
	remaining_percentage: optional(nullable(number())),
	total_input_tokens: optional(number()),
	total_output_tokens: optional(number()),
	current_usage: optional(nullable(CurrentUsageSchema))
})]);
const TokenUsageSchema = object({
	input_tokens: optional(number(), 0),
	output_tokens: optional(number(), 0),
	cache_creation_input_tokens: optional(number(), 0),
	cache_read_input_tokens: optional(number(), 0)
});
const VimSchema = object({ mode: optional(string()) });
const StatusJsonSchema = object({
	model: optional(ModelSchema),
	cost: optional(CostSchema),
	context_window: optional(ContextWindowSchema),
	token_usage: optional(TokenUsageSchema),
	vim: optional(VimSchema),
	cwd: optional(string()),
	session_id: optional(string())
});

//#endregion
//#region src/data/stdin-reader.ts
function readStdin() {
	return new Promise((resolve$1, reject) => {
		const chunks = [];
		const timeout = setTimeout(() => {
			process.stdin.destroy();
			resolve$1("");
		}, 1e3);
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => {
			clearTimeout(timeout);
			resolve$1(Buffer.concat(chunks).toString("utf-8"));
		});
		process.stdin.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		process.stdin.resume();
	});
}
function parseStatusJson(raw) {
	if (!raw.trim()) return null;
	try {
		const data = JSON.parse(raw);
		return parse(StatusJsonSchema, data);
	} catch {
		return null;
	}
}

//#endregion
//#region src/config/schema.ts
const ColorSchema = union([string()]);
const WidgetConfigSchema = object({
	type: string(),
	label: optional(string()),
	fg: optional(ColorSchema),
	bg: optional(ColorSchema),
	icon: optional(string()),
	format: optional(string()),
	command: optional(string()),
	text: optional(string()),
	separator: optional(string()),
	maxWidth: optional(number()),
	priority: optional(number())
});
const LineConfigSchema = object({
	widgets: array(WidgetConfigSchema),
	flex: optional(picklist([
		"left",
		"right",
		"center",
		"space-between"
	]), "left")
});
const PowerlineConfigSchema = object({
	enabled: optional(boolean(), false),
	theme: optional(string(), "default"),
	separator: optional(string(), ""),
	separatorThin: optional(string(), "")
});
const CacheConfigSchema = object({
	statuslineTtlMs: optional(number(), 5e3),
	pricingTtlMs: optional(number(), 864e5)
});
const CompactConfigSchema = object({
	mode: optional(picklist([
		"auto",
		"always",
		"never"
	]), "auto"),
	threshold: optional(number(), 80)
});
const AlertsConfigSchema = object({
	sessionWarn: optional(number(), 5),
	sessionDanger: optional(number(), 15),
	dailyWarn: optional(number(), 10),
	dailyDanger: optional(number(), 25)
});
const SettingsSchema = object({
	lines: optional(array(LineConfigSchema)),
	powerline: optional(PowerlineConfigSchema),
	compact: optional(CompactConfigSchema),
	alerts: optional(AlertsConfigSchema),
	cache: optional(CacheConfigSchema),
	costSource: optional(picklist([
		"auto",
		"calculated",
		"stdin"
	]), "auto")
});

//#endregion
//#region src/config/defaults.ts
const DEFAULT_SETTINGS = {
	lines: [{
		widgets: [
			{
				type: "model",
				fg: "#ffffff",
				bg: "#1a5fb4",
				priority: 1
			},
			{
				type: "session-cost",
				fg: "#ffffff",
				bg: "#26a269",
				priority: 2
			},
			{
				type: "context-percent",
				fg: "#ffffff",
				bg: "#0d7377",
				priority: 3
			},
			{
				type: "burn-rate",
				fg: "#ffffff",
				bg: "#555555",
				priority: 7
			},
			{
				type: "cache-hit-rate",
				fg: "#ffffff",
				bg: "#1a5fb4",
				priority: 8
			}
		],
		flex: "left"
	}, {
		widgets: [
			{
				type: "git-branch",
				fg: "#ffffff",
				bg: "#613583",
				priority: 4
			},
			{
				type: "git-changes",
				fg: "#ffffff",
				bg: "#613583",
				priority: 9
			},
			{
				type: "lines-changed",
				fg: "#ffffff",
				bg: "#0d7377",
				priority: 10
			},
			{
				type: "today-spend",
				fg: "#ffffff",
				bg: "#26a269",
				priority: 5
			},
			{
				type: "api-latency",
				fg: "#ffffff",
				bg: "#555555",
				priority: 6
			},
			{ type: "vim-mode" }
		],
		flex: "left"
	}],
	powerline: {
		enabled: true,
		theme: "default",
		separator: "▶",
		separatorThin: "│"
	},
	compact: {
		mode: "auto",
		threshold: 80
	},
	alerts: {
		sessionWarn: 5,
		sessionDanger: 15,
		dailyWarn: 10,
		dailyDanger: 25
	},
	cache: {
		statuslineTtlMs: 5e3,
		pricingTtlMs: 864e5
	},
	costSource: "auto"
};

//#endregion
//#region src/config/loader.ts
function getConfigDir() {
	const xdg = process.env["XDG_CONFIG_HOME"];
	if (xdg) return path$6.join(xdg, "gccusage");
	return path$6.join(process.env["HOME"] || "~", ".config", "gccusage");
}
function getConfigPath() {
	return path$6.join(getConfigDir(), "settings.json");
}
/** Shallow-merge only keys that exist in the source object. */
function mergeIfPresent(defaults, raw, validated) {
	if (!raw || !validated) return defaults;
	const result = { ...defaults };
	for (const key of Object.keys(raw)) if (key in validated) result[key] = validated[key];
	return result;
}
/** Deep-merge user overrides onto defaults, only overriding keys the user actually set. */
function mergeSettings(defaults, raw, validated) {
	return {
		lines: validated.lines ?? defaults.lines,
		powerline: mergeIfPresent(defaults.powerline ?? {}, raw["powerline"], validated.powerline),
		compact: mergeIfPresent(defaults.compact ?? {}, raw["compact"], validated.compact),
		alerts: mergeIfPresent(defaults.alerts ?? {}, raw["alerts"], validated.alerts),
		cache: mergeIfPresent(defaults.cache ?? {}, raw["cache"], validated.cache),
		costSource: "costSource" in raw ? validated.costSource ?? defaults.costSource : defaults.costSource
	};
}
function loadSettings() {
	const configPath = getConfigPath();
	if (!fs$7.existsSync(configPath)) return DEFAULT_SETTINGS;
	try {
		const raw = fs$7.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		const validated = parse(SettingsSchema, parsed);
		return mergeSettings(DEFAULT_SETTINGS, parsed, validated);
	} catch {
		return DEFAULT_SETTINGS;
	}
}

//#endregion
//#region src/utils/paths.ts
function getClaudeDataDir() {
	const home = process.env["HOME"] || "~";
	return path$5.join(home, ".claude");
}
function getProjectsDir() {
	return path$5.join(getClaudeDataDir(), "projects");
}
function getCacheDir() {
	const xdg = process.env["XDG_CACHE_HOME"];
	if (xdg) return path$5.join(xdg, "gccusage");
	return path$5.join(process.env["HOME"] || "~", ".cache", "gccusage");
}
function ensureDir(dir) {
	if (!fs$6.existsSync(dir)) fs$6.mkdirSync(dir, { recursive: true });
}
function findJsonlFiles(dir) {
	if (!fs$6.existsSync(dir)) return [];
	try {
		return fs$6.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path$5.join(dir, f));
	} catch {
		return [];
	}
}
function findSessionJsonlFiles(sessionId) {
	const projectsDir = getProjectsDir();
	if (!fs$6.existsSync(projectsDir)) return [];
	const files = [];
	try {
		for (const projectDir of fs$6.readdirSync(projectsDir)) {
			const fullPath = path$5.join(projectsDir, projectDir);
			const stat = fs$6.statSync(fullPath);
			if (!stat.isDirectory()) continue;
			const jsonlFiles = findJsonlFiles(fullPath);
			if (sessionId) files.push(...jsonlFiles.filter((f) => path$5.basename(f, ".jsonl") === sessionId));
			else files.push(...jsonlFiles);
		}
	} catch {}
	return files;
}
function findTodayJsonlFiles() {
	const projectsDir = getProjectsDir();
	if (!fs$6.existsSync(projectsDir)) return [];
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayMs = todayStart.getTime();
	const files = [];
	try {
		for (const projectDir of fs$6.readdirSync(projectsDir)) {
			const fullPath = path$5.join(projectsDir, projectDir);
			const stat = fs$6.statSync(fullPath);
			if (!stat.isDirectory()) continue;
			for (const f of findJsonlFiles(fullPath)) {
				const fstat = fs$6.statSync(f);
				if (fstat.mtimeMs >= todayMs) files.push(f);
			}
		}
	} catch {}
	return files;
}

//#endregion
//#region src/data/jsonl-reader.ts
function parseJsonlFile(filePath) {
	if (!fs$5.existsSync(filePath)) return [];
	try {
		const content = fs$5.readFileSync(filePath, "utf-8");
		return parseJsonlContent(content);
	} catch {
		return [];
	}
}
function parseJsonlContent(content) {
	const entries = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			entries.push(normalizeEntry(parsed));
		} catch {}
	}
	return entries;
}
function normalizeEntry(raw) {
	const entry = {};
	if (typeof raw["type"] === "string") entry.type = raw["type"];
	if (typeof raw["model"] === "string") entry.model = raw["model"];
	if (typeof raw["costUsd"] === "number") entry.costUsd = raw["costUsd"];
	if (typeof raw["timestamp"] === "string") entry.timestamp = raw["timestamp"];
	if (typeof raw["sessionId"] === "string") entry.sessionId = raw["sessionId"];
	const usage = raw["usage"];
	if (usage && typeof usage === "object") entry.usage = {
		input_tokens: typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : void 0,
		output_tokens: typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : void 0,
		cache_creation_input_tokens: typeof usage["cache_creation_input_tokens"] === "number" ? usage["cache_creation_input_tokens"] : void 0,
		cache_read_input_tokens: typeof usage["cache_read_input_tokens"] === "number" ? usage["cache_read_input_tokens"] : void 0
	};
	return entry;
}

//#endregion
//#region src/data/token-aggregator.ts
function emptyMetrics() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0
	};
}
function addUsage(target, entry) {
	if (!entry.usage) return;
	target.inputTokens += entry.usage.input_tokens ?? 0;
	target.outputTokens += entry.usage.output_tokens ?? 0;
	target.cacheCreationTokens += entry.usage.cache_creation_input_tokens ?? 0;
	target.cacheReadTokens += entry.usage.cache_read_input_tokens ?? 0;
}
function aggregateTokens(sessionEntries, todayEntries) {
	const byModel = new Map();
	const session = emptyMetrics();
	const today = emptyMetrics();
	for (const entry of sessionEntries) {
		if (!entry.usage) continue;
		addUsage(session, entry);
		if (entry.model) {
			let model = byModel.get(entry.model);
			if (!model) {
				model = emptyMetrics();
				byModel.set(entry.model, model);
			}
			addUsage(model, entry);
		}
	}
	for (const entry of todayEntries) {
		if (!entry.usage) continue;
		addUsage(today, entry);
	}
	return {
		byModel,
		session,
		today
	};
}
function getFirstTimestamp(entries) {
	for (const entry of entries) if (entry.timestamp) {
		const ts = new Date(entry.timestamp).getTime();
		if (!isNaN(ts)) return ts;
	}
	return null;
}

//#endregion
//#region src/types/block-metrics.ts
const BLOCK_DURATION_MS = 5 * 60 * 60 * 1e3;

//#endregion
//#region src/cache/block-cache.ts
function getBlockCachePath() {
	return path$4.join(getCacheDir(), "blocks", "current.json");
}
function loadBlockCache() {
	const cachePath = getBlockCachePath();
	try {
		if (!fs$4.existsSync(cachePath)) return null;
		const raw = fs$4.readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (Date.now() - data.blockStartTime > BLOCK_DURATION_MS) {
			fs$4.unlinkSync(cachePath);
			return null;
		}
		return data;
	} catch {
		return null;
	}
}
function saveBlockCache(data) {
	const cachePath = getBlockCachePath();
	try {
		ensureDir(path$4.dirname(cachePath));
		fs$4.writeFileSync(cachePath, JSON.stringify(data));
	} catch {}
}

//#endregion
//#region src/data/block-tracker.ts
function detectBlock(sessionStartTime) {
	const now = Date.now();
	const cached = loadBlockCache();
	if (cached) {
		const elapsed = now - cached.blockStartTime;
		if (elapsed < BLOCK_DURATION_MS) return {
			blockStartTime: cached.blockStartTime,
			elapsedMs: elapsed,
			remainingMs: BLOCK_DURATION_MS - elapsed,
			blockDurationMs: BLOCK_DURATION_MS
		};
	}
	if (sessionStartTime !== null) {
		const elapsed = now - sessionStartTime;
		if (elapsed < BLOCK_DURATION_MS) {
			saveBlockCache({ blockStartTime: sessionStartTime });
			return {
				blockStartTime: sessionStartTime,
				elapsedMs: elapsed,
				remainingMs: BLOCK_DURATION_MS - elapsed,
				blockDurationMs: BLOCK_DURATION_MS
			};
		}
	}
	return null;
}

//#endregion
//#region src/cache/pricing-cache.ts
function getCachePath$1() {
	return path$3.join(getCacheDir(), "pricing.json");
}
function loadPricingCache(ttlMs) {
	const cachePath = getCachePath$1();
	try {
		if (!fs$3.existsSync(cachePath)) return null;
		const raw = fs$3.readFileSync(cachePath, "utf-8");
		const cache = JSON.parse(raw);
		if (Date.now() - cache.timestamp < ttlMs) return cache.data;
	} catch {}
	return null;
}
function savePricingCache(data) {
	const cachePath = getCachePath$1();
	try {
		ensureDir(path$3.dirname(cachePath));
		const cache = {
			timestamp: Date.now(),
			data
		};
		fs$3.writeFileSync(cachePath, JSON.stringify(cache));
	} catch {}
}

//#endregion
//#region src/data/pricing-fetcher.ts
const FALLBACK_PRICING = {
	"claude-opus-4-20250514": {
		inputCostPerToken: 15 / 1e6,
		outputCostPerToken: 75 / 1e6,
		cacheCreationCostPerToken: 18.75 / 1e6,
		cacheReadCostPerToken: 1.5 / 1e6
	},
	"claude-sonnet-4-20250514": {
		inputCostPerToken: 3 / 1e6,
		outputCostPerToken: 15 / 1e6,
		cacheCreationCostPerToken: 3.75 / 1e6,
		cacheReadCostPerToken: .3 / 1e6
	},
	"claude-haiku-3.5-20241001": {
		inputCostPerToken: .8 / 1e6,
		outputCostPerToken: 4 / 1e6,
		cacheCreationCostPerToken: 1 / 1e6,
		cacheReadCostPerToken: .08 / 1e6
	}
};
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
function parseLitellmPricing(data) {
	const table = {};
	for (const [key, value] of Object.entries(data)) {
		if (!key.startsWith("claude-") || typeof value !== "object" || !value) continue;
		const model = value;
		const inputCost = model["input_cost_per_token"];
		const outputCost = model["output_cost_per_token"];
		if (typeof inputCost !== "number" || typeof outputCost !== "number") continue;
		const pricing = {
			inputCostPerToken: inputCost,
			outputCostPerToken: outputCost,
			cacheCreationCostPerToken: typeof model["cache_creation_input_token_cost"] === "number" ? model["cache_creation_input_token_cost"] : inputCost * 1.25,
			cacheReadCostPerToken: typeof model["cache_read_input_token_cost"] === "number" ? model["cache_read_input_token_cost"] : inputCost * .1
		};
		const modelId = key.includes("/") ? key.split("/").pop() : key;
		table[modelId] = pricing;
		if (key !== modelId) table[key] = pricing;
	}
	return table;
}
async function fetchPricing(ttlMs) {
	const cached = loadPricingCache(ttlMs);
	if (cached) return cached;
	try {
		const response = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(5e3) });
		if (response.ok) {
			const data = await response.json();
			const pricing = parseLitellmPricing(data);
			if (Object.keys(pricing).length > 0) {
				savePricingCache(pricing);
				return {
					...FALLBACK_PRICING,
					...pricing
				};
			}
		}
	} catch {}
	return FALLBACK_PRICING;
}

//#endregion
//#region src/data/cost-calculator.ts
function calculateCost(metrics, pricing) {
	return metrics.inputTokens * pricing.inputCostPerToken + metrics.outputTokens * pricing.outputCostPerToken + metrics.cacheCreationTokens * pricing.cacheCreationCostPerToken + metrics.cacheReadTokens * pricing.cacheReadCostPerToken;
}
function calculateCostByModel(byModel, pricing) {
	const costs = new Map();
	for (const [model, metrics] of byModel) {
		const modelPricing = findPricing(model, pricing);
		if (modelPricing) costs.set(model, calculateCost(metrics, modelPricing));
	}
	return costs;
}
function calculateTotalCost(costByModel) {
	let total = 0;
	for (const cost of costByModel.values()) total += cost;
	return total;
}
function findPricing(model, table) {
	if (table[model]) return table[model];
	const stripped = model.replace(/^claude\//, "");
	if (table[stripped]) return table[stripped];
	for (const key of Object.keys(table)) if (key.includes(model) || model.includes(key)) return table[key];
	return null;
}
function calculateBurnRate(sessionMetrics, sessionStartTime, pricing, sessionModel) {
	if (!sessionStartTime) return null;
	const elapsedMs = Date.now() - sessionStartTime;
	if (elapsedMs < 1e4) return null;
	const elapsedMinutes = elapsedMs / 6e4;
	const totalTokens = sessionMetrics.inputTokens + sessionMetrics.outputTokens + sessionMetrics.cacheCreationTokens + sessionMetrics.cacheReadTokens;
	const tokensPerMinute = totalTokens / elapsedMinutes;
	let costPerMinute = 0;
	if (sessionModel) {
		const modelPricing = findPricing(sessionModel, pricing);
		if (modelPricing) {
			const sessionCost = calculateCost(sessionMetrics, modelPricing);
			costPerMinute = sessionCost / elapsedMinutes;
		}
	}
	return {
		tokensPerMinute,
		costPerHour: costPerMinute * 60,
		costPerMinute
	};
}

//#endregion
//#region src/utils/terminal.ts
function getTerminalWidth() {
	return process.stdout.columns || 80;
}
function stripAnsi(str) {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
function visibleLength(str) {
	return stripAnsi(str).length;
}

//#endregion
//#region src/data/daily-cost-tracker.ts
function getDailyCostPath() {
	return path$2.join(getCacheDir(), "daily-costs.json");
}
function todayDateStr() {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}
function readDailyCostFile() {
	const filePath = getDailyCostPath();
	try {
		const raw = fs$2.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (data.date !== todayDateStr()) return {
			date: todayDateStr(),
			sessions: []
		};
		return data;
	} catch {
		return {
			date: todayDateStr(),
			sessions: []
		};
	}
}
function writeDailyCostFile(data) {
	const filePath = getDailyCostPath();
	ensureDir(path$2.dirname(filePath));
	fs$2.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}
/**
* Record the current session's cost and return today's total across all sessions.
*/
function trackDailyCost(sessionId, costUsd) {
	const data = readDailyCostFile();
	if (sessionId) {
		const existing = data.sessions.find((s) => s.sessionId === sessionId);
		if (existing) {
			existing.costUsd = costUsd;
			existing.updatedAt = Date.now();
		} else data.sessions.push({
			sessionId,
			costUsd,
			updatedAt: Date.now()
		});
		writeDailyCostFile(data);
	}
	let total = 0;
	for (const s of data.sessions) total += s.costUsd;
	return total;
}

//#endregion
//#region src/data/turn-tracker.ts
function getTurnPath() {
	return path$1.join(getCacheDir(), "turn-count.json");
}
/**
* Increment and return the turn count for the given session.
* Resets when session ID changes.
*/
function trackTurn(sessionId) {
	if (!sessionId) return 0;
	const filePath = getTurnPath();
	let data = {
		sessionId: "",
		count: 0
	};
	try {
		const raw = fs$1.readFileSync(filePath, "utf-8");
		data = JSON.parse(raw);
	} catch {}
	if (data.sessionId !== sessionId) data = {
		sessionId,
		count: 0
	};
	data.count++;
	ensureDir(path$1.dirname(filePath));
	fs$1.writeFileSync(filePath, JSON.stringify(data), "utf-8");
	return data.count;
}

//#endregion
//#region src/data/pipeline.ts
function getStdinBurnRate(stdin) {
	const durationMs = stdin.cost?.total_duration_ms;
	if (!durationMs || durationMs < 1e4) return null;
	const cw = stdin.context_window;
	if (typeof cw !== "object" || !cw) return null;
	const totalTokens = (cw.total_input_tokens ?? 0) + (cw.total_output_tokens ?? 0);
	if (totalTokens === 0) return null;
	const elapsedMinutes = durationMs / 6e4;
	const tokensPerMinute = totalTokens / elapsedMinutes;
	const costUsd = stdin.cost?.total_cost_usd ?? 0;
	const costPerMinute = costUsd / elapsedMinutes;
	return {
		tokensPerMinute,
		costPerHour: costPerMinute * 60,
		costPerMinute
	};
}
async function buildRenderContext(stdin, settings) {
	const sessionFiles = findSessionJsonlFiles(stdin.session_id);
	const todayFiles = findTodayJsonlFiles();
	const sessionEntries = sessionFiles.flatMap(parseJsonlFile);
	const todayEntries = todayFiles.flatMap(parseJsonlFile);
	const metrics = aggregateTokens(sessionEntries, todayEntries);
	const pricing = await fetchPricing(settings.cache?.pricingTtlMs ?? 864e5);
	const costByModel = calculateCostByModel(metrics.byModel, pricing);
	const calculatedSessionCost = calculateTotalCost(costByModel);
	const todayCostByModel = calculateCostByModel(aggregateTokens(todayEntries, []).byModel, pricing);
	const calculatedTodayCost = calculateTotalCost(todayCostByModel);
	const stdinCost = stdin.cost?.total_cost_usd;
	let sessionCostUsd;
	if (settings.costSource === "stdin" && stdinCost !== void 0) sessionCostUsd = stdinCost;
	else if (settings.costSource === "calculated") sessionCostUsd = calculatedSessionCost;
	else sessionCostUsd = stdinCost ?? calculatedSessionCost;
	const todayCostUsd = trackDailyCost(stdin.session_id, sessionCostUsd);
	const sessionStartTime = getFirstTimestamp(sessionEntries);
	const block = detectBlock(sessionStartTime);
	const modelId = typeof stdin.model === "string" ? stdin.model : stdin.model?.id;
	const burnRate = getStdinBurnRate(stdin) ?? calculateBurnRate(metrics.session, sessionStartTime, pricing, modelId);
	return {
		stdin,
		metrics,
		block,
		burnRate,
		pricing,
		sessionCostUsd,
		todayCostUsd,
		costByModel,
		sessionStartTime,
		terminalWidth: getTerminalWidth(),
		turnCount: trackTurn(stdin.session_id),
		alerts: {
			sessionWarn: settings.alerts?.sessionWarn ?? 5,
			sessionDanger: settings.alerts?.sessionDanger ?? 15,
			dailyWarn: settings.alerts?.dailyWarn ?? 10,
			dailyDanger: settings.alerts?.dailyDanger ?? 25
		}
	};
}

//#endregion
//#region src/utils/format.ts
function formatDollars(amount) {
	if (amount < .01) return "$0.00";
	if (amount < 1) return `$${amount.toFixed(2)}`;
	if (amount < 100) return `$${amount.toFixed(2)}`;
	return `$${amount.toFixed(0)}`;
}
function formatTokens(count) {
	if (count < 1e3) return `${count}`;
	if (count < 1e6) return `${(count / 1e3).toFixed(1)}k`;
	return `${(count / 1e6).toFixed(2)}M`;
}
function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1e3);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds % 3600 / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}hr ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}
function formatPercent(ratio) {
	return `${Math.round(ratio * 100)}%`;
}
function formatModelName(model) {
	const match = model.match(/claude-(\w+)-(\d+)(?:[.-](\d{1,2})(?=-|$))?/);
	if (match) {
		const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
		const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
		return `${name} ${version}`;
	}
	return model;
}
function formatTokensPerMinute(tokPerMin) {
	if (tokPerMin < 1) return "0 tok/m";
	if (tokPerMin < 1e3) return `${tokPerMin.toFixed(1)} tok/m`;
	return `${(tokPerMin / 1e3).toFixed(1)}k tok/m`;
}

//#endregion
//#region src/widgets/model.ts
const modelWidget = { render(context, config) {
	const raw = context.stdin.model;
	if (!raw) return null;
	let name;
	if (typeof raw === "string") name = formatModelName(raw);
	else name = raw.id ? formatModelName(raw.id) : raw.display_name ?? "";
	if (!name) return null;
	const label = config.label ?? "";
	const icon = config.icon ?? "";
	const prefix = [icon, label].filter(Boolean).join(" ");
	const text = prefix ? `${prefix} ${name}` : name;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/session-cost.ts
function alertBg$1(cost, warn, danger, configBg) {
	if (cost >= danger) return "#c01c28";
	if (cost >= warn) return "#a67c00";
	return configBg;
}
const sessionCostWidget = { render(context, config) {
	const cost = context.sessionCostUsd;
	const label = config.label ?? "";
	const text = label ? `${label} ${formatDollars(cost)}` : formatDollars(cost);
	const bg = alertBg$1(cost, context.alerts.sessionWarn, context.alerts.sessionDanger, config.bg);
	return {
		text,
		fg: config.fg,
		bg
	};
} };

//#endregion
//#region src/widgets/today-spend.ts
function alertBg(cost, warn, danger, configBg) {
	if (cost >= danger) return "#c01c28";
	if (cost >= warn) return "#a67c00";
	return configBg;
}
const todaySpendWidget = { render(context, config) {
	const cost = context.todayCostUsd;
	const label = config.label ?? "Today:";
	const text = `${label} ${formatDollars(cost)}`;
	const bg = alertBg(cost, context.alerts.dailyWarn, context.alerts.dailyDanger, config.bg);
	return {
		text,
		fg: config.fg,
		bg
	};
} };

//#endregion
//#region src/widgets/block-timer.ts
const blockTimerWidget = { render(context, config) {
	if (!context.block) return null;
	const label = config.label ?? "Block:";
	const text = `${label} ${formatDuration(context.block.elapsedMs)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/burn-rate.ts
const burnRateWidget = { render(context, config) {
	if (!context.burnRate) return null;
	const label = config.label ?? "";
	const text = label ? `${label} ${formatTokensPerMinute(context.burnRate.tokensPerMinute)}` : formatTokensPerMinute(context.burnRate.tokensPerMinute);
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/context-percent.ts
const BAR_WIDTH = 10;
const THRESHOLD_WARN = .7;
const THRESHOLD_DANGER = .9;
function buildBar(ratio) {
	const filled = Math.round(ratio * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;
	return "[" + "=".repeat(filled) + "-".repeat(empty) + "]";
}
function thresholdBg(ratio, configBg) {
	if (ratio >= THRESHOLD_DANGER) return "#c01c28";
	if (ratio >= THRESHOLD_WARN) return "#a67c00";
	return configBg;
}
const contextPercentWidget = { render(context, config) {
	const cw = context.stdin.context_window;
	const label = config.label ?? "";
	let ratio = null;
	let windowSize = null;
	if (typeof cw === "object" && cw !== null && cw !== void 0) {
		windowSize = cw.context_window_size ?? null;
		if (cw.remaining_percentage != null) ratio = (100 - cw.remaining_percentage) / 100;
		else if (cw.used_percentage != null) ratio = cw.used_percentage / 100;
		else if (cw.current_usage && windowSize && windowSize > 0) {
			const u = cw.current_usage;
			const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
			ratio = total / windowSize;
		}
	} else if (typeof cw === "number" && cw > 0) {
		windowSize = cw;
		const usage = context.stdin.token_usage;
		if (usage) {
			const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
			ratio = total / cw;
		}
	}
	if (ratio === null) return null;
	const bar = buildBar(ratio);
	const pct = formatPercent(ratio);
	const size = windowSize ? ` (${formatTokens(windowSize)})` : "";
	const text = label ? `${label} ${bar} ${pct}${size}` : `${bar} ${pct}${size}`;
	return {
		text,
		fg: config.fg,
		bg: thresholdBg(ratio, config.bg)
	};
} };

//#endregion
//#region src/utils/git.ts
function exec(cmd, cwd) {
	try {
		return execSync(cmd, {
			cwd,
			encoding: "utf-8",
			timeout: 2e3,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
	} catch {
		return null;
	}
}
function getGitBranch(cwd) {
	return exec("git rev-parse --abbrev-ref HEAD", cwd);
}
function getGitChanges(cwd) {
	const output = exec("git status --porcelain", cwd);
	if (output === null) return null;
	const changes = {
		added: 0,
		modified: 0,
		deleted: 0
	};
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const code = line.substring(0, 2);
		if (code.includes("?") || code.includes("A")) changes.added++;
		else if (code.includes("D")) changes.deleted++;
		else changes.modified++;
	}
	return changes;
}

//#endregion
//#region src/widgets/git-branch.ts
const gitBranchWidget = { render(context, config) {
	const branch = getGitBranch(context.stdin.cwd);
	if (!branch) return null;
	const icon = config.icon ?? "";
	const label = config.label ?? "";
	const prefix = [icon, label].filter(Boolean).join(" ");
	const text = prefix ? `${prefix} ${branch}` : branch;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/git-changes.ts
const gitChangesWidget = { render(context, config) {
	const changes = getGitChanges(context.stdin.cwd);
	if (!changes) return null;
	if (changes.added === 0 && changes.modified === 0 && changes.deleted === 0) return null;
	const parts = [];
	if (changes.added > 0) parts.push(`+${changes.added}`);
	if (changes.modified > 0) parts.push(`~${changes.modified}`);
	if (changes.deleted > 0) parts.push(`-${changes.deleted}`);
	const label = config.label ?? "";
	const text = label ? `${label} ${parts.join(" ")}` : parts.join(" ");
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/tokens-input.ts
const tokensInputWidget = { render(context, config) {
	const label = config.label ?? "In:";
	const text = `${label} ${formatTokens(context.metrics.session.inputTokens)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/tokens-output.ts
const tokensOutputWidget = { render(context, config) {
	const label = config.label ?? "Out:";
	const text = `${label} ${formatTokens(context.metrics.session.outputTokens)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/tokens-cached.ts
const tokensCachedWidget = { render(context, config) {
	const cached = context.metrics.session.cacheCreationTokens + context.metrics.session.cacheReadTokens;
	const label = config.label ?? "Cache:";
	const text = `${label} ${formatTokens(cached)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/per-model-breakdown.ts
const perModelBreakdownWidget = { render(context, config) {
	if (context.costByModel.size === 0) return null;
	const parts = [];
	for (const [model, cost] of context.costByModel) {
		const name = formatModelName(model);
		const short = name.split(" ").map((w) => w[0]).join("");
		parts.push(`${short}:${formatDollars(cost)}`);
	}
	const text = parts.join(" ");
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/session-clock.ts
const sessionClockWidget = { render(context, config) {
	if (!context.sessionStartTime) return null;
	const elapsed = Date.now() - context.sessionStartTime;
	const label = config.label ?? "";
	const text = label ? `${label} ${formatDuration(elapsed)}` : formatDuration(elapsed);
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/cwd.ts
const cwdWidget = { render(context, config) {
	let cwd = context.stdin.cwd;
	if (!cwd) return null;
	const home = process.env["HOME"];
	if (home && cwd.startsWith(home)) cwd = "~" + cwd.slice(home.length);
	const label = config.label ?? "";
	const text = label ? `${label} ${cwd}` : cwd;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/custom-text.ts
const customTextWidget = { render(_context, config) {
	const text = config.text ?? "";
	if (!text) return null;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/custom-command.ts
const commandCache = new Map();
const DEFAULT_TTL_MS = 3e4;
const DEFAULT_TIMEOUT_MS = 2e3;
const customCommandWidget = { render(context, config) {
	const command = config.command;
	if (!command) return null;
	const ttl = config.maxWidth ?? DEFAULT_TTL_MS;
	const now = Date.now();
	const cached = commandCache.get(command);
	if (cached && now - cached.timestamp < ttl) {
		const label = config.label;
		const text = label ? `${label} ${cached.output}` : cached.output;
		return {
			text,
			fg: config.fg,
			bg: config.bg
		};
	}
	try {
		const raw = execSync(command, {
			encoding: "utf-8",
			timeout: DEFAULT_TIMEOUT_MS,
			cwd: context.stdin.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		if (!raw) return null;
		const output = raw.split("\n")[0] ?? "";
		commandCache.set(command, {
			output,
			timestamp: now
		});
		const label = config.label;
		const text = label ? `${label} ${output}` : output;
		return {
			text,
			fg: config.fg,
			bg: config.bg
		};
	} catch {
		if (cached) {
			const label = config.label;
			const text = label ? `${label} ${cached.output}` : cached.output;
			return {
				text,
				fg: config.fg,
				bg: config.bg
			};
		}
		return null;
	}
} };

//#endregion
//#region src/widgets/separator.ts
const separatorWidget = { render(_context, config) {
	const text = config.separator ?? " | ";
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/cache-hit-rate.ts
const cacheHitRateWidget = { render(context, config) {
	const cw = context.stdin.context_window;
	if (typeof cw !== "object" || !cw?.current_usage) return null;
	const u = cw.current_usage;
	const reads = u.cache_read_input_tokens ?? 0;
	const creates = u.cache_creation_input_tokens ?? 0;
	const total = reads + creates;
	if (total === 0) return null;
	const hitRate = Math.round(reads / total * 100);
	const label = config.label ?? "Cache:";
	const text = `${label} ${hitRate}%`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/lines-changed.ts
const linesChangedWidget = { render(context, config) {
	const added = context.stdin.cost?.total_lines_added;
	const removed = context.stdin.cost?.total_lines_removed;
	if (added == null && removed == null) return null;
	const a = added ?? 0;
	const r = removed ?? 0;
	if (a === 0 && r === 0) return null;
	const parts = [];
	if (a > 0) parts.push(`+${a}`);
	if (r > 0) parts.push(`-${r}`);
	const label = config.label ?? "";
	const text = label ? `${label} ${parts.join(" ")}` : parts.join(" ");
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/vim-mode.ts
const MODE_COLORS = {
	NORMAL: "#26a269",
	INSERT: "#a67c00"
};
const vimModeWidget = { render(context, config) {
	const mode = context.stdin.vim?.mode;
	if (!mode) return null;
	const label = config.label ?? "";
	const text = label ? `${label} ${mode}` : mode;
	const bg = config.bg ?? MODE_COLORS[mode] ?? MODE_COLORS["NORMAL"];
	return {
		text,
		fg: config.fg ?? "#ffffff",
		bg
	};
} };

//#endregion
//#region src/widgets/api-latency.ts
const apiLatencyWidget = { render(context, config) {
	const apiMs = context.stdin.cost?.total_api_duration_ms;
	if (apiMs == null || apiMs === 0) return null;
	const label = config.label ?? "API:";
	const text = `${label} ${formatDuration(apiMs)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/token-breakdown.ts
const tokenBreakdownWidget = { render(context, config) {
	const cw = context.stdin.context_window;
	if (!cw || typeof cw !== "object") return null;
	const input = cw.total_input_tokens ?? 0;
	const output = cw.total_output_tokens ?? 0;
	if (input === 0 && output === 0) return null;
	const text = `In:${formatTokens(input)} Out:${formatTokens(output)}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/session-timer.ts
const sessionTimerWidget = { render(context, config) {
	const durationMs = context.stdin.cost?.total_duration_ms;
	if (!durationMs || durationMs < 1e3) return null;
	const label = config.label ?? "";
	const text = label ? `${label} ${formatDuration(durationMs)}` : formatDuration(durationMs);
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/compact-countdown.ts
const AUTOCOMPACT_BUFFER = .165;
const compactCountdownWidget = { render(context, config) {
	const cw = context.stdin.context_window;
	if (!cw || typeof cw !== "object") return null;
	const windowSize = cw.context_window_size;
	if (!windowSize) return null;
	const totalInput = cw.total_input_tokens ?? 0;
	const totalOutput = cw.total_output_tokens ?? 0;
	const usedTokens = totalInput + totalOutput;
	if (usedTokens === 0) return null;
	const compactThreshold = windowSize * (1 - AUTOCOMPACT_BUFFER);
	const remaining = Math.max(0, compactThreshold - usedTokens);
	if (remaining <= 0) return {
		text: "Compact imminent!",
		fg: "#ffffff",
		bg: "#c01c28"
	};
	const ratio = remaining / compactThreshold;
	let bg = config.bg;
	if (ratio < .1) bg = "#c01c28";
	else if (ratio < .25) bg = "#a67c00";
	const text = `~${formatTokens(remaining)} left`;
	return {
		text,
		fg: config.fg,
		bg
	};
} };

//#endregion
//#region src/widgets/turn-counter.ts
const turnCounterWidget = { render(context, config) {
	const count = context.turnCount;
	if (!count || count < 1) return null;
	const label = config.label ?? "#";
	const text = `${label}${count}`;
	return {
		text,
		fg: config.fg,
		bg: config.bg
	};
} };

//#endregion
//#region src/widgets/registry.ts
const WIDGET_MAP = {
	model: modelWidget,
	"session-cost": sessionCostWidget,
	"today-spend": todaySpendWidget,
	"block-timer": blockTimerWidget,
	"burn-rate": burnRateWidget,
	"context-percent": contextPercentWidget,
	"git-branch": gitBranchWidget,
	"git-changes": gitChangesWidget,
	"tokens-input": tokensInputWidget,
	"tokens-output": tokensOutputWidget,
	"tokens-cached": tokensCachedWidget,
	"per-model": perModelBreakdownWidget,
	"session-clock": sessionClockWidget,
	cwd: cwdWidget,
	"custom-text": customTextWidget,
	"custom-command": customCommandWidget,
	separator: separatorWidget,
	"cache-hit-rate": cacheHitRateWidget,
	"lines-changed": linesChangedWidget,
	"vim-mode": vimModeWidget,
	"api-latency": apiLatencyWidget,
	"token-breakdown": tokenBreakdownWidget,
	"session-timer": sessionTimerWidget,
	"compact-countdown": compactCountdownWidget,
	"turn-counter": turnCounterWidget
};
function getWidget(type) {
	return WIDGET_MAP[type] ?? null;
}

//#endregion
//#region node_modules/chalk/source/vendor/ansi-styles/index.js
const ANSI_BACKGROUND_OFFSET = 10;
const wrapAnsi16 = (offset = 0) => (code) => `\u001B[${code + offset}m`;
const wrapAnsi256 = (offset = 0) => (code) => `\u001B[${38 + offset};5;${code}m`;
const wrapAnsi16m = (offset = 0) => (red, green, blue) => `\u001B[${38 + offset};2;${red};${green};${blue}m`;
const styles$1 = {
	modifier: {
		reset: [0, 0],
		bold: [1, 22],
		dim: [2, 22],
		italic: [3, 23],
		underline: [4, 24],
		overline: [53, 55],
		inverse: [7, 27],
		hidden: [8, 28],
		strikethrough: [9, 29]
	},
	color: {
		black: [30, 39],
		red: [31, 39],
		green: [32, 39],
		yellow: [33, 39],
		blue: [34, 39],
		magenta: [35, 39],
		cyan: [36, 39],
		white: [37, 39],
		blackBright: [90, 39],
		gray: [90, 39],
		grey: [90, 39],
		redBright: [91, 39],
		greenBright: [92, 39],
		yellowBright: [93, 39],
		blueBright: [94, 39],
		magentaBright: [95, 39],
		cyanBright: [96, 39],
		whiteBright: [97, 39]
	},
	bgColor: {
		bgBlack: [40, 49],
		bgRed: [41, 49],
		bgGreen: [42, 49],
		bgYellow: [43, 49],
		bgBlue: [44, 49],
		bgMagenta: [45, 49],
		bgCyan: [46, 49],
		bgWhite: [47, 49],
		bgBlackBright: [100, 49],
		bgGray: [100, 49],
		bgGrey: [100, 49],
		bgRedBright: [101, 49],
		bgGreenBright: [102, 49],
		bgYellowBright: [103, 49],
		bgBlueBright: [104, 49],
		bgMagentaBright: [105, 49],
		bgCyanBright: [106, 49],
		bgWhiteBright: [107, 49]
	}
};
const modifierNames = Object.keys(styles$1.modifier);
const foregroundColorNames = Object.keys(styles$1.color);
const backgroundColorNames = Object.keys(styles$1.bgColor);
const colorNames = [...foregroundColorNames, ...backgroundColorNames];
function assembleStyles() {
	const codes = new Map();
	for (const [groupName, group] of Object.entries(styles$1)) {
		for (const [styleName, style] of Object.entries(group)) {
			styles$1[styleName] = {
				open: `\u001B[${style[0]}m`,
				close: `\u001B[${style[1]}m`
			};
			group[styleName] = styles$1[styleName];
			codes.set(style[0], style[1]);
		}
		Object.defineProperty(styles$1, groupName, {
			value: group,
			enumerable: false
		});
	}
	Object.defineProperty(styles$1, "codes", {
		value: codes,
		enumerable: false
	});
	styles$1.color.close = "\x1B[39m";
	styles$1.bgColor.close = "\x1B[49m";
	styles$1.color.ansi = wrapAnsi16();
	styles$1.color.ansi256 = wrapAnsi256();
	styles$1.color.ansi16m = wrapAnsi16m();
	styles$1.bgColor.ansi = wrapAnsi16(ANSI_BACKGROUND_OFFSET);
	styles$1.bgColor.ansi256 = wrapAnsi256(ANSI_BACKGROUND_OFFSET);
	styles$1.bgColor.ansi16m = wrapAnsi16m(ANSI_BACKGROUND_OFFSET);
	Object.defineProperties(styles$1, {
		rgbToAnsi256: {
			value(red, green, blue) {
				if (red === green && green === blue) {
					if (red < 8) return 16;
					if (red > 248) return 231;
					return Math.round((red - 8) / 247 * 24) + 232;
				}
				return 16 + 36 * Math.round(red / 255 * 5) + 6 * Math.round(green / 255 * 5) + Math.round(blue / 255 * 5);
			},
			enumerable: false
		},
		hexToRgb: {
			value(hex) {
				const matches = /[a-f\d]{6}|[a-f\d]{3}/i.exec(hex.toString(16));
				if (!matches) return [
					0,
					0,
					0
				];
				let [colorString] = matches;
				if (colorString.length === 3) colorString = [...colorString].map((character) => character + character).join("");
				const integer = Number.parseInt(colorString, 16);
				return [
					integer >> 16 & 255,
					integer >> 8 & 255,
					integer & 255
				];
			},
			enumerable: false
		},
		hexToAnsi256: {
			value: (hex) => styles$1.rgbToAnsi256(...styles$1.hexToRgb(hex)),
			enumerable: false
		},
		ansi256ToAnsi: {
			value(code) {
				if (code < 8) return 30 + code;
				if (code < 16) return 90 + (code - 8);
				let red;
				let green;
				let blue;
				if (code >= 232) {
					red = ((code - 232) * 10 + 8) / 255;
					green = red;
					blue = red;
				} else {
					code -= 16;
					const remainder = code % 36;
					red = Math.floor(code / 36) / 5;
					green = Math.floor(remainder / 6) / 5;
					blue = remainder % 6 / 5;
				}
				const value = Math.max(red, green, blue) * 2;
				if (value === 0) return 30;
				let result = 30 + (Math.round(blue) << 2 | Math.round(green) << 1 | Math.round(red));
				if (value === 2) result += 60;
				return result;
			},
			enumerable: false
		},
		rgbToAnsi: {
			value: (red, green, blue) => styles$1.ansi256ToAnsi(styles$1.rgbToAnsi256(red, green, blue)),
			enumerable: false
		},
		hexToAnsi: {
			value: (hex) => styles$1.ansi256ToAnsi(styles$1.hexToAnsi256(hex)),
			enumerable: false
		}
	});
	return styles$1;
}
const ansiStyles = assembleStyles();
var ansi_styles_default = ansiStyles;

//#endregion
//#region node_modules/chalk/source/vendor/supports-color/index.js
function hasFlag(flag, argv = globalThis.Deno ? globalThis.Deno.args : process$1.argv) {
	const prefix = flag.startsWith("-") ? "" : flag.length === 1 ? "-" : "--";
	const position = argv.indexOf(prefix + flag);
	const terminatorPosition = argv.indexOf("--");
	return position !== -1 && (terminatorPosition === -1 || position < terminatorPosition);
}
const { env } = process$1;
let flagForceColor;
if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) flagForceColor = 0;
else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) flagForceColor = 1;
function envForceColor() {
	if ("FORCE_COLOR" in env) {
		if (env.FORCE_COLOR === "true") return 1;
		if (env.FORCE_COLOR === "false") return 0;
		return env.FORCE_COLOR.length === 0 ? 1 : Math.min(Number.parseInt(env.FORCE_COLOR, 10), 3);
	}
}
function translateLevel(level) {
	if (level === 0) return false;
	return {
		level,
		hasBasic: true,
		has256: level >= 2,
		has16m: level >= 3
	};
}
function _supportsColor(haveStream, { streamIsTTY, sniffFlags = true } = {}) {
	const noFlagForceColor = envForceColor();
	if (noFlagForceColor !== void 0) flagForceColor = noFlagForceColor;
	const forceColor = sniffFlags ? flagForceColor : noFlagForceColor;
	if (forceColor === 0) return 0;
	if (sniffFlags) {
		if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) return 3;
		if (hasFlag("color=256")) return 2;
	}
	if ("TF_BUILD" in env && "AGENT_NAME" in env) return 1;
	if (haveStream && !streamIsTTY && forceColor === void 0) return 0;
	const min = forceColor || 0;
	if (env.TERM === "dumb") return min;
	if (process$1.platform === "win32") {
		const osRelease = os.release().split(".");
		if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) return Number(osRelease[2]) >= 14931 ? 3 : 2;
		return 1;
	}
	if ("CI" in env) {
		if ([
			"GITHUB_ACTIONS",
			"GITEA_ACTIONS",
			"CIRCLECI"
		].some((key) => key in env)) return 3;
		if ([
			"TRAVIS",
			"APPVEYOR",
			"GITLAB_CI",
			"BUILDKITE",
			"DRONE"
		].some((sign) => sign in env) || env.CI_NAME === "codeship") return 1;
		return min;
	}
	if ("TEAMCITY_VERSION" in env) return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
	if (env.COLORTERM === "truecolor") return 3;
	if (env.TERM === "xterm-kitty") return 3;
	if (env.TERM === "xterm-ghostty") return 3;
	if (env.TERM === "wezterm") return 3;
	if ("TERM_PROGRAM" in env) {
		const version = Number.parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
		switch (env.TERM_PROGRAM) {
			case "iTerm.app": return version >= 3 ? 3 : 2;
			case "Apple_Terminal": return 2;
		}
	}
	if (/-256(color)?$/i.test(env.TERM)) return 2;
	if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) return 1;
	if ("COLORTERM" in env) return 1;
	return min;
}
function createSupportsColor(stream, options = {}) {
	const level = _supportsColor(stream, {
		streamIsTTY: stream && stream.isTTY,
		...options
	});
	return translateLevel(level);
}
const supportsColor = {
	stdout: createSupportsColor({ isTTY: tty.isatty(1) }),
	stderr: createSupportsColor({ isTTY: tty.isatty(2) })
};
var supports_color_default = supportsColor;

//#endregion
//#region node_modules/chalk/source/utilities.js
function stringReplaceAll(string$1, substring, replacer) {
	let index = string$1.indexOf(substring);
	if (index === -1) return string$1;
	const substringLength = substring.length;
	let endIndex = 0;
	let returnValue = "";
	do {
		returnValue += string$1.slice(endIndex, index) + substring + replacer;
		endIndex = index + substringLength;
		index = string$1.indexOf(substring, endIndex);
	} while (index !== -1);
	returnValue += string$1.slice(endIndex);
	return returnValue;
}
function stringEncaseCRLFWithFirstIndex(string$1, prefix, postfix, index) {
	let endIndex = 0;
	let returnValue = "";
	do {
		const gotCR = string$1[index - 1] === "\r";
		returnValue += string$1.slice(endIndex, gotCR ? index - 1 : index) + prefix + (gotCR ? "\r\n" : "\n") + postfix;
		endIndex = index + 1;
		index = string$1.indexOf("\n", endIndex);
	} while (index !== -1);
	returnValue += string$1.slice(endIndex);
	return returnValue;
}

//#endregion
//#region node_modules/chalk/source/index.js
const { stdout: stdoutColor, stderr: stderrColor } = supports_color_default;
const GENERATOR = Symbol("GENERATOR");
const STYLER = Symbol("STYLER");
const IS_EMPTY = Symbol("IS_EMPTY");
const levelMapping = [
	"ansi",
	"ansi",
	"ansi256",
	"ansi16m"
];
const styles = Object.create(null);
const applyOptions = (object$1, options = {}) => {
	if (options.level && !(Number.isInteger(options.level) && options.level >= 0 && options.level <= 3)) throw new Error("The `level` option should be an integer from 0 to 3");
	const colorLevel = stdoutColor ? stdoutColor.level : 0;
	object$1.level = options.level === void 0 ? colorLevel : options.level;
};
const chalkFactory = (options) => {
	const chalk$1 = (...strings) => strings.join(" ");
	applyOptions(chalk$1, options);
	Object.setPrototypeOf(chalk$1, createChalk.prototype);
	return chalk$1;
};
function createChalk(options) {
	return chalkFactory(options);
}
Object.setPrototypeOf(createChalk.prototype, Function.prototype);
for (const [styleName, style] of Object.entries(ansi_styles_default)) styles[styleName] = { get() {
	const builder = createBuilder(this, createStyler(style.open, style.close, this[STYLER]), this[IS_EMPTY]);
	Object.defineProperty(this, styleName, { value: builder });
	return builder;
} };
styles.visible = { get() {
	const builder = createBuilder(this, this[STYLER], true);
	Object.defineProperty(this, "visible", { value: builder });
	return builder;
} };
const getModelAnsi = (model, level, type, ...arguments_) => {
	if (model === "rgb") {
		if (level === "ansi16m") return ansi_styles_default[type].ansi16m(...arguments_);
		if (level === "ansi256") return ansi_styles_default[type].ansi256(ansi_styles_default.rgbToAnsi256(...arguments_));
		return ansi_styles_default[type].ansi(ansi_styles_default.rgbToAnsi(...arguments_));
	}
	if (model === "hex") return getModelAnsi("rgb", level, type, ...ansi_styles_default.hexToRgb(...arguments_));
	return ansi_styles_default[type][model](...arguments_);
};
const usedModels = [
	"rgb",
	"hex",
	"ansi256"
];
for (const model of usedModels) {
	styles[model] = { get() {
		const { level } = this;
		return function(...arguments_) {
			const styler = createStyler(getModelAnsi(model, levelMapping[level], "color", ...arguments_), ansi_styles_default.color.close, this[STYLER]);
			return createBuilder(this, styler, this[IS_EMPTY]);
		};
	} };
	const bgModel = "bg" + model[0].toUpperCase() + model.slice(1);
	styles[bgModel] = { get() {
		const { level } = this;
		return function(...arguments_) {
			const styler = createStyler(getModelAnsi(model, levelMapping[level], "bgColor", ...arguments_), ansi_styles_default.bgColor.close, this[STYLER]);
			return createBuilder(this, styler, this[IS_EMPTY]);
		};
	} };
}
const proto = Object.defineProperties(() => {}, {
	...styles,
	level: {
		enumerable: true,
		get() {
			return this[GENERATOR].level;
		},
		set(level) {
			this[GENERATOR].level = level;
		}
	}
});
const createStyler = (open, close, parent) => {
	let openAll;
	let closeAll;
	if (parent === void 0) {
		openAll = open;
		closeAll = close;
	} else {
		openAll = parent.openAll + open;
		closeAll = close + parent.closeAll;
	}
	return {
		open,
		close,
		openAll,
		closeAll,
		parent
	};
};
const createBuilder = (self, _styler, _isEmpty) => {
	const builder = (...arguments_) => applyStyle(builder, arguments_.length === 1 ? "" + arguments_[0] : arguments_.join(" "));
	Object.setPrototypeOf(builder, proto);
	builder[GENERATOR] = self;
	builder[STYLER] = _styler;
	builder[IS_EMPTY] = _isEmpty;
	return builder;
};
const applyStyle = (self, string$1) => {
	if (self.level <= 0 || !string$1) return self[IS_EMPTY] ? "" : string$1;
	let styler = self[STYLER];
	if (styler === void 0) return string$1;
	const { openAll, closeAll } = styler;
	if (string$1.includes("\x1B")) while (styler !== void 0) {
		string$1 = stringReplaceAll(string$1, styler.close, styler.open);
		styler = styler.parent;
	}
	const lfIndex = string$1.indexOf("\n");
	if (lfIndex !== -1) string$1 = stringEncaseCRLFWithFirstIndex(string$1, closeAll, openAll, lfIndex);
	return openAll + string$1 + closeAll;
};
Object.defineProperties(createChalk.prototype, styles);
const chalk = createChalk();
const chalkStderr = createChalk({ level: stderrColor ? stderrColor.level : 0 });
var source_default = chalk;

//#endregion
//#region src/render/colors.ts
const NAMED_COLORS = {
	red: "#ff0000",
	green: "#00ff00",
	blue: "#0000ff",
	yellow: "#ffff00",
	cyan: "#00ffff",
	magenta: "#ff00ff",
	white: "#ffffff",
	black: "#000000",
	gray: "#808080",
	grey: "#808080",
	orange: "#ff8800",
	pink: "#ff69b4"
};
function resolveColor(color) {
	return NAMED_COLORS[color.toLowerCase()] ?? color;
}
function colorize(text, fg, bg) {
	let result = source_default;
	if (fg) {
		const resolved = resolveColor(fg);
		result = result.hex(resolved.startsWith("#") ? resolved : "#808080");
	}
	if (bg) {
		const resolved = resolveColor(bg);
		result = result.bgHex(resolved.startsWith("#") ? resolved : "#000000");
	}
	return result(text);
}

//#endregion
//#region src/render/themes.ts
const THEMES = {
	default: {
		name: "default",
		segments: [
			{
				fg: "#ffffff",
				bg: "#5f5faf"
			},
			{
				fg: "#ffffff",
				bg: "#444444"
			},
			{
				fg: "#ffffff",
				bg: "#262626"
			},
			{
				fg: "#aaaaaa",
				bg: "#1c1c1c"
			}
		]
	},
	ocean: {
		name: "ocean",
		segments: [
			{
				fg: "#ffffff",
				bg: "#005f87"
			},
			{
				fg: "#ffffff",
				bg: "#00445f"
			},
			{
				fg: "#afd7ff",
				bg: "#003040"
			},
			{
				fg: "#87afd7",
				bg: "#002030"
			}
		]
	},
	forest: {
		name: "forest",
		segments: [
			{
				fg: "#ffffff",
				bg: "#2d5016"
			},
			{
				fg: "#ffffff",
				bg: "#1e3a0e"
			},
			{
				fg: "#a8d870",
				bg: "#152a08"
			},
			{
				fg: "#6aaf30",
				bg: "#0c1c04"
			}
		]
	},
	sunset: {
		name: "sunset",
		segments: [
			{
				fg: "#ffffff",
				bg: "#af5f00"
			},
			{
				fg: "#ffffff",
				bg: "#874700"
			},
			{
				fg: "#ffd787",
				bg: "#5f3400"
			},
			{
				fg: "#d7af5f",
				bg: "#3e2200"
			}
		]
	},
	minimal: {
		name: "minimal",
		segments: [
			{
				fg: "#d0d0d0",
				bg: "#333333"
			},
			{
				fg: "#aaaaaa",
				bg: "#262626"
			},
			{
				fg: "#888888",
				bg: "#1c1c1c"
			},
			{
				fg: "#666666",
				bg: "#141414"
			}
		]
	}
};
function getTheme(name) {
	return THEMES[name] ?? THEMES["default"];
}

//#endregion
//#region src/render/powerline.ts
source_default.level = 3;
function renderPowerlineSegments(outputs, options) {
	const theme = getTheme(options.theme);
	const segments = [];
	let prevBg = null;
	for (let i = 0; i < outputs.length; i++) {
		const output = outputs[i];
		const style = theme.segments[i % theme.segments.length];
		const fg = output.fg ?? style.fg;
		const bg = output.bg ?? style.bg;
		if (prevBg !== null) segments.push(source_default.hex(prevBg).bgHex(bg)(options.separator));
		segments.push(source_default.hex(fg).bgHex(bg)(` ${output.text} `));
		prevBg = bg;
	}
	if (prevBg !== null) segments.push(source_default.hex(prevBg)(options.separator));
	return segments.join("");
}

//#endregion
//#region src/render/flex.ts
function applyFlex(segments, totalWidth, mode) {
	const content = segments.join("");
	const contentWidth = visibleLength(content);
	if (contentWidth >= totalWidth) return content;
	const padding = totalWidth - contentWidth;
	switch (mode) {
		case "right": return " ".repeat(padding) + content;
		case "center": {
			const left = Math.floor(padding / 2);
			const right = padding - left;
			return " ".repeat(left) + content + " ".repeat(right);
		}
		case "space-between": {
			if (segments.length <= 1) return content + " ".repeat(padding);
			const gaps = segments.length - 1;
			const gapSize = Math.floor(padding / gaps);
			const extra = padding % gaps;
			return segments.map((seg, i) => {
				if (i === segments.length - 1) return seg;
				const gap = gapSize + (i < extra ? 1 : 0);
				return seg + " ".repeat(gap);
			}).join("");
		}
		case "left":
		default: return content + " ".repeat(padding);
	}
}

//#endregion
//#region src/render/truncation.ts
function truncateAnsi(str, maxWidth) {
	if (visibleLength(str) <= maxWidth) return str;
	const plain = stripAnsi(str);
	if (plain.length <= maxWidth) return str;
	let visible = 0;
	let i = 0;
	const result = [];
	while (i < str.length && visible < maxWidth - 1) {
		if (str[i] === "\x1B" && str[i + 1] === "[") {
			const end = str.indexOf("m", i);
			if (end !== -1) {
				result.push(str.slice(i, end + 1));
				i = end + 1;
				continue;
			}
		}
		result.push(str[i]);
		visible++;
		i++;
	}
	result.push("…");
	result.push("\x1B[0m");
	return result.join("");
}

//#endregion
//#region src/render/renderer.ts
function shouldCompact(settings, terminalWidth) {
	const compact = settings.compact;
	if (!compact) return false;
	const mode = compact.mode ?? "auto";
	if (mode === "always") return true;
	if (mode === "never") return false;
	return terminalWidth < (compact.threshold ?? 80);
}
function collectWidgets(configs, context) {
	const results = [];
	for (const config of configs) {
		const widget = getWidget(config.type);
		if (!widget) continue;
		const output = widget.render(context, config);
		if (!output) continue;
		if (isSeparatorOutput(output)) continue;
		results.push({
			output,
			priority: config.priority ?? 99
		});
	}
	return results;
}
function renderLine(outputs, settings, context, flex) {
	const powerline = settings.powerline;
	const isPowerline = powerline?.enabled ?? false;
	let line;
	if (isPowerline && powerline) {
		const nonSeparator = outputs.filter((o) => o.text !== " | " && o.text.trim() !== "|");
		line = renderPowerlineSegments(nonSeparator, {
			theme: powerline.theme ?? "default",
			separator: powerline.separator ?? "",
			separatorThin: powerline.separatorThin ?? ""
		});
	} else {
		const segments = outputs.map((o) => colorize(o.text, o.fg, o.bg));
		line = applyFlex(segments, context.terminalWidth, flex);
	}
	return truncateAnsi(line, context.terminalWidth);
}
function renderStatusline(context, settings) {
	if (shouldCompact(settings, context.terminalWidth)) return renderCompact(context, settings);
	return renderFull(context, settings);
}
function renderCompact(context, settings) {
	const allWidgets = [];
	for (const lineConfig of settings.lines) allWidgets.push(...collectWidgets(lineConfig.widgets, context));
	allWidgets.sort((a, b) => a.priority - b.priority);
	const fitted = [];
	let usedWidth = 0;
	const sepWidth = 3;
	for (const { output } of allWidgets) {
		const segWidth = visibleLength(output.text) + 2 + sepWidth;
		if (usedWidth + segWidth > context.terminalWidth && fitted.length > 0) break;
		fitted.push(output);
		usedWidth += segWidth;
	}
	if (fitted.length === 0) return "";
	return renderLine(fitted, settings, context, "left");
}
function renderFull(context, settings) {
	const lines = [];
	for (const lineConfig of settings.lines) {
		const outputs = [];
		for (const widgetConfig of lineConfig.widgets) {
			const widget = getWidget(widgetConfig.type);
			if (!widget) continue;
			const output = widget.render(context, widgetConfig);
			if (!output) continue;
			outputs.push(output);
		}
		const cleaned = cleanSeparators(outputs);
		if (cleaned.length === 0) continue;
		const line = renderLine(cleaned, settings, context, lineConfig.flex ?? "left");
		lines.push(line);
	}
	return lines.join("\n");
}
function cleanSeparators(outputs) {
	const result = [];
	let lastWasSeparator = true;
	for (const output of outputs) {
		const isSep = isSeparatorOutput(output);
		if (isSep && lastWasSeparator) continue;
		result.push(output);
		lastWasSeparator = isSep;
	}
	while (result.length > 0 && isSeparatorOutput(result[result.length - 1])) result.pop();
	return result;
}
function isSeparatorOutput(output) {
	const text = output.text.trim();
	return text === "|" || text === "│" || text === "" || output.text === " | ";
}

//#endregion
//#region src/cache/cache-manager.ts
function getCachePath() {
	return path.join(getCacheDir(), "statusline-cache.json");
}
function checkCache(ttlMs) {
	const cachePath = getCachePath();
	try {
		if (!fs.existsSync(cachePath)) return null;
		const raw = fs.readFileSync(cachePath, "utf-8");
		const entry = JSON.parse(raw);
		if (Date.now() - entry.timestamp > ttlMs) return null;
		if (entry.pid && entry.pid !== process.pid) try {
			process.kill(entry.pid, 0);
		} catch {
			return null;
		}
		return entry.output;
	} catch {
		return null;
	}
}
function writeCache(output) {
	const cachePath = getCachePath();
	try {
		ensureDir(path.dirname(cachePath));
		const entry = {
			output,
			timestamp: Date.now(),
			pid: process.pid
		};
		fs.writeFileSync(cachePath, JSON.stringify(entry));
	} catch {}
}

//#endregion
//#region src/cli.ts
async function runCli(args) {
	const command = args[0] ?? "today";
	switch (command) {
		case "today":
			await reportToday();
			break;
		case "setup":
			runSetup();
			break;
		case "help":
			printHelp();
			break;
		default:
			console.error(`Unknown command: ${command}`);
			printHelp();
			process.exit(1);
	}
}
async function reportToday() {
	const files = findTodayJsonlFiles();
	const entries = files.flatMap(parseJsonlFile);
	const metrics = aggregateTokens(entries, entries);
	const pricing = await fetchPricing(864e5);
	const costByModel = calculateCostByModel(metrics.byModel, pricing);
	const totalCost = calculateTotalCost(costByModel);
	console.log("=== Today's Usage ===\n");
	console.log(`Total Cost: ${formatDollars(totalCost)}`);
	console.log(`Total Tokens: ${formatTokens(metrics.today.inputTokens + metrics.today.outputTokens)}`);
	console.log();
	if (costByModel.size > 0) {
		console.log("By Model:");
		for (const [model, cost] of costByModel) {
			const tokens = metrics.byModel.get(model);
			const total = tokens ? tokens.inputTokens + tokens.outputTokens : 0;
			console.log(`  ${formatModelName(model)}: ${formatDollars(cost)} (${formatTokens(total)} tokens)`);
		}
	}
	console.log(`\nSessions analyzed: ${files.length} files`);
}
function runSetup() {
	const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.js");
	const claudeDir = resolve(homedir(), ".claude");
	const settingsPath = resolve(claudeDir, "settings.json");
	if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
	let settings = {};
	if (existsSync(settingsPath)) try {
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		console.error(`Warning: Could not parse ${settingsPath}, creating backup and starting fresh`);
		writeFileSync(`${settingsPath}.bak`, readFileSync(settingsPath));
		settings = {};
	}
	const command = `node ${scriptPath}`;
	settings.statusLine = {
		type: "command",
		command
	};
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	console.log("gccusage setup complete!\n");
	console.log(`  Settings: ${settingsPath}`);
	console.log(`  Command:  ${command}\n`);
	console.log("Restart Claude Code to activate the statusline.");
}
function printHelp() {
	console.log(`gccusage - Powerline statusline for Claude Code

Usage:
  gccusage              Statusline mode (reads stdin JSON)
  gccusage setup        Configure Claude Code to use gccusage
  gccusage today        Show today's usage report
  gccusage help         Show this help

Quick Start:
  git clone https://github.com/gapietro/gccusage.git
  cd gccusage && npm link
  gccusage setup

Config: ~/.config/gccusage/settings.json`);
}

//#endregion
//#region src/index.ts
async function main() {
	const args = process.argv.slice(2);
	if (args.length > 0) {
		await runCli(args);
		return;
	}
	const settings = loadSettings();
	const cached = checkCache(settings.cache?.statuslineTtlMs ?? 5e3);
	if (cached !== null) {
		process.stdout.write(cached);
		return;
	}
	const isTTY = process.stdin.isTTY;
	let raw = "";
	if (!isTTY) raw = await readStdin();
	const stdin = parseStatusJson(raw) ?? {};
	const context = await buildRenderContext(stdin, settings);
	const output = renderStatusline(context, settings);
	writeCache(output);
	process.stdout.write(output);
}
main().catch(() => {
	process.exit(0);
});

//#endregion