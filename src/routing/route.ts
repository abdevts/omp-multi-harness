/**
 * Which agent gets a task (T-501, T-504, T-506) and which worker model it runs (T-507).
 *
 * This module is deliberately pure and injectable: config + availability (+ an optional
 * model-calling function) in, a decision out. The router model is a *dependency*, never an
 * import, so the rules path — and every test — stays offline. See _spec/09-config.md
 * §"Router model" and D-013.
 */
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { AgentAvailability } from "../agents/types.ts";
import { isValidModelToken, type AgentMode, type AgentName, type MultiHarnessConfig } from "../config/schema.ts";

/** How the agent was picked. Always reported so routing is never a black box. */
export type RoutedBy = "explicit" | "mode" | "rules" | "model" | "fallback";

export interface RouteDecision {
	ok: true;
	agent: AgentName;
	routedBy: RoutedBy;
	/** One line, safe to show the user and to store in tool-result details. */
	reason: string;
}

/** Typed refusal — no agent can run. Returned, never thrown (_spec/10). */
export interface RouteRefusal {
	ok: false;
	reason: string;
}

export type RouteResult = RouteDecision | RouteRefusal;

/** Whether one agent can actually be handed work right now, and why not. */
export interface AgentUsability {
	usable: boolean;
	reason?: string;
}

export type UsabilityMap = Record<AgentName, AgentUsability>;

/** Every agent usable — the default when nothing has been detected yet. */
export const ALL_USABLE: UsabilityMap = { codex: { usable: true }, claude: { usable: true } };

export interface RouteInput {
	/** `undefined` or `"auto"` means "you decide". */
	agent?: "auto" | AgentName;
	task: string;
	mode?: AgentMode;
}

/**
 * One classification call. Returns the model's raw answer; anything it cannot do — an
 * unresolvable model, an unauthenticated host, a network error — must reject, so the
 * caller can fall back to rules.
 */
export type RouterModelFn = (input: { prompt: string; timeoutMs: number; signal?: AbortSignal }) => Promise<string>;

export interface RouteDeps {
	config: MultiHarnessConfig;
	/** Defaults to "both usable" so callers that have not probed still get a decision. */
	usability?: UsabilityMap;
	/** Omit to skip the model path entirely (equivalent to `routing.mode: "rules"`). */
	askModel?: RouterModelFn;
	signal?: AbortSignal;
}

/** Combine config switches with detection results into a usability map. */
export function usabilityFrom(
	config: MultiHarnessConfig,
	detected?: Partial<Record<AgentName, AgentAvailability>>,
): UsabilityMap {
	const one = (agent: AgentName): AgentUsability => {
		if (!config.enabled) return { usable: false, reason: "multi-harness is disabled (multiHarness.enabled: false)" };
		if (!config[agent].enabled) return { usable: false, reason: `disabled in config (multiHarness.${agent}.enabled)` };
		const d = detected?.[agent];
		if (d && !d.available) return { usable: false, reason: d.reason ?? `${agent} is unavailable` };
		return { usable: true };
	};
	return { codex: one("codex"), claude: one("claude") };
}

const OTHER: Record<AgentName, AgentName> = { codex: "claude", claude: "codex" };

/**
 * Keyword/shape heuristics. Scores, rather than first-match, so a task mentioning both
 * "refactor" and "architecture" lands on whichever it leans toward. Preferences, not rules
 * — the supervisor may always call `ask_codex` / `ask_claude` directly (_spec/12 E).
 *
 * Phrase-level signals beat bare words where a bare word is ambiguous: "test coverage",
 * "test strategy", and "test plan" describe *assessing* tests, not writing or fixing them,
 * so they are Claude signals in their own right, and the bare `test(s)` Codex signal below
 * excludes them via lookahead rather than colliding on the word "test". A bare "test"/"tests"
 * elsewhere ("fix the failing tests", "write tests for") still reads as implementation work.
 */
