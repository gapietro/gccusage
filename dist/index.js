import * as v$3 from "valibot";
import * as v$2 from "valibot";
import * as v$1 from "valibot";
import * as v from "valibot";
import * as fs$6 from "node:fs";
import * as fs$5 from "node:fs";
import * as fs$4 from "node:fs";
import * as fs$3 from "node:fs";
import * as fs$2 from "node:fs";
import * as fs$1 from "node:fs";
import * as fs from "node:fs";
import * as path$5 from "node:path";
import * as path$4 from "node:path";
import * as path$3 from "node:path";
import * as path$2 from "node:path";
import * as path$1 from "node:path";
import * as path from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";

//#region src/types/status-json.ts
const ModelSchema = v$3.union([v$3.string(), v$3.object({
	id: v$3.optional(v$3.string()),
	display_name: v$3.optional(v$3.string())
})]);
const CostSchema = v$3.object({
	total_cost_usd: v$3.optional(v$3.number()),
	total_duration_ms: v$3.optional(v$3.number()),
	total_api_duration_ms: v$3.optional(v$3.number()),
	total_lines_added: v$3.optional(v$3.number()),
	total_lines_removed: v$3.optional(v$3.number())
});
const CurrentUsageSchema = v$3.object({
	input_tokens: v$3.optional(v$3.number(), 0),
	output_tokens: v$3.optional(v$3.number(), 0),
	cache_creation_input_tokens: v$3.optional(v$3.number(), 0),
	cache_read_input_tokens: v$3.optional(v$3.number(), 0)
});
const ContextWindowSchema = v$3.union([v$3.number(), v$3.object({
	context_window_size: v$3.optional(v$3.number()),
	used_percentage: v$3.optional(v$3.nullable(v$3.number())),
	remaining_percentage: v$3.optional(v$3.nullable(v$3.number())),
	total_input_tokens: v$3.optional(v$3.number()),
	total_output_tokens: v$3.optional(v$3.number()),
	current_usage: v$3.optional(v$3.nullable(CurrentUsageSchema))
})]);
const TokenUsageSchema = v$3.object({
	input_tokens: v$3.optional(v$3.number(), 0),
	output_tokens: v$3.optional(v$3.number(), 0),
	cache_creation_input_tokens: v$3.optional(v$3.number(), 0),
	cache_read_input_tokens: v$3.optional(v$3.number(), 0)
});
const VimSchema = v$3.object({ mode: v$3.optional(v$3.string()) });
const StatusJsonSchema = v$3.object({
	model: v$3.optional(ModelSchema),
	cost: v$3.optional(CostSchema),
	context_window: v$3.optional(ContextWindowSchema),
	token_usage: v$3.optional(TokenUsageSchema),
	vim: v$3.optional(VimSchema),
	cwd: v$3.optional(v$3.string()),
	session_id: v$3.optional(v$3.string())
});

//#endregion
//#region src/data/stdin-reader.ts
function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const timeout = setTimeout(() => {
			process.stdin.destroy();
			resolve("");
		}, 1e3);
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => {
			clearTimeout(timeout);
			resolve(Buffer.concat(chunks).toString("utf-8"));
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
		return v$2.parse(StatusJsonSchema, data);
	} catch {
		return null;
	}
}

