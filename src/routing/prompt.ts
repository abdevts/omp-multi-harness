/**
 * Routing guidance for the OMP supervisor (T-503).
 *
 * OMP's `ToolDefinition` has **no** `promptSnippet` / `promptGuidelines` fields — those are
 * upstream `pi` only (verified against 18.2.6). Guidance therefore rides in two supported
 * places: each tool's `description`, and the `before_agent_start` event, whose result may
 * return a replacement `systemPrompt: string[]` ("Extensions chain in order"). That event is
 * the only system-prompt contribution surface `ExtensionAPI` offers; nothing here invents a
 * field that does not exist.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MultiHarnessConfig } from "../config/schema.ts";

/** One line per agent — also the capability summary handed to the router model. */
export const AGENT_SCOPES = {
	codex:
		"Codex — implementation, debugging, refactoring, tests, repository modification, targeted code review.",
	claude:
		"Claude — architecture analysis, planning, design review, broad repository reasoning, second opinions, conceptual risk.",
} as const;

/** What each tool is for, in the supervisor's own words. */
export const TOOL_SCOPES = {
	ask_codex: "Hand one self-contained coding task to the Codex CLI and get its answer.",
	ask_claude: "Hand one self-contained reasoning or review task to the Claude Code CLI and get its answer.",
	delegate: "Same surface, but `agent: \"auto\"` lets the harness pick; the result always reports how it routed.",
	agent_runs: "Manage background runs: list, status, result, cancel, wait. This is how you join fan-out work.",
} as const;

/**
 * The system-prompt contribution. Preferences, not a workflow: the supervisor must stay
 * free to answer directly or to call one agent only (_spec/12 E).
 */
export const ROUTING_GUIDANCE = [
	"# Delegating to external coding agents (multi-harness)",
	"",
	`${AGENT_SCOPES.codex}`,
	`${AGENT_SCOPES.claude}`,
	"",
	`- ask_codex — ${TOOL_SCOPES.ask_codex}`,
	`- ask_claude — ${TOOL_SCOPES.ask_claude}`,
	`- delegate — ${TOOL_SCOPES.delegate}`,
	`- agent_runs — ${TOOL_SCOPES.agent_runs}`,
	"",
	"These are preferences, not a required workflow:",
	"- Do not delegate trivial work, and do not invoke both agents when one suffices.",
	"- For hard tasks, consider Claude plans → Codex implements → Claude reviews read-only → Codex fixes.",
	"- Prefer a read-only review before giving another agent write access to the same files.",
	"- Use background runs only when two tasks are genuinely independent; join them with agent_runs.",
	"- State each task as a self-contained instruction: a worker cannot see this conversation.",
].join("\n");

export interface RoutingGuidanceDeps {
	pi: ExtensionAPI;
	getConfig: () => MultiHarnessConfig;
}

/**
 * Append {@link ROUTING_GUIDANCE} to the system prompt, gated on
 * `multiHarness.routing.promptGuidance`. Registered during load; the handler re-reads config
 * per turn so toggling it takes effect without a restart.
 */
export function registerRoutingGuidance({ pi, getConfig }: RoutingGuidanceDeps): void {
	pi.on("before_agent_start", (event) => {
		const config = getConfig();
		if (!config.enabled || !config.routing.promptGuidance) return;
		// `event.systemPrompt` is the freshly computed base each turn, so appending cannot
		// accumulate — the guard is for hosts that replay a prepared prompt.
		if (event.systemPrompt.includes(ROUTING_GUIDANCE)) return;
		return { systemPrompt: [...event.systemPrompt, ROUTING_GUIDANCE] };
	});
}
