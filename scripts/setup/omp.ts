/** OMP host setup: CLI, agent directory, its own provider auth, router model, extension install. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { REPO, type SetupGroup, agentDir, executableStep, sh, which } from "./types.ts";

function models(): string[] | null {
	const r = sh("omp", ["models", "ls", "--json"], 30_000);
	if (!r.ok) return null;
	try {
		return ((JSON.parse(r.out) as { models?: { id?: string }[] }).models ?? []).map((m) => m.id ?? "");
	} catch {
		return null;
	}
}

export const ompSetup: SetupGroup = {
	id: "omp",
	title: "OMP host",
	steps: [
		{
			...executableStep({
				id: "omp-cli",
				title: "OMP CLI",
				bin: "omp",
				install: { description: "Install OMP", command: "bun add -g @oh-my-pi/pi-coding-agent" },
			}),
			// Wrap so we can flag the repo-local copy `bun run` puts on PATH.
			run() {
				const p = which("omp");
				if (!p) {
					return {
						status: "fail",
						detail: "not found",
						fix: { description: "Install OMP", command: "bun add -g @oh-my-pi/pi-coding-agent" },
					};
				}
				const local = p.startsWith(join(REPO, "node_modules"));
				return {
					status: "ok",
					detail: `${sh("omp", ["--version"]).out} (${p})${local ? " — repo-local copy shadowing your global omp" : ""}`,
				};
			},
		},
		{
			id: "omp-dir",
			title: "OMP agent directory",
			run() {
				const dir = agentDir();
				if (existsSync(dir)) return { status: "ok", detail: dir };
				return {
					status: "warn",
					detail: `${dir} does not exist — OMP creates it on first run`,
					fix: { description: "Run OMP once so it initializes its agent directory", command: "omp" },
				};
			},
		},
		{
			id: "omp-auth",
			title: "OMP provider auth (supervisor + router)",
			run() {
				if (!which("omp")) return { status: "skip", detail: "omp not installed" };
				const ids = models();
				if (ids === null) return { status: "warn", detail: "could not query `omp models ls --json`" };
				if (ids.length === 0) {
					return {
						status: "fail",
						detail: "no authenticated models — OMP cannot take a supervisor turn",
						fix: {
							description: "Authenticate OMP with your own provider (separate from the worker logins)",
							command: "omp   # then use /login",
						},
					};
				}
				return { status: "ok", detail: `${ids.length} model(s) available` };
			},
		},
		{
			id: "omp-router",
			title: "Router model (auto mode)",
			run() {
				if (!which("omp")) return { status: "skip", detail: "omp not installed" };
				const ids = models();
				if (!ids || ids.length === 0) {
					return { status: "warn", detail: "cannot verify — OMP has no authenticated models; auto falls back to rules" };
				}
				const preferred = ["claude-haiku", "gpt-5.2-mini", "gemini-2.5-flash", "haiku", "mini", "flash"];
				const hit = ids.find((id) => preferred.some((p) => id.toLowerCase().includes(p)));
				return hit
					? { status: "ok", detail: `${hit} available for routing.model` }
					: { status: "warn", detail: "no small/fast model found — set multiHarness.routing.model explicitly" };
			},
		},
		{
			id: "omp-link",
			title: "Extension linked into OMP",
			run() {
				const target = join(agentDir(), "extensions", "multi-harness");
				const exists = (() => {
					try {
						return !!lstatSync(target);
					} catch {
						return false;
					}
				})();
				if (exists) return { status: "ok", detail: target };
				return {
					status: "warn",
					detail: "not linked (fine during development — use `omp -e ./src/index.ts`)",
					fix: {
						description: "Symlink this repo into the OMP extensions directory",
						command: `ln -s "${REPO}" "${target}"`,
						auto: () => {
							mkdirSync(join(agentDir(), "extensions"), { recursive: true });
							symlinkSync(REPO, target, "dir");
						},
					},
				};
			},
		},
		{
			id: "omp-config",
			title: "multiHarness config block",
			run() {
				const cfg = join(agentDir(), "config.yml");
				if (!existsSync(cfg)) {
					return {
						status: "warn",
						detail: `${cfg} not found — run OMP once first`,
						fix: { description: "Run OMP once so it writes its config", command: "omp" },
					};
				}
				if (/^multiHarness:/m.test(readFileSync(cfg, "utf8"))) return { status: "ok", detail: cfg };
				return {
					status: "warn",
					detail: "no multiHarness block (defaults will be used)",
					fix: {
						description: `Append a commented default multiHarness block to ${cfg}`,
						auto: () => {
							appendFileSync(
								cfg,
								[
									"",
									"# Added by omp-multi-harness setup. Every option: _spec/09-config.md",
									"multiHarness:",
									"  enabled: true",
									"  codex:",
									"    enabled: true",
									"    model: null      # null → your ~/.codex/config.toml decides",
									"  claude:",
									"    enabled: true",
									"    model: null      # null → your Claude Code config decides",
									"  routing:",
									"    mode: model      # model | rules",
									'    model: "@smol"   # router model for agent: "auto"',
									"  concurrency:",
									"    maxConcurrentRuns: 4",
									"  debug: false",
									"",
								].join("\n"),
							);
						},
					},
				};
			},
		},
	],
};
