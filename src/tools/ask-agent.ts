/**
 * `ask_codex` / `ask_claude`. Both tools are the same surface over a different adapter, so
 * they are built from one factory (_spec/06-tools.md).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MODE_DEFAULT_READ_ONLY, type AgentMode, type AgentName } from "../agents/types.ts";
import type { MultiHarnessConfig } from "../config/schema.ts";
import type { RunRegistry, RunView } from "../runs/types.ts";
import { AgentError, agentDisabled } from "../process/process-error.ts";
import { buildHandoff, summarize, truncateMiddle } from "../routing/handoff.ts";
import { resolveWorkerModel } from "../routing/route.ts";

const MODES = ["analyze", "plan", "implement", "debug", "review", "test"] as const;

const DESCRIPTION: Record<AgentName, string> = {
	codex:
		"Delegate a coding task to the Codex CLI, which runs in this repository with its own tools and its own session. " +
		"Best for implementation, debugging, refactoring, tests, and targeted code review. " +
		"State the task as a self-contained instruction: the worker cannot see this conversation. " +
		"Prefer a read-only review before giving any agent write access to the same files.",
	claude:
		"Delegate a task to the Claude Code CLI, which runs in this repository with its own tools and its own session. " +
		"Best for architecture analysis, planning, design review, broad repository reasoning, and second opinions. " +
		"State the task as a self-contained instruction: the worker cannot see this conversation. " +
		"Prefer a read-only review before giving any agent write access to the same files.",
};

/** What the schema below accepts. OMP's Static<> inference does not survive the
 *  `pi.zod` builder handed to an extension, so `execute` casts to this once. */
interface AskAgentParams {
	task: string;
	mode?: AgentMode;
	context?: string;
	readOnly?: boolean;
	continueSession?: boolean;
	model?: string;
	background?: boolean;
}

export interface AskAgentDeps {
	pi: ExtensionAPI;
	agent: AgentName;
	getConfig: () => MultiHarnessConfig;
	/** Taken as a getter so this module never imports the registry implementation. */
	getRegistry: () => RunRegistry;
}

