/** `/codex <task>` and `/claude <task>` — direct delegation, bypassing routing. */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { MODE_DEFAULT_READ_ONLY, type AgentMode, type AgentName, type ExternalAgent } from "../agents/types.ts";
import { isValidModelToken, type MultiHarnessConfig } from "../config/schema.ts";
import { AgentError } from "../process/process-error.ts";
import { buildHandoff, renderResult } from "../routing/handoff.ts";

const MODES = new Set<AgentMode>(["analyze", "plan", "implement", "debug", "review", "test"]);

export interface ParsedCommand {
	task: string;
	readOnly?: boolean;
	newSession: boolean;
	background: boolean;
	model?: string;
	mode?: AgentMode;
	errors: string[];
}

/** Flags are stripped from the front; everything else is the task, verbatim. */
export function parseDelegateArgs(args: string): ParsedCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const result: ParsedCommand = { task: "", newSession: false, background: false, errors: [] };
	let i = 0;

	for (; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) break;
		switch (token) {
			case "--read-only":
				result.readOnly = true;
				break;
			case "--write":
				result.readOnly = false;
				break;
			case "--new":
				result.newSession = true;
				break;
			case "--bg":
				result.background = true;
				break;
			case "--model": {
				const value = tokens[++i];
				if (!value) result.errors.push("--model needs a value");
				else if (!isValidModelToken(value)) result.errors.push(`--model ${value}: not a valid model token`);
				else result.model = value;
				break;
			}
			case "--mode": {
				const value = tokens[++i];
				if (value && MODES.has(value as AgentMode)) result.mode = value as AgentMode;
				else result.errors.push(`--mode ${value ?? ""}: expected one of ${[...MODES].join(", ")}`);
				break;
			}
			default:
				result.errors.push(`unknown flag ${token}`);
		}
	}

	result.task = tokens.slice(i).join(" ");
	return result;
}

export interface DelegateCommandDeps {
	pi: ExtensionAPI;
	agent: AgentName;
	getConfig: () => MultiHarnessConfig;
	createAgent: (config: MultiHarnessConfig) => ExternalAgent;
}

export function registerDelegateCommand({ pi, agent, getConfig, createAgent }: DelegateCommandDeps): void {
	pi.registerCommand(agent, {
		description: `Delegate a task directly to ${agent === "codex" ? "Codex" : "Claude Code"}`,
		getArgumentCompletions: (prefix: string) =>
			["--read-only", "--new", "--model", "--mode"]
				.filter((f) => f.startsWith(prefix))
				.map((f) => ({ value: f, label: f })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = getConfig();
			const parsed = parseDelegateArgs(args);

			if (parsed.errors.length > 0) {
				ctx.ui.notify(parsed.errors.join("\n"), "error");
				return;
			}
			if (!parsed.task) {
				ctx.ui.notify(`Usage: /${agent} [--read-only] [--new] [--mode <mode>] [--model <id>] <task>`, "warning");
				return;
			}
			if (!config.enabled || !config[agent].enabled) {
				ctx.ui.notify(`${agent} is disabled in config (multiHarness.${agent}.enabled).`, "error");
				return;
			}
			if (parsed.background) {
				ctx.ui.notify("Background runs arrive with /sessions in Phase 4.", "warning");
				return;
			}

			const readOnly = parsed.readOnly ?? (parsed.mode ? MODE_DEFAULT_READ_ONLY[parsed.mode] : false);
			const controller = new AbortController();

			ctx.ui.setStatus("multi-harness", `${agent}: starting`);
			try {
				const result = await createAgent(config).run(
					{
						agent,
						task: buildHandoff({ task: parsed.task, mode: parsed.mode, maxChars: config.limits.maxHandoffChars }),
						cwd: ctx.cwd,
						mode: parsed.mode,
						readOnly,
						model: parsed.model,
					},
					{
						signal: controller.signal,
						onProgress: (p) => ctx.ui.setStatus("multi-harness", `${agent}: ${p.phase}`),
					},
				);

				const rendered = renderResult(result, config.limits.maxOutputChars);
				// Relayed as `agent` attribution so consumers can tell it from user-typed text,
				// and so the supervisor can act on it.
				await pi.sendUserMessage(rendered.text, { attribution: "agent" });
			} catch (e) {
				const message =
					e instanceof AgentError ? `${e.code}: ${e.message}` : `Unexpected failure: ${(e as Error).message}`;
				ctx.ui.notify(message, "error");
			} finally {
				ctx.ui.setStatus("multi-harness", undefined);
			}
		},
	});
}
