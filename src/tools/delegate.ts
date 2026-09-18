/**
 * `delegate` (T-501) — one entry point that picks the agent for you.
 *
 * Same surface as `ask_codex` / `ask_claude` plus `agent: "auto" | "codex" | "claude"` and
 * `background`. Routing is done by `routing/route.ts` and always reported back in `details`
 * (`routedBy` + the reason), so no delegation is a black box (_spec/06-tools.md).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { detect } from "../agents/availability.ts";
import { MODE_DEFAULT_READ_ONLY, type AgentAvailability, type AgentMode, type AgentName } from "../agents/types.ts";
import type { MultiHarnessConfig } from "../config/schema.ts";
import { buildHandoff, summarize } from "../routing/handoff.ts";
import { createModelRouter, resolveWorkerModel, route, usabilityFrom, type RouterModelFn } from "../routing/route.ts";
import type { RunRegistry } from "../runs/types.ts";
import { renderRunView } from "./agent-runs.ts";

const AGENTS = ["auto", "codex", "claude"] as const;
const MODES = ["analyze", "plan", "implement", "debug", "review", "test"] as const;

const DESCRIPTION =
	"Delegate one self-contained task to an external coding CLI running in this repository. " +
	"agent: \"auto\" lets the harness route it — Codex for implementation, debugging, refactoring and tests, " +
	"Claude for architecture analysis, planning, review and second opinions — and the result says how it routed. " +
	"Use ask_codex / ask_claude when you already know which one you want. " +
	"With background: true it returns a run id immediately; join it later with agent_runs.";

/** What the schema below accepts — see the cast note in `ask-agent.ts`. */
interface DelegateParams {
	agent?: "auto" | AgentName;
	task: string;
	mode?: AgentMode;
	context?: string;
	readOnly?: boolean;
	continueSession?: boolean;
	background?: boolean;
	model?: string;
}

export interface DelegateDeps {
	pi: ExtensionAPI;
	getConfig: () => MultiHarnessConfig;
	/** Taken as a getter so this module never imports the registry implementation. */
	getRegistry: () => RunRegistry;
	/** Injected so tests never spawn a process. Defaults to the cached detector. */
	getAvailability?: (agent: AgentName, config: MultiHarnessConfig, cwd: string) => Promise<AgentAvailability | undefined>;
	/** Injected so tests never make a network call. Returning undefined forces the rules path. */
	createRouter?: (ctx: ExtensionContext, config: MultiHarnessConfig) => RouterModelFn | undefined;
}

const defaultAvailability = async (agent: AgentName, config: MultiHarnessConfig, cwd: string) =>
	// Auth is not probed here: it costs a process spawn per call, and an unauthenticated
	// worker fails loudly on its own with an actionable error.
	detect(agent, config[agent], { cwd, skipAuth: true });

const defaultRouter = (ctx: ExtensionContext, config: MultiHarnessConfig): RouterModelFn | undefined =>
	config.routing.mode === "model"
		? createModelRouter(ctx, [config.routing.model, ...config.routing.modelFallbacks])
		: undefined;

