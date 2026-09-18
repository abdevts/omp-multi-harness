/** multiHarness configuration — shape, defaults, and normalization. See _spec/09-config.md. */

export type AgentName = "codex" | "claude";
export type RoutingMode = "model" | "rules";
export type AgentMode = "analyze" | "plan" | "implement" | "debug" | "review" | "test";

export interface AgentConfig {
	enabled: boolean;
	executable: string;
	timeoutMs: number;
	/** null → the CLI's own config decides the model (the default promise of this project). */
	model: string | null;
	additionalDirs: string[];
	/** Claude only: use --permission-mode acceptEdits for write runs. */
	acceptEdits: boolean;
}

export interface RoutingConfig {
	default: "auto" | AgentName;
	mode: RoutingMode;
	model: string;
	modelFallbacks: string[];
	modelTimeoutMs: number;
	modeMap: Record<AgentMode, AgentName>;
	promptGuidance: boolean;
}

export interface ConcurrencyConfig {
	maxConcurrentRuns: number;
	allowParallelReads: boolean;
	allowParallelWrites: boolean;
	writerQueue: boolean;
}

export interface LimitsConfig {
	maxOutputChars: number;
	maxHandoffChars: number;
	ringBufferBytes: number;
	killGraceMs: number;
}

export interface MultiHarnessConfig {
	enabled: boolean;
	codex: AgentConfig;
	claude: AgentConfig;
	routing: RoutingConfig;
	sessions: { persist: boolean };
	concurrency: ConcurrencyConfig;
	limits: LimitsConfig;
	debug: boolean;
}

export const DEFAULTS: MultiHarnessConfig = {
	enabled: true,
	codex: { enabled: true, executable: "codex", timeoutMs: 1_800_000, model: null, additionalDirs: [], acceptEdits: false },
	claude: { enabled: true, executable: "claude", timeoutMs: 1_800_000, model: null, additionalDirs: [], acceptEdits: false },
	routing: {
		default: "auto",
		mode: "model",
		model: "@smol",
		modelFallbacks: ["anthropic/claude-haiku-4-5", "openai/gpt-5.2-mini", "google/gemini-2.5-flash"],
		modelTimeoutMs: 5_000,
		modeMap: { plan: "claude", analyze: "claude", review: "claude", implement: "codex", debug: "codex", test: "codex" },
		promptGuidance: true,
	},
	sessions: { persist: true },
	concurrency: { maxConcurrentRuns: 4, allowParallelReads: true, allowParallelWrites: false, writerQueue: true },
	limits: { maxOutputChars: 32_000, maxHandoffChars: 4_000, ringBufferBytes: 1_048_576, killGraceMs: 5_000 },
	debug: false,
};

export interface NormalizeResult {
	config: MultiHarnessConfig;
	/** Human-readable problems. Never fatal — bad values fall back to defaults. */
	warnings: string[];
}

const MODEL_TOKEN = /^[A-Za-z0-9._:@/-]{1,120}$/;

/** A per-call or configured model override must look like a model token before it reaches argv. */
export function isValidModelToken(value: string): boolean {
	return MODEL_TOKEN.test(value);
}

function pickBoolean(raw: unknown, fallback: boolean, path: string, warnings: string[]): boolean {
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === "boolean") return raw;
	warnings.push(`${path}: expected boolean, got ${typeof raw} — using ${fallback}`);
	return fallback;
}

function pickNumber(raw: unknown, fallback: number, path: string, warnings: string[], min = 1): number {
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === "number" && Number.isFinite(raw) && raw >= min) return raw;
	warnings.push(`${path}: expected number >= ${min}, got ${JSON.stringify(raw)} — using ${fallback}`);
	return fallback;
}

function pickString(raw: unknown, fallback: string, path: string, warnings: string[]): string {
	if (raw === undefined || raw === null) return fallback;
	if (typeof raw === "string" && raw.length > 0) return raw;
	warnings.push(`${path}: expected non-empty string — using ${fallback}`);
	return fallback;
}

function pickModel(raw: unknown, path: string, warnings: string[]): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw === "string" && isValidModelToken(raw)) return raw;
	warnings.push(`${path}: not a valid model token — ignoring, the CLI's own config will decide`);
	return null;
}

function pickStringArray(raw: unknown, fallback: string[], path: string, warnings: string[]): string[] {
	if (raw === undefined || raw === null) return fallback;
	if (Array.isArray(raw) && raw.every((v) => typeof v === "string")) return raw as string[];
	warnings.push(`${path}: expected string[] — using default`);
	return fallback;
}