const CLAUDE_SIGNALS =
	/\b(architect\w*|design|designs|plan|plans|planning|review|reviews|analy\w+|assess\w*|evaluat\w+|explain\w*|compare|comparison|trade-?offs?|strateg\w+|approach|rationale|risks?|scal\w+|maintainab\w+|second opinion|should we|worth it|pros and cons|test coverage|test(?:ing)? strategy|test plan)\b/i;
const CODEX_SIGNALS =
	/\b(implement\w*|fix\w*|refactor\w*|rewrite|patch\w*|bug|bugs|debug\w*|tests?(?!\s+(?:coverage|strateg\w*|plan))|failing|repro\w*|stack trace|compile\w*|typecheck|lint\w*|migrat\w+|rename|endpoint|add|remove|delete|wire up|hook up|build)\b/i;

function score(text: string, pattern: RegExp): number {
	return (text.match(new RegExp(pattern.source, "gi")) ?? []).length;
}

/**
 * A sentence-initial imperative verb ("Analyze…", "Review…", "Implement…", "Fix…") states
 * intent more strongly than the same word appearing incidentally later in the sentence, so
 * it earns an extra point. Reuses the body patterns rather than a second word list, so the
 * bonus can never drift out of sync with what `score` already counts.
 */
function leadingVerbBonus(text: string, pattern: RegExp): number {
	const leading = text.trim().match(/^[A-Za-z']+/);
	if (!leading) return 0;
	return new RegExp(`^(?:${pattern.source})$`, "i").test(leading[0]) ? 1 : 0;
}

/** The rule table: explicit agent → mode map → keywords → `routing.default`. No model call. */
export function routeByRules(input: RouteInput, config: MultiHarnessConfig): RouteDecision {
	if (input.agent && input.agent !== "auto") {
		return { ok: true, agent: input.agent, routedBy: "explicit", reason: `caller asked for ${input.agent}` };
	}

	if (input.mode) {
		const agent = config.routing.modeMap[input.mode];
		return { ok: true, agent, routedBy: "mode", reason: `mode "${input.mode}" maps to ${agent}` };
	}

	const text = input.task.slice(0, 2_000);
	const claude = score(text, CLAUDE_SIGNALS) + leadingVerbBonus(text, CLAUDE_SIGNALS) + (/\?\s*$/.test(text.trim()) ? 1 : 0);
	const codex = score(text, CODEX_SIGNALS) + leadingVerbBonus(text, CODEX_SIGNALS);
	if (claude > codex) {
		return { ok: true, agent: "claude", routedBy: "rules", reason: "task reads as analysis, planning, or review" };
	}
	if (codex > claude) {
		return { ok: true, agent: "codex", routedBy: "rules", reason: "task reads as implementation, debugging, or tests" };
	}

	const fallback = config.routing.default;
	if (fallback === "codex" || fallback === "claude") {
		return { ok: true, agent: fallback, routedBy: "rules", reason: `no clear signal; routing.default is ${fallback}` };
	}
	// `routing.default: "auto"` with no signal at all: pick the implementer, because an
	// ambiguous ask inside a repository is more often work than commentary.
	return { ok: true, agent: "codex", routedBy: "rules", reason: "no clear signal; defaulting to codex" };
}

const ROUTER_SYSTEM =
	"You route one task to one coding agent. " +
	"codex = implementation, debugging, refactoring, tests, repository modification, targeted code review. " +
	"claude = architecture analysis, planning, design review, broad repository reasoning, second opinions. " +
	"Answer with exactly one word: codex or claude. No punctuation, no explanation.";

/** Router prompt. Task text is capped at 1 000 chars — this is a one-word decision. */
export function buildRouterPrompt(input: RouteInput): string {
	const parts = [ROUTER_SYSTEM, ""];
	if (input.mode) parts.push(`Mode: ${input.mode}`);
	parts.push(`Task:\n${input.task.slice(0, 1_000)}`, "", "Answer (codex or claude):");
	return parts.join("\n");
}

/** Strict single-token parse. Anything else counts as a router failure (_spec/09). */
export function parseRouterAnswer(raw: string): AgentName | undefined {
	const word = raw.trim().toLowerCase().replace(/[^a-z]/g, "");
	return word === "codex" || word === "claude" ? word : undefined;
}

/** Reject after `timeoutMs`; the router gets exactly one attempt, with no retry. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`router model timed out after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

/**
 * Decide which agent runs a task.
 *
 * Every failure mode of the model path degrades silently to `routeByRules`, and an
 * unusable winner falls back to the other agent (T-504). The only non-decision is
 * "neither agent can run", which comes back as a typed refusal.
 */
export async function route(input: RouteInput, deps: RouteDeps): Promise<RouteResult> {
	const { config } = deps;
	const usability = deps.usability ?? ALL_USABLE;

	let decision = routeByRules(input, config);

	const wantsModel = (!input.agent || input.agent === "auto") && config.routing.mode === "model" && deps.askModel;
	if (wantsModel && deps.askModel) {
		try {
			const raw = await withTimeout(
				deps.askModel({ prompt: buildRouterPrompt(input), timeoutMs: config.routing.modelTimeoutMs, signal: deps.signal }),
				config.routing.modelTimeoutMs,
			);
			const agent = parseRouterAnswer(raw);
			if (agent) decision = { ok: true, agent, routedBy: "model", reason: `router model chose ${agent}` };
		} catch {
			// Unresolvable model, timeout, unauthenticated host, junk answer — all the same:
			// keep the rules decision and say nothing. Routing must never break delegation.
		}
	}

	const chosen = usability[decision.agent];
	if (chosen.usable) return decision;

	const other = OTHER[decision.agent];
	if (usability[other].usable) {
		return {
			ok: true,
			agent: other,
			routedBy: "fallback",
			reason: `${decision.agent} unavailable (${chosen.reason ?? "unknown reason"}); using ${other} instead`,
		};
	}

	return {
		ok: false,
		reason:
			`No agent is available. codex: ${usability.codex.reason ?? "unavailable"}. ` +
			`claude: ${usability.claude.reason ?? "unavailable"}. Run /agents for details.`,
	};
}

export type ModelSource = "call" | "config" | "cli";

export interface WorkerModelChoice {
	/** `undefined` means: pass no `-m`/`--model` flag at all. */
	model?: string;
	source: ModelSource;
	/** Present when a supplied value was rejected. */
	warning?: string;
}

/**
 * Worker-model precedence (T-507): per-call `model` → `multiHarness.<agent>.model` → the
 * CLI's own configuration, which is the default this project promises. A value that is not
 * a plain model token is dropped before it can reach argv (_spec/09 §Model selection).
 */
export function resolveWorkerModel(perCall: string | undefined, configured: string | null | undefined): WorkerModelChoice {
	let warning: string | undefined;

	if (perCall !== undefined) {
		if (isValidModelToken(perCall)) return { model: perCall, source: "call" };
		warning = `ignoring model "${perCall.slice(0, 40)}": not a valid model token`;
	}

	if (configured !== undefined && configured !== null) {
		if (isValidModelToken(configured)) return { model: configured, source: "config", warning };
		warning = warning ?? `ignoring configured model "${configured.slice(0, 40)}": not a valid model token`;
	}

	return { source: "cli", warning };
}

/**
 * The real router-model call, for wiring. One `completeSimple` through OMP's own model
 * facade — `routing.model` first, then `routing.modelFallbacks` — and never a second agent
 * turn. `pi-ai` is imported lazily so a host without it degrades to the rules path like any
 * other failure.
 */
export function createModelRouter(ctx: ExtensionContext, specs: string[]): RouterModelFn {
	return async ({ prompt, signal }) => {
		const model = specs.map((spec) => ctx.models.resolve(spec)).find((m) => m !== undefined);
		if (!model) throw new Error(`no router model resolved (tried ${specs.join(", ")})`);

		const { completeSimple } = await import("@oh-my-pi/pi-ai");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		const message = await completeSimple(
			model,
			{ messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
			{ apiKey: auth.ok ? auth.apiKey : undefined, maxTokens: 8, temperature: 0, signal },
		);
		return message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
	};
}
