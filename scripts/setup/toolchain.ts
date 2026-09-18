/** Toolchain and repository hygiene — everything that is not provider-specific. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO, type SetupGroup, sh, which } from "./types.ts";

export const toolchainSetup: SetupGroup = {
	id: "toolchain",
	title: "Toolchain",
	steps: [
		{
			id: "bun",
			title: "Bun runtime",
			run() {
				const p = which("bun");
				if (!p) {
					return {
						status: "fail",
						detail: "not found — OMP loads extensions with Bun",
						fix: { description: "Install Bun", command: "curl -fsSL https://bun.sh/install | bash" },
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
						command: "git init",
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
			id: "editor",
			title: "Editor config",
			run() {
				const missing = [
					".vscode/settings.json",
					".vscode/extensions.json",
					".vscode/launch.json",
					".vscode/tasks.json",
					".editorconfig",
				].filter((f) => !existsSync(join(REPO, f)));
				return missing.length === 0
					? { status: "ok", detail: ".vscode/* and .editorconfig present" }
					: { status: "warn", detail: `missing: ${missing.join(", ")}` };
			},
		},
	],
};
