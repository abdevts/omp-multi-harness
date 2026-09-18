/**
 * omp-multi-harness — Phase 0/1 skeleton.
 *
 * Load phase is REGISTRATION ONLY: calling action methods here throws
 * ExtensionRuntimeNotInitializedError (see _spec/01-environment-findings.md §2).
 */
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

type AgentName = "codex" | "claude";

interface AgentStatus {
	name: AgentName;
	executable: string | null;
	version: string | null;
	auth: "ok" | "logged-out" | "unknown";
	authDetail: string;
}

function run(cmd: string, args: string[], timeout = 15_000) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout, shell: false });
	return {
		ok: r.status === 0,
		out: (r.stdout ?? "").trim(),
		err: (r.stderr ?? "").trim(),
	};
}

function which(bin: string): string | null {
	const r = run("which", [bin], 5_000);
	return r.ok && r.out ? (r.out.split("\n")[0] ?? null) : null;
}

function codexStatus(executable: string): Pick<AgentStatus, "auth" | "authDetail"> {
	// `codex login status` prints to STDERR, not stdout — read both (_spec/14).
	const r = run(executable, ["login", "status"]);
	const line = [r.out, r.err].join("\n").split("\n").find((l) => /logged in/i.test(l));
	if (r.ok && line) return { auth: "ok", authDetail: line.trim() };
	return { auth: "logged-out", authDetail: "not authenticated — run `codex login`" };
}

function claudeStatus(executable: string): Pick<AgentStatus, "auth" | "authDetail"> {
	const r = run(executable, ["auth", "status", "--json"]);
	if (r.ok) {
		try {
			// Payload also carries email/org — read only these two fields (_spec/14).
			const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string };
			if (j.loggedIn) return { auth: "ok", authDetail: `logged in via ${j.authMethod ?? "unknown method"}` };
		} catch {
			return { auth: "unknown", authDetail: "unexpected `claude auth status` output" };
		}
	}
	return { auth: "logged-out", authDetail: "not authenticated — run `claude auth login`" };
}

function inspect(name: AgentName): AgentStatus {
	const executable = which(name);
	if (!executable) {
		return { name, executable: null, version: null, auth: "unknown", authDetail: "executable not found" };
	}
	const version = run(executable, ["--version"]).out || null;
	const auth = name === "codex" ? codexStatus(executable) : claudeStatus(executable);
	return { name, executable, version, ...auth };
}

function render(statuses: AgentStatus[]): string {
	const lines: string[] = [];
	for (const s of statuses) {
		lines.push(s.name === "codex" ? "Codex" : "Claude");
		lines.push(`  executable: ${s.executable ?? "not found"}`);
		lines.push(`  version:    ${s.version ?? "-"}`);
		lines.push(`  auth:       ${s.authDetail}`);
		lines.push(`  status:     ${s.executable && s.auth === "ok" ? "ready" : "unavailable"}`);
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

export default function multiHarness(pi: ExtensionAPI) {
	pi.setLabel("Multi-Harness");

	pi.registerCommand("agents", {
		description: "Show Codex / Claude Code availability and authentication",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = render([inspect("codex"), inspect("claude")]);
			ctx.ui.notify(report, "info");
		},
	});
}
