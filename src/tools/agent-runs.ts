/**
 * `agent_runs` (T-502) — the supervisor's handle on background work: fan out several runs,
 * then join them, without the user having to drive `/sessions` (_spec/06-tools.md).
 *
 * Every answer is compact, model-readable text. Unknown ids and already-finished cancels are
 * ordinary results, not errors — the supervisor should be able to poll without exception
 * handling.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { MultiHarnessConfig } from "../config/schema.ts";
import { truncateMiddle } from "../routing/handoff.ts";
import { isTerminal, type RunRegistry, type RunView } from "../runs/types.ts";

const ACTIONS = ["list", "status", "result", "cancel", "wait"] as const;
const DEFAULT_WAIT_MS = 60_000;

const DESCRIPTION =
	"Manage delegated agent runs started with background: true. " +
	"list = every run in this session with status and elapsed time; status = one run without its output; " +
	"result = the finished output of one run; cancel = stop a run; wait = block until a run finishes or waitMs elapses. " +
	"Fan out independent work with background runs, then join it here.";

/** What the schema below accepts — see the cast note in `ask-agent.ts`. */
interface AgentRunsParams {
	action: (typeof ACTIONS)[number];
	runId?: string;
	waitMs?: number;
}

function elapsed(view: RunView): string {
	return `${(view.elapsedMs / 1000).toFixed(1)}s`;
}

/** One line for `list`: everything needed to decide what to do next, nothing more. */
export function renderRunLine(view: RunView): string {
	const bits = [view.id, view.agent];
	if (view.mode) bits.push(view.mode);
	bits.push(view.status, elapsed(view));
	if (!isTerminal(view.status) && view.phase) bits.push(view.phase);
	return `${bits.join(" · ")} — ${view.summary}`;
}

/**
 * Full rendering of one run, with its output truncated from the middle at
 * `limits.maxOutputChars`. Shared with `delegate` so a foreground call and a joined
 * background run read identically.
 */
export function renderRunView(view: RunView, maxOutputChars: number): { text: string; truncated: boolean } {
	const header = [view.agent, view.status, elapsed(view)];
	if (view.mode) header.splice(1, 0, view.mode);
	if (view.workerSessionId) header.push(`session ${view.workerSessionId.slice(0, 8)}`);
	if (view.readOnly) header.push("read-only");

	if (view.errorCode) {
		return { text: `[${header.join(" · ")}]\n${view.errorCode}: ${view.errorMessage ?? "failed"}`, truncated: false };
	}

	const body = truncateMiddle(view.output ?? "(no output)", maxOutputChars);
	return { text: `[${header.join(" · ")}]\n${body.text}`, truncated: body.truncated };
}

export interface AgentRunsDeps {
	pi: ExtensionAPI;
	getConfig: () => MultiHarnessConfig;
	/** Taken as a getter so this module never imports the registry implementation. */
	getRegistry: () => RunRegistry;
}

/** Details are free-form state carried back to the supervisor, so one shape for every
 *  branch keeps the tool's inferred result type uniform. */
type Details = Record<string, unknown>;

function reply(body: string, details?: Details, isError?: boolean) {
	return { content: [{ type: "text" as const, text: body }], details, isError };
}
const missing = (action: string) => reply(`runId is required for action "${action}".`);
const unknown = (runId: string) => reply(`No run with id ${runId}. Use action "list" to see current runs.`);

export function registerAgentRunsTool({ pi, getConfig, getRegistry }: AgentRunsDeps): void {
	const z = pi.zod;

	pi.registerTool({
		name: "agent_runs",
		label: "Agent Runs",
		description: DESCRIPTION,
		// Read-only over the registry; `cancel` stops a child this extension already owns.
		approval: "read",
		parameters: z.object({
			action: z.enum(ACTIONS).describe("list | status | result | cancel | wait"),
			runId: z.string().optional().describe("Required for status, result, cancel, and wait."),
			waitMs: z.number().optional().describe("Cap for action \"wait\". Default 60000."),
		}),
		async execute(_toolCallId, rawParams) {
			const params = rawParams as AgentRunsParams;
			const config = getConfig();
			const registry = getRegistry();

			if (params.action === "list") {
				const runs = registry.list();
				if (runs.length === 0) return reply("No agent runs in this session.");
				return reply(runs.map(renderRunLine).join("\n"), { count: runs.length, runIds: runs.map((r) => r.id) });
			}

			const runId = params.runId?.trim();
			if (!runId) return missing(params.action);

			if (params.action === "cancel") {
				const before = registry.get(runId);
				if (!before) return unknown(runId);
				// Idempotent by contract: cancelling a terminal run reports, never throws.
				const cancelled = await registry.cancel(runId);
				const after = registry.get(runId) ?? before;
				return reply(
					cancelled ? `Cancelled ${runId} (${after.agent}).` : `${runId} was already ${after.status}; nothing to cancel.`,
					{ runId, cancelled, status: after.status },
				);
			}

			if (params.action === "wait") {
				const waitMs = params.waitMs && params.waitMs > 0 ? params.waitMs : DEFAULT_WAIT_MS;
				const view = await registry.wait(runId, waitMs);
				if (!view) return unknown(runId);
				if (!isTerminal(view.status)) {
					return reply(
						`${runId} is still ${view.status} after ${(waitMs / 1000).toFixed(0)}s — ${view.phase || "no phase"}. Wait again or check status.`,
						{ runId, status: view.status, timedOut: true },
					);
				}
				const rendered = renderRunView(view, config.limits.maxOutputChars);
				return reply(rendered.text, {
					runId,
					agent: view.agent,
					status: view.status,
					durationMs: view.elapsedMs,
					truncated: rendered.truncated,
				});
			}

			const view = registry.get(runId);
			if (!view) return unknown(runId);

			if (params.action === "status") {
				const bits = [view.agent, view.status, elapsed(view)];
				if (view.phase) bits.push(view.phase);
				return reply(`${runId} · ${bits.join(" · ")} — ${view.summary}`, {
					runId,
					agent: view.agent,
					status: view.status,
					phase: view.phase,
					elapsedMs: view.elapsedMs,
				});
			}

			// result
			if (!isTerminal(view.status)) {
				return reply(`${runId} is still ${view.status} (${elapsed(view)}) — ${view.phase || "no phase"}. Use action "wait" to join it.`, {
					runId,
					status: view.status,
				});
			}
			const rendered = renderRunView(view, config.limits.maxOutputChars);
			return reply(
				rendered.text,
				{ runId, agent: view.agent, status: view.status, durationMs: view.elapsedMs, truncated: rendered.truncated },
				view.status === "failed",
			);
		},
	});
}
