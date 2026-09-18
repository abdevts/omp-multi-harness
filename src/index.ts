/**
 * omp-multi-harness — OMP supervises the Codex and Claude Code CLIs.
 *
 * Load phase is REGISTRATION ONLY: action methods (pi.sendMessage, …) throw
 * ExtensionRuntimeNotInitializedError if called here (_spec/01 §2). Anything that needs a
 * live session happens in an event handler, a command, or a tool.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { clearAvailabilityCache } from "./agents/availability.ts";
import { ClaudeAgent } from "./agents/claude.ts";
import { CodexAgent } from "./agents/codex.ts";
import { registerAgentsCommand } from "./commands/agents.ts";
import { registerDelegateCommand } from "./commands/delegate-command.ts";
import { registerHarnessSetupCommand } from "./commands/harness-setup.ts";
import { registerAskAgentTool } from "./tools/ask-agent.ts";
import { type LoadedConfig, loadConfig } from "./config/load.ts";
import { DEFAULTS, type MultiHarnessConfig } from "./config/schema.ts";

export default function multiHarness(pi: ExtensionAPI) {
	pi.setLabel("Multi-Harness");

	// Loaded eagerly so commands registered now have something to read; re-read per session
	// because the working directory (and therefore the project config) can change.
	let loaded: LoadedConfig = loadConfig(process.cwd());
	const getConfig = (): MultiHarnessConfig => (loaded.config.enabled ? loaded.config : { ...DEFAULTS, enabled: false });
	const getSources = (): string[] => loaded.sources;

	registerAgentsCommand(pi, getConfig);
	registerHarnessSetupCommand(pi, getConfig, getSources);

	const createCodex = (config: MultiHarnessConfig) => new CodexAgent(config.codex);
	registerAskAgentTool({ pi, agent: "codex", getConfig, createAgent: createCodex });
	registerDelegateCommand({ pi, agent: "codex", getConfig, createAgent: createCodex });

	const createClaude = (config: MultiHarnessConfig) => new ClaudeAgent(config.claude);
	registerAskAgentTool({ pi, agent: "claude", getConfig, createAgent: createClaude });
	registerDelegateCommand({ pi, agent: "claude", getConfig, createAgent: createClaude });

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		loaded = loadConfig(ctx.cwd);
		clearAvailabilityCache();

		for (const warning of loaded.warnings) pi.logger.warn?.(`[multi-harness] ${warning}`);

		if (!loaded.config.enabled) {
			pi.logger.info?.("[multi-harness] disabled via multiHarness.enabled: false");
			return;
		}
		if (loaded.config.debug) {
			pi.logger.info?.(
				`[multi-harness] config sources: ${loaded.sources.length > 0 ? loaded.sources.join(", ") : "defaults only"}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		clearAvailabilityCache();
	});
}