export function registerAskAgentTool({ pi, agent, getConfig, getRegistry }: AskAgentDeps): void {
	const z = pi.zod;

	pi.registerTool({
		name: `ask_${agent}`,
		label: agent === "codex" ? "Ask Codex" : "Ask Claude",
		description: DESCRIPTION[agent],
		// NOTE: OMP's ToolDefinition has no promptSnippet/promptGuidelines (those are upstream
		// pi's API). Routing guidance is carried by the description instead — see T-503.
		approval: "exec",
		parameters: z.object({
			task: z.string().describe("A self-contained instruction. The worker cannot see this conversation."),
			mode: z.enum(MODES).optional().describe("Shapes the instruction and the default read-only setting."),
			context: z.string().optional().describe("Compact handoff context. Never paste the whole conversation."),
			readOnly: z.boolean().optional().describe("Force read-only. Defaults from mode."),
			continueSession: z.boolean().optional().describe("Reuse this session's worker session. Default true."),
			model: z.string().optional().describe("Worker model override. Omit to use the CLI's own configuration."),
			background: z
				.boolean()
				.optional()
				.describe("Return a run id immediately instead of waiting. Check it with agent_runs or /sessions."),
		}),
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionContext) {
			const params = rawParams as AskAgentParams;
			const config = getConfig();
			const agentConfig = config[agent];

			if (!config.enabled || !agentConfig.enabled) {
				const error = agentDisabled(agent);
				return { content: [{ type: "text" as const, text: error.message }], isError: true };
			}

			const mode = params.mode;
			const readOnly = params.readOnly ?? (mode ? MODE_DEFAULT_READ_ONLY[mode] : false);

			const task = buildHandoff({
				task: params.task,
				mode,
				context: params.context,
				maxChars: config.limits.maxHandoffChars,
			});

			// Both paths go through the registry, not straight to the adapter: that is what gives
			// every call the workspace write lock, the concurrency cap, and a row in `/sessions`.
			const registry = getRegistry();
			const started = registry.start({
				agent,
				task,
				summary: summarize(params.task),
				cwd: ctx.cwd,
				mode,
				readOnly,
				model: params.model,
				continueSession: params.continueSession,
				background: params.background === true,
			});

			// T-507 precedence lives in one place; this tool must not re-derive it.
			const resolvedModel = resolveWorkerModel(params.model, agentConfig.model).model ?? null;

			if (params.background === true) {
				// Detached by design. `.catch` is mandatory — an unhandled rejection here would
				// escape into the OMP session (_spec/01 §2).
				registry
					.wait(started.id)
					.then((finished) => {
						if (finished) deliverBackgroundResult({ pi, ctx, run: finished, config });
					})
					.catch((e) => pi.logger.warn?.(`[multi-harness] background run ${started.id}: ${(e as Error).message}`));

				return {
					content: [
						{
							type: "text" as const,
							text:
								`Started ${agent} run \`${started.id}\` in the background (${started.status}).\n` +
								`Check it with \`agent_runs\` (action: "status" or "wait") or \`/sessions\`.`,
						},
					],
					details: { agent, runId: started.id, status: started.status, background: true, model: resolvedModel },
				};
			}

			try {
				const abort = signal ?? new AbortController().signal;
				const onAbort = () => void registry.cancel(started.id);
				abort.addEventListener("abort", onAbort, { once: true });

				const unsubscribe = registry.subscribe((run) => {
					if (run.id === started.id) ctx.ui.setStatus("multi-harness", `${agent}: ${run.phase}`);
				});

				try {
					const finished = await registry.wait(started.id);
					if (!finished) {
						return { content: [{ type: "text" as const, text: `Run ${started.id} disappeared from the registry.` }], isError: true };
					}
					if (finished.status !== "done") {
						const detail = finished.errorMessage ?? `run ${finished.status}`;
						return {
							content: [{ type: "text" as const, text: `${finished.errorCode ?? finished.status.toUpperCase()}: ${detail}` }],
							isError: true,
							details: { agent, runId: finished.id, status: finished.status },
						};
					}

					const { text, truncated } = truncateMiddle(finished.output ?? "", config.limits.maxOutputChars);
					return {
						content: [{ type: "text" as const, text }],
						details: {
							agent,
							runId: finished.id,
							sessionId: finished.workerSessionId,
							durationMs: finished.elapsedMs,
							// The adapter's claim, derived from the argv it actually built — not the
							// caller's request. Absent metadata means the adapter could not prove it.
							readOnlyRequested: readOnly,
							readOnlyEnforced: finished.metadata?.readOnlyEnforced === true,
							readOnlyMechanism: finished.metadata?.readOnlyMechanism ?? null,
							truncated,
							model: resolvedModel,
							routedBy: "explicit" as const,
						},
					};
				} finally {
					unsubscribe();
					abort.removeEventListener("abort", onAbort);
				}
			} catch (e) {
				const message =
					e instanceof AgentError
						? `${e.code}: ${e.message}`
						: `Unexpected failure delegating to ${agent}: ${(e as Error).message}`;
				return { content: [{ type: "text" as const, text: message }], isError: true };
			} finally {
				ctx.ui.setStatus("multi-harness", undefined);
			}
		},
	});
}

export interface BackgroundDeliveryDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	run: RunView;
	config: MultiHarnessConfig;
}

/**
 * Called when a `background: true` run reaches a terminal status. The supervisor is very
 * likely mid-turn on something else by now, so how loudly this lands is a policy choice —
 * see the TODO below.
 */
export function deliverBackgroundResult({ pi, ctx, run, config }: BackgroundDeliveryDeps): void {
	// Always durable first: spec 08 requires a finished background run to survive a reload,
	// and `appendEntry` is state-only (never sent to the LLM), so it is safe unconditionally.
	pi.appendEntry("multi-harness-run", {
		runId: run.id,
		agent: run.agent,
		status: run.status,
		workerSessionId: run.workerSessionId,
		summary: run.summary,
		elapsedMs: run.elapsedMs,
	});

	// Deliberately a notification, not a `pi.sendUserMessage` injection. A background run
	// finishes at an arbitrary moment — very likely while the supervisor is mid-turn on
	// something unrelated — and injecting the worker's output there would derail that turn.
	// The caller was handed a run id and told to poll, so `agent_runs` and `/sessions` are
	// the retrieval path; this only has to make sure a finished run is never *missed*.
	const label = `${run.agent} run ${run.id}`;
	if (run.status === "done") {
		const { text } = truncateMiddle(run.output ?? "", Math.min(240, config.limits.maxOutputChars));
		const preview = text.replace(/\s+/g, " ").trim();
		ctx.ui.notify(`${label} finished. ${preview || "(no output)"}`, "info");
		return;
	}

	// A silent failure costs more than a silent success: the caller may still be waiting on
	// work that will never arrive, so failures and cancellations always say why.
	const reason = run.errorMessage ?? run.status;
	ctx.ui.notify(`${label} ${run.status}: ${run.errorCode ? `${run.errorCode} — ` : ""}${reason}`, "error");
}