function obj(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const KNOWN_TOP = new Set(["enabled", "codex", "claude", "routing", "sessions", "concurrency", "limits", "debug"]);

function agentConfig(raw: unknown, d: AgentConfig, path: string, warnings: string[]): AgentConfig {
	const r = obj(raw);
	return {
		enabled: pickBoolean(r.enabled, d.enabled, `${path}.enabled`, warnings),
		executable: pickString(r.executable, d.executable, `${path}.executable`, warnings),
		timeoutMs: pickNumber(r.timeoutMs, d.timeoutMs, `${path}.timeoutMs`, warnings, 1_000),
		model: pickModel(r.model, `${path}.model`, warnings),
		additionalDirs: pickStringArray(r.additionalDirs, d.additionalDirs, `${path}.additionalDirs`, warnings),
		acceptEdits: pickBoolean(r.acceptEdits, d.acceptEdits, `${path}.acceptEdits`, warnings),
	};
}

/** Merge a raw `multiHarness` block over the defaults. Unknown keys warn; bad values fall back. */
export function normalizeConfig(raw: unknown): NormalizeResult {
	const warnings: string[] = [];
	const r = obj(raw);

	for (const key of Object.keys(r)) {
		if (!KNOWN_TOP.has(key)) warnings.push(`multiHarness.${key}: unknown option — ignored`);
	}

	const routingRaw = obj(r.routing);
	const modeMapRaw = obj(routingRaw.modeMap);
	const modeMap = { ...DEFAULTS.routing.modeMap };
	for (const [mode, agent] of Object.entries(modeMapRaw)) {
		if (!(mode in modeMap)) {
			warnings.push(`multiHarness.routing.modeMap.${mode}: unknown mode — ignored`);
		} else if (agent === "codex" || agent === "claude") {
			modeMap[mode as AgentMode] = agent;
		} else {
			warnings.push(`multiHarness.routing.modeMap.${mode}: expected "codex" or "claude" — keeping default`);
		}
	}

	const routingDefaultRaw = routingRaw.default;
	const routingDefault =
		routingDefaultRaw === "auto" || routingDefaultRaw === "codex" || routingDefaultRaw === "claude"
			? routingDefaultRaw
			: (routingDefaultRaw === undefined || routingDefaultRaw === null
				? DEFAULTS.routing.default
				: (warnings.push('multiHarness.routing.default: expected "auto" | "codex" | "claude" — using "auto"'),
					DEFAULTS.routing.default));

	const routingModeRaw = routingRaw.mode;
	const routingMode: RoutingMode =
		routingModeRaw === "model" || routingModeRaw === "rules"
			? routingModeRaw
			: (routingModeRaw === undefined || routingModeRaw === null
				? DEFAULTS.routing.mode
				: (warnings.push('multiHarness.routing.mode: expected "model" | "rules" — using "model"'), DEFAULTS.routing.mode));

	const concurrencyRaw = obj(r.concurrency);
	const limitsRaw = obj(r.limits);

	return {
		warnings,
		config: {
			enabled: pickBoolean(r.enabled, DEFAULTS.enabled, "multiHarness.enabled", warnings),
			codex: agentConfig(r.codex, DEFAULTS.codex, "multiHarness.codex", warnings),
			claude: agentConfig(r.claude, DEFAULTS.claude, "multiHarness.claude", warnings),
			routing: {
				default: routingDefault,
				mode: routingMode,
				model: pickString(routingRaw.model, DEFAULTS.routing.model, "multiHarness.routing.model", warnings),
				modelFallbacks: pickStringArray(
					routingRaw.modelFallbacks,
					DEFAULTS.routing.modelFallbacks,
					"multiHarness.routing.modelFallbacks",
					warnings,
				),
				modelTimeoutMs: pickNumber(
					routingRaw.modelTimeoutMs,
					DEFAULTS.routing.modelTimeoutMs,
					"multiHarness.routing.modelTimeoutMs",
					warnings,
					100,
				),
				modeMap,
				promptGuidance: pickBoolean(
					routingRaw.promptGuidance,
					DEFAULTS.routing.promptGuidance,
					"multiHarness.routing.promptGuidance",
					warnings,
				),
			},
			sessions: {
				persist: pickBoolean(obj(r.sessions).persist, DEFAULTS.sessions.persist, "multiHarness.sessions.persist", warnings),
			},
			concurrency: {
				maxConcurrentRuns: pickNumber(
					concurrencyRaw.maxConcurrentRuns,
					DEFAULTS.concurrency.maxConcurrentRuns,
					"multiHarness.concurrency.maxConcurrentRuns",
					warnings,
				),
				allowParallelReads: pickBoolean(
					concurrencyRaw.allowParallelReads,
					DEFAULTS.concurrency.allowParallelReads,
					"multiHarness.concurrency.allowParallelReads",
					warnings,
				),
				allowParallelWrites: pickBoolean(
					concurrencyRaw.allowParallelWrites,
					DEFAULTS.concurrency.allowParallelWrites,
					"multiHarness.concurrency.allowParallelWrites",
					warnings,
				),
				writerQueue: pickBoolean(
					concurrencyRaw.writerQueue,
					DEFAULTS.concurrency.writerQueue,
					"multiHarness.concurrency.writerQueue",
					warnings,
				),
			},
			limits: {
				maxOutputChars: pickNumber(limitsRaw.maxOutputChars, DEFAULTS.limits.maxOutputChars, "multiHarness.limits.maxOutputChars", warnings, 500),
				maxHandoffChars: pickNumber(limitsRaw.maxHandoffChars, DEFAULTS.limits.maxHandoffChars, "multiHarness.limits.maxHandoffChars", warnings, 200),
				ringBufferBytes: pickNumber(limitsRaw.ringBufferBytes, DEFAULTS.limits.ringBufferBytes, "multiHarness.limits.ringBufferBytes", warnings, 4_096),
				killGraceMs: pickNumber(limitsRaw.killGraceMs, DEFAULTS.limits.killGraceMs, "multiHarness.limits.killGraceMs", warnings, 100),
			},
			debug: pickBoolean(r.debug, DEFAULTS.debug, "multiHarness.debug", warnings),
		},
	};
}
