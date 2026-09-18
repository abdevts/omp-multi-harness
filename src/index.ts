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
import type { AgentName, ExternalAgent } from "./agents/types.ts";
import { registerAgentsCommand } from "./commands/agents.ts";
import { registerDelegateCommand } from "./commands/delegate-command.ts";
import { registerHarnessSetupCommand } from "./commands/harness-setup.ts";
import { registerSessionsCommand } from "./commands/sessions.ts";
import { registerRoutingGuidance } from "./routing/prompt.ts";
import { createRunRegistry } from "./runs/registry.ts";
import type { RunRegistry } from "./runs/types.ts";
import { createSessionStore } from "./sessions/store.ts";
import { registerAgentRunsTool } from "./tools/agent-runs.ts";
import { registerAskAgentTool } from "./tools/ask-agent.ts";
import { registerDelegateTool } from "./tools/delegate.ts";
import { type LoadedConfig, loadConfig } from "./config/load.ts";
import { DEFAULTS, type MultiHarnessConfig } from "./config/schema.ts";

/** Cache key for the (agent, cwd) → worker session mapping. `agent` is a closed set with
 *  no colon, so a colon cannot be ambiguous against anything a path contributes. */
const mappingKey = (agent: AgentName, cwd: string): string => `${agent}:${cwd}`;

export default function multiHarness(pi: ExtensionAPI) {
	pi.setLabel("Multi-Harness");

	// Loaded eagerly so commands registered now have something to read; re-read per session
	// because the working directory (and therefore the project config) can change.
	let loaded: LoadedConfig = loadConfig(process.cwd());
	const getConfig = (): MultiHarnessConfig => (loaded.config.enabled ? loaded.config : { ...DEFAULTS, enabled: false });
	const getSources = (): string[] => loaded.sources;

	const store = createSessionStore({ onWarning: (m) => pi.logger.warn?.(`[multi-harness] ${m}`) });

	/**
	 * The registry resolves a session to resume *synchronously*, but the store is async (the
	 * agent dir resolves lazily). This warm cache bridges the two: filled once per session
	 * before any run can start, then updated in place as runs report their session ids.
	 */
	const sessionIds = new Map<string, string>();
	/** The OMP session id, known only once a session is live. */
	let ompSessionId: string | undefined;

	const agentFor = (agent: AgentName): ExternalAgent => {
		const config = getConfig();
		return agent === "codex" ? new CodexAgent(config.codex) : new ClaudeAgent(config.claude);
	};

	const newRegistry = (): RunRegistry =>
		createRunRegistry({
			config: getConfig,
			agentFor,
			resolveSessionId: (agent, cwd) => sessionIds.get(mappingKey(agent, cwd)),
			onWorkerSession: (agent, cwd, sessionId) => {
				sessionIds.set(mappingKey(agent, cwd), sessionId);
				if (!ompSessionId || !getConfig().sessions.persist) return;
				// Detached: persistence must never fail a run that already succeeded.
				store
					.record(ompSessionId, cwd, agent, sessionId)
					.catch((e) => pi.logger.warn?.(`[multi-harness] session store: ${(e as Error).message}`));
			},
		});

	// Created at load rather than on session_start so tools registered now can close over a
	// getter that is always defined; session_start swaps in a fresh one per session.
	let registry: RunRegistry = newRegistry();
	const getRegistry = (): RunRegistry => registry;

	registerAgentsCommand(pi, getConfig, getRegistry);
	registerHarnessSetupCommand(pi, getConfig, getSources);
	registerSessionsCommand({ pi, getConfig, getRegistry });
	registerRoutingGuidance({ pi, getConfig });

	registerAskAgentTool({ pi, agent: "codex", getConfig, getRegistry });
	registerDelegateCommand({ pi, agent: "codex", getConfig, getRegistry });

	registerAskAgentTool({ pi, agent: "claude", getConfig, getRegistry });
	registerDelegateCommand({ pi, agent: "claude", getConfig, getRegistry });

	registerDelegateTool({ pi, getConfig, getRegistry });
	registerAgentRunsTool({ pi, getConfig, getRegistry });

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		loaded = loadConfig(ctx.cwd);
		clearAvailabilityCache();

		for (const warning of loaded.warnings) pi.logger.warn?.(`[multi-harness] ${warning}`);

		if (!loaded.config.enabled) {
			pi.logger.info?.("[multi-harness] disabled via multiHarness.enabled: false");
			return;
		}

		// A previous session's runs must not outlive it, even if shutdown never fired.
		await registry.shutdown().catch(() => {});
		registry = newRegistry();

		ompSessionId = ctx.sessionManager.getSessionId();
		sessionIds.clear();
		if (loaded.config.sessions.persist && ompSessionId) {
			const mapping = await store.get(ompSessionId, ctx.cwd);
			for (const agent of ["codex", "claude"] as const) {
				const id = mapping?.workers[agent]?.sessionId;
				if (id) sessionIds.set(mappingKey(agent, ctx.cwd), id);
			}
		}

		if (loaded.config.debug) {
			pi.logger.info?.(
				`[multi-harness] config sources: ${loaded.sources.length > 0 ? loaded.sources.join(", ") : "defaults only"}`,
			);
		}
	});

	pi.on("session_shutdown", async () => {
		// Drain before clearing caches: no child or grandchild may outlive OMP (_spec/08).
		await registry.shutdown().catch((e) => pi.logger.warn?.(`[multi-harness] drain: ${(e as Error).message}`));
		clearAvailabilityCache();
		sessionIds.clear();
		ompSessionId = undefined;
	});
}