//#endregion
//#region src/config/schema.ts
const ColorSchema = v$1.union([v$1.string()]);
const WidgetConfigSchema = v$1.object({
	type: v$1.string(),
	label: v$1.optional(v$1.string()),
	fg: v$1.optional(ColorSchema),
	bg: v$1.optional(ColorSchema),
	icon: v$1.optional(v$1.string()),
	format: v$1.optional(v$1.string()),
	command: v$1.optional(v$1.string()),
	text: v$1.optional(v$1.string()),
	separator: v$1.optional(v$1.string()),
	maxWidth: v$1.optional(v$1.number()),
	priority: v$1.optional(v$1.number())
});
const LineConfigSchema = v$1.object({
	widgets: v$1.array(WidgetConfigSchema),
	flex: v$1.optional(v$1.picklist([
		"left",
		"right",
		"center",
		"space-between"
	]), "left")
});
const PowerlineConfigSchema = v$1.object({
	enabled: v$1.optional(v$1.boolean(), false),
	theme: v$1.optional(v$1.string(), "default"),
	separator: v$1.optional(v$1.string(), ""),
	separatorThin: v$1.optional(v$1.string(), "")
});
const CacheConfigSchema = v$1.object({
	statuslineTtlMs: v$1.optional(v$1.number(), 5e3),
	pricingTtlMs: v$1.optional(v$1.number(), 864e5)
});
const CompactConfigSchema = v$1.object({
	mode: v$1.optional(v$1.picklist([
		"auto",
		"always",
		"never"
	]), "auto"),
	threshold: v$1.optional(v$1.number(), 80)
});
const AlertsConfigSchema = v$1.object({
	sessionWarn: v$1.optional(v$1.number(), 5),
	sessionDanger: v$1.optional(v$1.number(), 15),
	dailyWarn: v$1.optional(v$1.number(), 10),
	dailyDanger: v$1.optional(v$1.number(), 25)
});
const SettingsSchema = v$1.object({
	lines: v$1.optional(v$1.array(LineConfigSchema)),
	powerline: v$1.optional(PowerlineConfigSchema),
	compact: v$1.optional(CompactConfigSchema),
	alerts: v$1.optional(AlertsConfigSchema),
	cache: v$1.optional(CacheConfigSchema),
	costSource: v$1.optional(v$1.picklist([
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
	if (xdg) return path$5.join(xdg, "gccusage");
	return path$5.join(process.env["HOME"] || "~", ".config", "gccusage");
}
function getConfigPath() {
	return path$5.join(getConfigDir(), "settings.json");
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
	if (!fs$6.existsSync(configPath)) return DEFAULT_SETTINGS;
	try {
		const raw = fs$6.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		const validated = v.parse(SettingsSchema, parsed);
		return mergeSettings(DEFAULT_SETTINGS, parsed, validated);
	} catch {
		return DEFAULT_SETTINGS;
	}
}

//#endregion
//#region src/utils/paths.ts
function getClaudeDataDir() {
	const home = process.env["HOME"] || "~";
	return path$4.join(home, ".claude");
}
function getProjectsDir() {
	return path$4.join(getClaudeDataDir(), "projects");
}
function getCacheDir() {
	const xdg = process.env["XDG_CACHE_HOME"];
	if (xdg) return path$4.join(xdg, "gccusage");
	return path$4.join(process.env["HOME"] || "~", ".cache", "gccusage");
}
function ensureDir(dir) {
	if (!fs$5.existsSync(dir)) fs$5.mkdirSync(dir, { recursive: true });
}
function findJsonlFiles(dir) {
	if (!fs$5.existsSync(dir)) return [];
	try {
		return fs$5.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path$4.join(dir, f));
	} catch {
		return [];
	}
}
function findSessionJsonlFiles(sessionId) {
	const projectsDir = getProjectsDir();
	if (!fs$5.existsSync(projectsDir)) return [];
	const files = [];
	try {
		for (const projectDir of fs$5.readdirSync(projectsDir)) {
			const fullPath = path$4.join(projectsDir, projectDir);
			const stat = fs$5.statSync(fullPath);
			if (!stat.isDirectory()) continue;
			const jsonlFiles = findJsonlFiles(fullPath);
			if (sessionId) files.push(...jsonlFiles.filter((f) => path$4.basename(f, ".jsonl") === sessionId));
			else files.push(...jsonlFiles);
		}
	} catch {}
	return files;
}
function findTodayJsonlFiles() {
	const projectsDir = getProjectsDir();
	if (!fs$5.existsSync(projectsDir)) return [];
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const todayMs = todayStart.getTime();
	const files = [];
	try {
		for (const projectDir of fs$5.readdirSync(projectsDir)) {
			const fullPath = path$4.join(projectsDir, projectDir);
			const stat = fs$5.statSync(fullPath);
			if (!stat.isDirectory()) continue;
			for (const f of findJsonlFiles(fullPath)) {
				const fstat = fs$5.statSync(f);
				if (fstat.mtimeMs >= todayMs) files.push(f);
			}
		}
	} catch {}
	return files;
}

//#endregion
//#region src/data/jsonl-reader.ts
function parseJsonlFile(filePath) {
	if (!fs$4.existsSync(filePath)) return [];
	try {
		const content = fs$4.readFileSync(filePath, "utf-8");
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
	return path$3.join(getCacheDir(), "blocks", "current.json");
}
function loadBlockCache() {
	const cachePath = getBlockCachePath();
	try {
		if (!fs$3.existsSync(cachePath)) return null;
		const raw = fs$3.readFileSync(cachePath, "utf-8");
		const data = JSON.parse(raw);
		if (Date.now() - data.blockStartTime > BLOCK_DURATION_MS) {
			fs$3.unlinkSync(cachePath);
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
		ensureDir(path$3.dirname(cachePath));
		fs$3.writeFileSync(cachePath, JSON.stringify(data));
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
	return path$2.join(getCacheDir(), "pricing.json");
}
function loadPricingCache(ttlMs) {
	const cachePath = getCachePath$1();
	try {
		if (!fs$2.existsSync(cachePath)) return null;
		const raw = fs$2.readFileSync(cachePath, "utf-8");
		const cache = JSON.parse(raw);
		if (Date.now() - cache.timestamp < ttlMs) return cache.data;
	} catch {}
	return null;
}
function savePricingCache(data) {
	const cachePath = getCachePath$1();
	try {
		ensureDir(path$2.dirname(cachePath));
		const cache = {
			timestamp: Date.now(),
			data
		};
		fs$2.writeFileSync(cachePath, JSON.stringify(cache));
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
	return path$1.join(getCacheDir(), "daily-costs.json");
}
function todayDateStr() {
	return new Date().toISOString().slice(0, 10);
}
function readDailyCostFile() {
	const filePath = getDailyCostPath();
	try {
		const raw = fs$1.readFileSync(filePath, "utf-8");
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
	ensureDir(path$1.dirname(filePath));
	fs$1.writeFileSync(filePath, JSON.stringify(data), "utf-8");
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
const customCommandWidget = { render(context, config) {
	const command = config.command;
	if (!command) return null;
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 2e3,
			cwd: context.stdin.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		}).trim();
		if (!output) return null;
		const text = output.split("\n")[0] ?? "";
		return {
			text,
			fg: config.fg,
			bg: config.bg
		};
	} catch {
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
	"compact-countdown": compactCountdownWidget
};
function getWidget(type) {
	return WIDGET_MAP[type] ?? null;
}

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
	let result = chalk;
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
chalk.level = 3;
function renderPowerlineSegments(outputs, options) {
	const theme = getTheme(options.theme);
	const segments = [];
	let prevBg = null;
	for (let i = 0; i < outputs.length; i++) {
		const output = outputs[i];
		const style = theme.segments[i % theme.segments.length];
		const fg = output.fg ?? style.fg;
		const bg = output.bg ?? style.bg;
		if (prevBg !== null) segments.push(chalk.hex(prevBg).bgHex(bg)(options.separator));
		segments.push(chalk.hex(fg).bgHex(bg)(` ${output.text} `));
		prevBg = bg;
	}
	if (prevBg !== null) segments.push(chalk.hex(prevBg)(options.separator));
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
function printHelp() {
	console.log(`gccusage - Claude Code usage analytics

Usage:
  gccusage              Statusline mode (reads stdin JSON)
  gccusage today        Show today's usage report
  gccusage help         Show this help

Statusline Installation:
  Add to ~/.claude/settings.json:
  {
    "hooks": {
      "StatusLine": [{ "type": "command", "command": "npx gccusage@latest" }]
    }
  }

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