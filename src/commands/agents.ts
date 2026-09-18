/** `/agents` — availability + auth report, and `/agents auth <codex|claude>`. */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { detect, isReady } from "../agents/availability.ts";
import type { AgentAvailability } from "../agents/types.ts";
import type { AgentName, MultiHarnessConfig } from "../config/schema.ts";

const DISPLAY: Record<AgentName, string> = { codex: "Codex", claude: "Claude Code" };
const LOGIN: Record<AgentName, string> = { codex: "codex login", claude: "claude auth login" };

function statusWord(a: AgentAvailability): string {
	if (!a.available) return `unavailable — ${a.reason ?? "unknown reason"}`;
	if (a.auth === "logged-out") return "installed, not authenticated";
	if (a.auth === "unknown") return "installed, auth not checked";
	return "ready";
}

export function renderReport(items: AgentAvailability[], cwd: string): string {
	const lines: string[] = [];
	for (const a of items) {
		lines.push(DISPLAY[a.agent]);
		lines.push(`  executable: ${a.executablePath ?? "not found"}`);
		lines.push(`  version:    ${a.version ?? "-"}`);
		lines.push(`  auth:       ${a.authDetail}`);
		lines.push(`  status:     ${statusWord(a)}`);
		lines.push("");
	}
	lines.push(`Workspace: ${cwd}`);
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

export function registerAgentsCommand(pi: ExtensionAPI, getConfig: () => MultiHarnessConfig): void {
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

			ctx.ui.notify(authOnly ? renderAuth(items) : renderReport(items, ctx.cwd), "info");
		},
	});
}
