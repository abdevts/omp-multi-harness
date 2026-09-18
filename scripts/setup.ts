#!/usr/bin/env bun
/**
 * omp-multi-harness setup doctor.
 *
 *   bun scripts/setup.ts            # same as `check`
 *   bun scripts/setup.ts check      # read-only report of every setup step
 *   bun scripts/setup.ts fix        # apply the safe, automatic fixes (asks first)
 *   bun scripts/setup.ts fix --yes  # ...without asking
 *   bun scripts/setup.ts check --json
 *
 * Rules this script obeys (see _spec/10-errors-and-security.md):
 *   - never reads a credential file, never prints a token, never logs in on the user's behalf
 *   - auth state comes only from each CLI's own status command
 *   - installs and logins are shown as commands; interactive ones are never auto-run
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, appendFileSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

type Status = "ok" | "warn" | "fail" | "skip";

interface Fix {
	/** Shown to the user. */
	description: string;
	/** Exact command the user can copy/paste. */
	command?: string;
	/** Runnable by `fix` without a TTY of its own. */
	auto?: () => void;
	/** Needs a terminal/browser (login flows) — we never run these. */
	interactive?: boolean;
}

interface Step {
	id: string;
	title: string;
	run(): { status: Status; detail: string; fix?: Fix };
}

const REPO = resolve(import.meta.dir, "..");
const IS_MAC = platform() === "darwin";

function sh(cmd: string, args: string[], timeout = 15_000) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout, shell: false });
	return {
		ok: r.status === 0,
		code: r.status,
		out: (r.stdout ?? "").trim(),
		err: (r.stderr ?? "").trim(),
		missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
	};
}

function which(bin: string): string | null {
	const r = sh(IS_MAC || platform() !== "win32" ? "which" : "where", [bin], 5_000);
	return r.ok && r.out ? r.out.split("\n")[0]!.trim() : null;
}

/** Active OMP agent directory. Honors PI_CODING_AGENT_DIR; profiles shift this, so we report what we assumed. */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

