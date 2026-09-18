import { describe, expect, test } from "bun:test";
import { renderAgentsReport, type RunCounts, type WorkspaceStatus } from "../src/commands/agents.ts";
import type { AgentAvailability } from "../src/agents/types.ts";

const WORKSPACE: WorkspaceStatus = { cwd: "/Users/x/dev/projects/foo", writeLockHeld: false };

const readyCodex: AgentAvailability = {
	agent: "codex",
	available: true,
	executablePath: "/opt/homebrew/bin/codex",
	version: "codex-cli 0.155.0",
	auth: "ok",
	authDetail: "Logged in using ChatGPT",
};

const readyClaude: AgentAvailability = {
	agent: "claude",
	available: true,
	executablePath: "/Users/x/.local/bin/claude",
	version: "2.1.274 (Claude Code)",
	auth: "ok",
	authDetail: "logged in via claude.ai",
};

const missingCodex: AgentAvailability = {
	agent: "codex",
	available: false,
	auth: "unknown",
	authDetail: "-",
	reason: "`codex` not found on PATH",
};

const missingClaude: AgentAvailability = {
	agent: "claude",
	available: false,
	auth: "unknown",
	authDetail: "-",
	reason: "`claude` not found on PATH",
};

const disabledClaude: AgentAvailability = {
	agent: "claude",
	available: false,
	auth: "unknown",
	authDetail: "-",
	reason: "disabled in config (multiHarness.claude.enabled)",
};

describe("renderAgentsReport", () => {
	test("renders both agents ready, plus workspace free-lock and run counts", () => {
		const runs: RunCounts = { running: 2, finished: 5 };
		const out = renderAgentsReport([readyCodex, readyClaude], WORKSPACE, runs);

		expect(out).toContain("Codex");
		expect(out).toContain("Claude Code");
		expect(out).toContain("status:     ready");
		expect(out).toContain("Workspace: /Users/x/dev/projects/foo   (write lock: free)");
		expect(out).toContain("Runs: 2 running, 5 finished");
		expect(out).toContain("Ready: Codex, Claude Code");
	});

	test("omits the Runs line entirely when no registry was supplied — never fabricates a count", () => {
		const out = renderAgentsReport([readyCodex, readyClaude], WORKSPACE);
		expect(out).not.toContain("Runs:");
	});

	test("shows the write lock holder when held", () => {
		const held: WorkspaceStatus = { cwd: "/repo", writeLockHeld: true, writeLockHolder: "claude" };
		const out = renderAgentsReport([readyCodex], held);
		expect(out).toContain("Workspace: /repo   (write lock: held by claude)");
	});

	test("missing executable: exact status wording plus exact remediation command, never throws", () => {
		expect(() => renderAgentsReport([missingCodex, readyClaude], WORKSPACE)).not.toThrow();
		const out = renderAgentsReport([missingCodex, readyClaude], WORKSPACE);

		expect(out).toContain("status:     unavailable — executable not found");
		expect(out).toContain("fix:        Install the Codex CLI, or set multiHarness.codex.executable to its full path.");
		// The other agent still renders normally alongside the missing one.
		expect(out).toContain("Claude Code");
		expect(out).toContain("status:     ready");
		// Workspace line renders regardless of agent availability.
		expect(out).toContain("Workspace: /Users/x/dev/projects/foo   (write lock: free)");
	});

	test("disabled-in-config agent renders its config reason, not the executable-not-found wording", () => {
		const out = renderAgentsReport([readyCodex, disabledClaude], WORKSPACE);
		expect(out).toContain("status:     unavailable — disabled in config (multiHarness.claude.enabled)");
		expect(out).not.toContain("fix:");
		expect(out).toContain("status:     ready"); // codex is unaffected
	});

	test("both agents missing: no throw, both report unavailable, workspace line still renders", () => {
		expect(() => renderAgentsReport([missingCodex, missingClaude], WORKSPACE)).not.toThrow();
		const out = renderAgentsReport([missingCodex, missingClaude], WORKSPACE);

		expect(out).toContain("Codex");
		expect(out).toContain("Claude Code");
		const unavailableCount = (out.match(/unavailable — executable not found/g) ?? []).length;
		expect(unavailableCount).toBe(2);
		expect(out).toContain("fix:        Install the Codex CLI, or set multiHarness.codex.executable to its full path.");
		expect(out).toContain("fix:        Install the Claude Code CLI, or set multiHarness.claude.executable to its full path.");
		expect(out).toContain("Workspace: /Users/x/dev/projects/foo   (write lock: free)");
		expect(out).toContain("Ready: none — see the auth hints above");
	});

	test("logged-out agent is reported as unavailable — not authenticated, never a throw", () => {
		const loggedOut: AgentAvailability = {
			...readyCodex,
			auth: "logged-out",
			authDetail: "not authenticated — run `codex login`",
		};
		expect(() => renderAgentsReport([loggedOut, readyClaude], WORKSPACE)).not.toThrow();
		const out = renderAgentsReport([loggedOut, readyClaude], WORKSPACE);
		expect(out).toContain("status:     unavailable — not authenticated");
		expect(out).toContain("not authenticated — run `codex login`");
	});
});
