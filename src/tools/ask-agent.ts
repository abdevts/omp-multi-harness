/**
 * `ask_codex` / `ask_claude`. Both tools are the same surface over a different adapter, so
 * they are built from one factory (_spec/06-tools.md).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MODE_DEFAULT_READ_ONLY, type AgentMode, type AgentName, type ExternalAgent } from "../agents/types.ts";
import type { MultiHarnessConfig } from "../config/schema.ts";
import { AgentError, agentDisabled } from "../process/process-error.ts";
import { buildHandoff, renderResult } from "../routing/handoff.ts";

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
}

export interface AskAgentDeps {
	pi: ExtensionAPI;
	agent: AgentName;
	getConfig: () => MultiHarnessConfig;
	createAgent: (config: MultiHarnessConfig) => ExternalAgent;
}

export function registerAskAgentTool({ pi, agent, getConfig, createAgent }: AskAgentDeps): void {
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

			try {
				const result = await createAgent(config).run(
					{ agent, task, cwd: ctx.cwd, mode, readOnly, model: params.model },
					{
						signal: signal ?? new AbortController().signal,
						onProgress: (p) => ctx.ui.setStatus("multi-harness", `${agent}: ${p.phase}`),
					},
				);

				const rendered = renderResult(result, config.limits.maxOutputChars);
				return {
					content: [{ type: "text" as const, text: rendered.text }],
					details: {
						agent,
						sessionId: result.sessionId,
						exitCode: result.exitCode,
						durationMs: result.durationMs,
						readOnlyEnforced: readOnly,
						truncated: rendered.truncated,
						model: params.model ?? agentConfig.model ?? null,
						routedBy: "explicit" as const,
					},
				};
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
