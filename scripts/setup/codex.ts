/** Codex CLI setup: presence + authentication. Mirrors src/agents/codex.ts. */
import { IS_MAC, type SetupGroup, executableStep, sh, which } from "./types.ts";

export const codexSetup: SetupGroup = {
	id: "codex",
	title: "Codex",
	steps: [
		executableStep({
			id: "codex-cli",
			title: "Codex CLI",
			bin: "codex",
			install: {
				description: "Install the Codex CLI",
				command: IS_MAC ? "brew install --cask codex" : "npm install -g @openai/codex",
			},
		}),
		{
			id: "codex-auth",
			title: "Codex authentication",
			run() {
				if (!which("codex")) return { status: "skip", detail: "codex not installed" };
				const r = sh("codex", ["login", "status"], 20_000);
				// `codex login status` prints to STDERR, not stdout — read both (_spec/14).
				// Only the CLI's own status line is read; no credential file is ever touched.
				const line = [r.out, r.err].join("\n").split("\n").find((l) => /logged in/i.test(l));
				if (r.ok && line) return { status: "ok", detail: line.trim() };
				return {
					status: "fail",
					detail: "not authenticated",
					fix: { description: "Complete Codex's own login flow", command: "codex login" },
				};
			},
		},
	],
};
