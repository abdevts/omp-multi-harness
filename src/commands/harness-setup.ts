/** `/harness-setup` — the setup checklist from _spec/14, rendered inside a session. */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../agents/availability.ts";
import { agentDir, configPaths } from "../config/load.ts";
import type { MultiHarnessConfig } from "../config/schema.ts";

type Row = { ok: boolean | null; label: string; detail: string; fix?: string };

function render(rows: Row[]): string {
	const glyph = (ok: boolean | null) => (ok === null ? "!" : ok ? "✔" : "✘");
	const body = rows.map((r) => `  ${glyph(r.ok)} ${r.label.padEnd(30)} ${r.detail}`);
	const fixes = rows.filter((r) => r.ok !== true && r.fix);
	if (fixes.length > 0) {
		body.push("");
		body.push("Fixes:");
		for (const r of fixes) body.push(`  · ${r.fix}`);
	}
	body.push("");
	body.push("Full checklist outside a session: `bun run doctor`");
	return body.join("\n");
}

export function registerHarnessSetupCommand(
	pi: ExtensionAPI,
	getConfig: () => MultiHarnessConfig,
	getSources: () => string[],
): void {
	pi.registerCommand("harness-setup", {
		description: "Check multi-harness setup: CLIs, authentication, config, install",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const config = getConfig();
			const [codex, claude] = await Promise.all([
				detect("codex", config.codex, { cwd: ctx.cwd, force: true }),
				detect("claude", config.claude, { cwd: ctx.cwd, force: true }),
			]);

			const link = join(agentDir(), "extensions", "multi-harness");
			const sources = getSources();
			const { user } = configPaths(ctx.cwd);
			const models = ctx.models.list().length;

			const rows: Row[] = [
				{
					ok: models > 0,
					label: "OMP provider auth",
					detail: models > 0 ? `${models} model(s) available` : "no authenticated models",
					fix: models > 0 ? undefined : "run `omp` and use /login (OMP's own login, never shared with the workers)",
				},
				{
					ok: config.routing.mode === "rules" ? true : models > 0,
					label: "Router model (auto)",
					detail:
						config.routing.mode === "rules"
							? "rules mode — no router model needed"
							: models > 0
								? `${config.routing.model} (falls back to rules on failure)`
								: "unavailable — auto routing falls back to rules",
				},
				{
					ok: codex.available && codex.auth === "ok",
					label: "Codex",
					detail: codex.available ? `${codex.version ?? "?"} · ${codex.authDetail}` : (codex.reason ?? "unavailable"),
					fix: codex.available && codex.auth !== "ok" ? "codex login" : codex.available ? undefined : "install the Codex CLI",
				},
				{
					ok: claude.available && claude.auth === "ok",
					label: "Claude Code",
					detail: claude.available ? `${claude.version ?? "?"} · ${claude.authDetail}` : (claude.reason ?? "unavailable"),
					fix:
						claude.available && claude.auth !== "ok"
							? "claude auth login"
							: claude.available
								? undefined
								: "install Claude Code",
				},
				{
					ok: sources.length > 0 ? true : null,
					label: "Config",
					detail: sources.length > 0 ? sources.join(", ") : `no config file — defaults in use (${user})`,
				},
				{
					ok: existsSync(link) ? true : null,
					label: "Installed into OMP",
					detail: existsSync(link) ? link : "not linked — running from -e or a project path",
					fix: existsSync(link) ? undefined : `ln -s <repo> "${link}"`,
				},
			];

			ctx.ui.notify(render(rows), "info");
		},
	});
}