const steps: Step[] = [
	{
		id: "bun",
		title: "Bun runtime",
		run() {
			const p = which("bun");
			if (!p) {
				return {
					status: "fail",
					detail: "not found — OMP loads extensions with Bun",
					fix: { description: "Install Bun", command: "curl -fsSL https://bun.sh/install | bash", interactive: true },
				};
			}
			return { status: "ok", detail: `${sh("bun", ["--version"]).out} (${p})` };
		},
	},
	{
		id: "git",
		title: "Git repository",
		run() {
			if (!which("git")) return { status: "fail", detail: "git not found" };
			const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO, encoding: "utf8" }).status === 0;
			if (inRepo) return { status: "ok", detail: "initialized" };
			return {
				status: "warn",
				detail: "not a git repository",
				fix: {
					description: "Initialize the repository",
					command: "git init && git add -A && git commit -m 'Initial commit'",
					auto: () => {
						spawnSync("git", ["init"], { cwd: REPO, stdio: "inherit" });
					},
				},
			};
		},
	},
	{
		id: "deps",
		title: "Project dependencies",
		run() {
			if (existsSync(join(REPO, "node_modules"))) return { status: "ok", detail: "node_modules present" };
			return {
				status: "warn",
				detail: "node_modules missing",
				fix: {
					description: "Install dependencies",
					command: "bun install",
					auto: () => {
						spawnSync("bun", ["install"], { cwd: REPO, stdio: "inherit" });
					},
				},
			};
		},
	},
	{
		id: "omp",
		title: "OMP CLI",
		run() {
			const p = which("omp");
			if (!p) {
				return {
					status: "fail",
					detail: "not found",
					fix: { description: "Install OMP", command: "bun add -g @oh-my-pi/pi-coding-agent", interactive: true },
				};
			}
			// `bun run` prepends node_modules/.bin, so a devDependency copy can shadow the
			// user's global omp. Both are the host, but say which one we measured.
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
			if (!existsSync(dir)) {
				return {
					status: "warn",
					detail: `${dir} does not exist — OMP creates it on first run`,
					fix: { description: "Run OMP once so it initializes its agent directory", command: "omp", interactive: true },
				};
			}
			return { status: "ok", detail: dir };
		},
	},
	{
		id: "omp-auth",
		title: "OMP provider auth (supervisor model)",
		run() {
			if (!which("omp")) return { status: "skip", detail: "omp not installed" };
			const r = sh("omp", ["models", "ls", "--json"], 30_000);
			if (!r.ok) return { status: "warn", detail: `could not query models: ${r.err.slice(0, 120)}` };
			let count = 0;
			try {
				count = (JSON.parse(r.out) as { models?: unknown[] }).models?.length ?? 0;
			} catch {
				return { status: "warn", detail: "unexpected `omp models` output" };
			}
			if (count === 0) {
				return {
					status: "fail",
					detail: "no authenticated models — OMP itself cannot run a supervisor turn",
					fix: {
						description: "Authenticate OMP with your own provider (this is OMP's own login, unrelated to the workers)",
						command: "omp   # then use /login",
						interactive: true,
					},
				};
			}
			return { status: "ok", detail: `${count} model(s) available` };
		},
	},
	{
		id: "codex",
		title: "Codex CLI",
		run() {
			const p = which("codex");
			if (!p) {
				return {
					status: "fail",
					detail: "not found",
					fix: {
						description: "Install the Codex CLI",
						command: IS_MAC ? "brew install --cask codex" : "npm install -g @openai/codex",
						interactive: true,
					},
				};
			}
			return { status: "ok", detail: `${sh("codex", ["--version"]).out} (${p})` };
		},
	},
	{
		id: "codex-auth",
		title: "Codex authentication",
		run() {
			if (!which("codex")) return { status: "skip", detail: "codex not installed" };
			const r = sh("codex", ["login", "status"], 20_000);
			// `codex login status` prints to STDERR, not stdout — check both.
			// Never parse or print credentials; only the CLI's own one-line status.
			const line = [r.out, r.err].join("\n").split("\n").find((l) => /logged in/i.test(l));
			if (r.ok && line) return { status: "ok", detail: line.trim() };
			return {
				status: "fail",
				detail: "not authenticated",
				fix: { description: "Complete Codex's own login flow", command: "codex login", interactive: true },
			};
		},
	},
	{
		id: "claude",
		title: "Claude Code CLI",
		run() {
			const p = which("claude");
			if (!p) {
				return {
					status: "fail",
					detail: "not found",
					fix: {
						description: "Install Claude Code",
						command: "npm install -g @anthropic-ai/claude-code",
						interactive: true,
					},
				};
			}
			return { status: "ok", detail: `${sh("claude", ["--version"]).out} (${p})` };
		},
	},
	{
		id: "claude-auth",
		title: "Claude Code authentication",
		run() {
			if (!which("claude")) return { status: "skip", detail: "claude not installed" };
			const r = sh("claude", ["auth", "status", "--json"], 20_000);
			if (r.ok) {
				try {
					// The payload also carries email/org — deliberately read only these two fields.
					const j = JSON.parse(r.out) as { loggedIn?: boolean; authMethod?: string };
					if (j.loggedIn) return { status: "ok", detail: `logged in via ${j.authMethod ?? "unknown method"}` };
				} catch {
					/* fall through */
				}
			}
			return {
				status: "fail",
				detail: "not authenticated",
				fix: { description: "Complete Claude Code's own login flow", command: "claude auth login", interactive: true },
			};
		},
	},
	{
		id: "router",
		title: "Router model (auto mode)",
		run() {
			if (!which("omp")) return { status: "skip", detail: "omp not installed" };
			const r = sh("omp", ["models", "ls", "--json"], 30_000);
			let ids: string[] = [];
			try {
				ids = ((JSON.parse(r.out) as { models?: { id?: string }[] }).models ?? []).map((m) => m.id ?? "");
			} catch {
				/* handled below */
			}
			if (ids.length === 0) {
				return {
					status: "warn",
					detail: "cannot verify — no authenticated models yet (auto mode falls back to rule-based routing)",
				};
			}
			const preferred = ["claude-haiku", "gpt-5.2-mini", "gemini-2.5-flash", "haiku", "mini", "flash"];
			const hit = ids.find((id) => preferred.some((p) => id.toLowerCase().includes(p)));
			return hit
				? { status: "ok", detail: `${hit} available for routing.model` }
				: { status: "warn", detail: "no small/fast model found — set multiHarness.routing.model explicitly" };
		},
	},
	{
		id: "link",
		title: "Extension linked into OMP",
		run() {
			const dir = agentDir();
			const target = join(dir, "extensions", "multi-harness");
			if (existsSync(target) || (() => { try { return !!lstatSync(target); } catch { return false; } })()) {
				return { status: "ok", detail: target };
			}
			return {
				status: "warn",
				detail: "not linked (fine during development — use `omp -e ./src/index.ts`)",
				fix: {
					description: "Symlink this repo into the OMP extensions directory",
					command: `ln -s "${REPO}" "${target}"`,
					auto: () => {
						mkdirSync(join(dir, "extensions"), { recursive: true });
						symlinkSync(REPO, target, "dir");
					},
				},
			};
		},
	},
	{
		id: "config",
		title: "multiHarness config block",
		run() {
			const cfg = join(agentDir(), "config.yml");
			if (!existsSync(cfg)) {
				return { status: "warn", detail: `${cfg} not found — run OMP once first`, fix: { description: "Run OMP once", command: "omp", interactive: true } };
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
								"# Added by omp-multi-harness setup. See _spec/09-config.md for every option.",
								"multiHarness:",
								"  enabled: true",
								"  codex:",
								"    enabled: true",
								"  claude:",
								"    enabled: true",
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
	{
		id: "editor",
		title: "Editor config",
		run() {
			const missing = [".vscode/settings.json", ".vscode/extensions.json", ".vscode/launch.json", ".vscode/tasks.json", ".editorconfig"].filter(
				(f) => !existsSync(join(REPO, f)),
			);
			return missing.length === 0
				? { status: "ok", detail: ".vscode/* and .editorconfig present" }
				: { status: "warn", detail: `missing: ${missing.join(", ")}` };
		},
	},
];

const GLYPH: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘", skip: "–" };

async function main() {
	const argv = process.argv.slice(2);
	const mode = argv.find((a) => !a.startsWith("--")) ?? "check";
	const yes = argv.includes("--yes") || argv.includes("-y");
	const asJson = argv.includes("--json");

	const results = steps.map((s) => ({ step: s, ...s.run() }));

	if (asJson) {
		console.log(JSON.stringify(results.map((r) => ({ id: r.step.id, status: r.status, detail: r.detail })), null, 2));
		process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
	}

	console.log("\nomp-multi-harness setup\n");
	for (const r of results) {
		console.log(`  ${GLYPH[r.status]} ${r.step.title.padEnd(34)} ${r.detail}`);
	}

	const actionable = results.filter((r) => r.fix && r.status !== "ok" && r.status !== "skip");
	if (actionable.length === 0) {
		console.log("\nEverything is set up.\n");
		return;
	}

	const auto = actionable.filter((r) => r.fix?.auto);
	const manual = actionable.filter((r) => !r.fix?.auto);

	if (mode === "fix" && auto.length > 0) {
		const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
		for (const r of auto) {
			if (rl) {
				const a = (await rl.question(`\n${r.fix!.description}? [y/N] `)).trim().toLowerCase();
				if (a !== "y" && a !== "yes") continue;
			}
			try {
				r.fix!.auto!();
				console.log(`  ${GLYPH.ok} ${r.step.title}: fixed`);
			} catch (e) {
				console.log(`  ${GLYPH.fail} ${r.step.title}: ${(e as Error).message}`);
			}
		}
		rl?.close();
	} else if (auto.length > 0) {
		console.log("\nAutomatic fixes available — run `bun scripts/setup.ts fix`:");
		for (const r of auto) console.log(`  · ${r.fix!.description}`);
	}

	if (manual.length > 0) {
		console.log("\nRun these yourself (installs and logins are never automated):");
		for (const r of manual) {
			console.log(`  · ${r.fix!.description}`);
			if (r.fix!.command) console.log(`      ${r.fix!.command}`);
		}
	}
	console.log();
}

await main();
