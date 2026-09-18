/** `/agents` — availability + auth report, and `/agents auth <codex|claude>`. */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { detect, isReady } from "../agents/availability.ts";
import type { AgentAvailability } from "../agents/types.ts";
import type { AgentName, MultiHarnessConfig } from "../config/schema.ts";
import { isWriteLockHeld, writeLockHolder } from "../runs/lock.ts";
import type { RunRegistry } from "../runs/types.ts";

const DISPLAY: Record<AgentName, string> = { codex: "Codex", claude: "Claude Code" };
const LOGIN: Record<AgentName, string> = { codex: "codex login", claude: "claude auth login" };

/** Exact remediation text from _spec/10 EXECUTABLE_NOT_FOUND — never paraphrase. */
const EXECUTABLE_FIX: Record<AgentName, string> = {
	codex: "Install the Codex CLI, or set multiHarness.codex.executable to its full path.",
	claude: "Install the Claude Code CLI, or set multiHarness.claude.executable to its full path.",
};

/** Workspace/write-lock state as already resolved by the caller — kept pure, no fs/lock reads here. */
export interface WorkspaceStatus {
	cwd: string;
	writeLockHeld: boolean;
	/** Holder label (agent name / run id) — safe to display, never a path or credential. */
	writeLockHolder?: string;
}

/** Aggregate run counts from the registry, if one was supplied. */
export interface RunCounts {
	running: number;
	finished: number;
}

function isExecutableMissing(a: AgentAvailability): boolean {
	return !a.available && !!a.reason && a.reason.includes("not found on PATH");
}

function statusWord(a: AgentAvailability): string {
	if (isExecutableMissing(a)) return "unavailable — executable not found";
	if (!a.available) return `unavailable — ${a.reason ?? "unknown reason"}`;
	if (a.auth === "logged-out") return "unavailable — not authenticated";
	if (a.auth === "unknown") return "installed, auth not checked";
	return "ready";
}

/**
 * Pure renderer for `/agents` — no process spawning, no UI calls. Takes already-resolved
 * availability plus workspace/run state so it is directly unit-testable (_spec/07 `/agents`,
 * _spec/12 criterion B: must degrade gracefully, never throw, when an agent is missing).
 */
export function renderAgentsReport(items: AgentAvailability[], workspace: WorkspaceStatus, runs?: RunCounts): string {
	const lines: string[] = [];
	for (const a of items) {
		lines.push(DISPLAY[a.agent]);
		lines.push(`  executable: ${a.executablePath ?? "not found"}`);
		lines.push(`  version:    ${a.version ?? "-"}`);
		lines.push(`  auth:       ${a.authDetail}`);
		lines.push(`  status:     ${statusWord(a)}`);
		if (isExecutableMissing(a)) lines.push(`  fix:        ${EXECUTABLE_FIX[a.agent]}`);
		lines.push("");
	}

	const lockState = workspace.writeLockHeld
		? `held by ${workspace.writeLockHolder ?? "unknown"}`
		: "free";
	lines.push(`Workspace: ${workspace.cwd}   (write lock: ${lockState})`);
	// Omit the Runs line entirely when we don't have a registry to ask — printing "0 running"
	// would claim knowledge we don't have.
	if (runs) lines.push(`Runs: ${runs.running} running, ${runs.finished} finished`);

	const ready = items.filter(isReady).map((a) => DISPLAY[a.agent]);
	lines.push(ready.length > 0 ? `Ready: ${ready.join(", ")}` : "Ready: none — see the auth hints above");
	return lines.join("\n");
}

function renderAuth(items: AgentAvailability[]): string {
	const lines: string[] = [];
	for (const a of items) {
		lines.push(`${DISPLAY[a.agent].padEnd(12)} ${a.authDetail}`);
	}
	const loggedOut = items.filter((a) => a.available && a.auth !== "ok");
	if (loggedOut.length > 0) {
		lines.push("");
		lines.push("Run these yourself — this extension never logs in on your behalf:");
		for (const a of loggedOut) lines.push(`  ${LOGIN[a.agent]}`);
	}
	lines.push("");
	lines.push("Each CLI keeps its own login; OMP's credentials are never shared with them.");
	return lines.join("\n");
}

function runCounts(registry: RunRegistry): RunCounts {
	const all = registry.list();
	let running = 0;
	let finished = 0;
	for (const r of all) {
		if (r.status === "running" || r.status === "queued") running++;
		else finished++;
	}
	return { running, finished };
}

/**
 * `getRegistry` is OPTIONAL and defaults to absent so the existing two-argument call site in
 * `src/index.ts` (`registerAgentsCommand(pi, getConfig)`) keeps working unchanged. Passing a
 * third argument turns on the `Runs:` line in the report.
 */
export function registerAgentsCommand(
	pi: ExtensionAPI,
	getConfig: () => MultiHarnessConfig,
	getRegistry?: () => RunRegistry,
): void {
	pi.registerCommand("agents", {
		description: "Show Codex / Claude Code availability and authentication",
		getArgumentCompletions: (prefix: string) =>
			["auth", "auth codex", "auth claude"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v })),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = getConfig();
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const authOnly = argv[0] === "auth";
			const wanted = argv[1] as AgentName | undefined;

			const names: AgentName[] = wanted === "codex" || wanted === "claude" ? [wanted] : ["codex", "claude"];
			const items = await Promise.all(names.map((n) => detect(n, config[n], { cwd: ctx.cwd, force: true })));

			if (authOnly) {
				ctx.ui.notify(renderAuth(items), "info");
				return;
			}

			const workspace: WorkspaceStatus = {
				cwd: ctx.cwd,
				writeLockHeld: isWriteLockHeld(ctx.cwd),
				writeLockHolder: writeLockHolder(ctx.cwd),
			};
			const runs = getRegistry ? runCounts(getRegistry()) : undefined;
			ctx.ui.notify(renderAgentsReport(items, workspace, runs), "info");
		},
	});
}