export function registerDelegateTool({ pi, getConfig, getRegistry, getAvailability, createRouter }: DelegateDeps): void {
	const z = pi.zod;
	const availabilityOf = getAvailability ?? defaultAvailability;
	const routerFor = createRouter ?? defaultRouter;

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: DESCRIPTION,
		// NOTE: OMP's ToolDefinition has no promptSnippet/promptGuidelines (upstream pi only).
		// Broader guidance lives in routing/prompt.ts — see T-503.
		approval: "exec",
		parameters: z.object({
			agent: z.enum(AGENTS).optional().describe("Which agent to use. Default \"auto\" — the harness routes it."),
			task: z.string().describe("A self-contained instruction. The worker cannot see this conversation."),
			mode: z.enum(MODES).optional().describe("Shapes the instruction, the default read-only setting, and routing."),
			context: z.string().optional().describe("Compact handoff context. Never paste the whole conversation."),
			readOnly: z.boolean().optional().describe("Force read-only. Defaults from mode."),
			continueSession: z.boolean().optional().describe("Reuse this session's worker session. Default true."),
			background: z
				.boolean()
				.optional()
				.describe("Return a run id immediately instead of waiting. Join it with agent_runs."),
			model: z.string().optional().describe("Worker model override. Omit to use the CLI's own configuration."),
		}),
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx: ExtensionContext) {
			const params = rawParams as DelegateParams;
			const config = getConfig();

			if (!config.enabled) {
				return { content: [{ type: "text" as const, text: "multi-harness is disabled (multiHarness.enabled: false)." }], isError: true };
			}

			const detected: Partial<Record<AgentName, AgentAvailability>> = {};
			for (const agent of ["codex", "claude"] as const) {
				if (!config[agent].enabled) continue;
				try {
					detected[agent] = await availabilityOf(agent, config, ctx.cwd);
				} catch {
					// Detection is advisory; a failure here must not stop a delegation.
				}
			}

			const decision = await route(
				{ agent: params.agent, task: params.task, mode: params.mode },
				{
					config,
					usability: usabilityFrom(config, detected),
					askModel: routerFor(ctx, config),
					signal: signal ?? undefined,
				},
			);

			if (!decision.ok) {
				return { content: [{ type: "text" as const, text: decision.reason }], isError: true };
			}

			const agent = decision.agent;
			const mode = params.mode;
			const readOnly = params.readOnly ?? (mode ? MODE_DEFAULT_READ_ONLY[mode] : false);
			const worker = resolveWorkerModel(params.model, config[agent].model);
			if (worker.warning) pi.logger.warn?.(`[multi-harness] ${worker.warning}`);

			const task = buildHandoff({
				task: params.task,
				mode,
				context: params.context,
				maxChars: config.limits.maxHandoffChars,
			});

			const routing = { routedBy: decision.routedBy, routingReason: decision.reason };

			try {
				const started = getRegistry().start({
					agent,
					task,
					summary: summarize(params.task),
					cwd: ctx.cwd,
					mode,
					readOnly,
					model: worker.model,
					continueSession: params.continueSession,
					background: params.background === true,
				});

				if (params.background === true) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`[${agent} · running · ${started.id}] routed by ${decision.routedBy}: ${decision.reason}\n` +
									`Started in the background. Join it with agent_runs (action "wait", runId "${started.id}").`,
							},
						],
						details: { runId: started.id, status: "running" as const, agent, model: worker.model ?? null, ...routing },
					};
				}

				// Foreground: a caller-side abort must stop the child, not just stop waiting.
				const onAbort = () => void getRegistry().cancel(started.id);
				signal?.addEventListener("abort", onAbort, { once: true });
				try {
					const view = (await getRegistry().wait(started.id)) ?? getRegistry().get(started.id);
					if (!view) {
						return { content: [{ type: "text" as const, text: `Run ${started.id} disappeared before it produced a result.` }], isError: true };
					}
					const rendered = renderRunView(view, config.limits.maxOutputChars);
					return {
						content: [{ type: "text" as const, text: `${rendered.text}\n\nrouted by ${decision.routedBy}: ${decision.reason}` }],
						details: {
							runId: view.id,
							agent,
							sessionId: view.workerSessionId,
							status: view.status,
							durationMs: view.elapsedMs,
							readOnlyEnforced: readOnly,
							truncated: rendered.truncated,
							model: worker.model ?? null,
							...routing,
						},
						isError: view.status === "failed",
					};
				} finally {
					signal?.removeEventListener("abort", onAbort);
					ctx.ui.setStatus("multi-harness", undefined);
				}
			} catch (e) {
				return {
					content: [{ type: "text" as const, text: `Could not delegate to ${agent}: ${(e as Error).message}` }],
					details: { agent, ...routing },
					isError: true,
				};
			}
		},
	});
}
