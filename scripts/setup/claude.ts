/** Claude Code CLI setup: presence + authentication. Mirrors src/agents/claude.ts. */
import { type SetupGroup, executableStep, sh, which } from "./types.ts";

export const claudeSetup: SetupGroup = {
	id: "claude",
	title: "Claude Code",
	steps: [
		executableStep({
			id: "claude-cli",
			title: "Claude Code CLI",
			bin: "claude",
			install: {
				description: "Install Claude Code",
				command: "npm install -g @anthropic-ai/claude-code",
			},
		}),
		{
			id: "claude-auth",
			title: "Claude Code authentication",
			run() {
				if (!which("claude")) return { status: "skip", detail: "claude not installed" };
				const r = sh("claude", ["auth", "status", "--json"], 20_000);
				if (r.ok) {
					try {
						// The payload also carries email, org id and org name — deliberately
						// read only these two fields, and never persist or print the rest.
						const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string };
						if (j.loggedIn) return { status: "ok", detail: `logged in via ${j.authMethod ?? "unknown method"}` };
					} catch {
						return { status: "warn", detail: "unexpected `claude auth status` output" };
					}
				}
				return {
					status: "fail",
					detail: "not authenticated",
					fix: { description: "Complete Claude Code's own login flow", command: "claude auth login" },
				};
			},
		},
	],
};
