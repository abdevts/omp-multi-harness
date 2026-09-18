/** Shared plumbing for the per-provider setup modules. */
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export type Status = "ok" | "warn" | "fail" | "skip";

export interface Fix {
	/** Shown to the user. */
	description: string;
	/** Exact command the user can copy/paste. */
	command?: string;
	/** Safe to run unattended (after a prompt). Installs and logins never have one. */
	auto?: () => void;
}

export interface Step {
	id: string;
	title: string;
	run(): { status: Status; detail: string; fix?: Fix };
}

/** One provider's (or one concern's) setup steps. `setup.ts` runs every registered group. */
export interface SetupGroup {
	id: string;
	title: string;
	steps: Step[];
}

export const REPO = resolve(import.meta.dir, "..", "..");
export const IS_MAC = platform() === "darwin";
export const IS_WINDOWS = platform() === "win32";

export function sh(cmd: string, args: string[], timeout = 15_000) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout, shell: false });
	return {
		ok: r.status === 0,
		code: r.status,
		out: (r.stdout ?? "").trim(),
		err: (r.stderr ?? "").trim(),
		missing: (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
	};
}

export function which(bin: string): string | null {
	const r = sh(IS_WINDOWS ? "where" : "which", [bin], 5_000);
	return r.ok && r.out ? (r.out.split("\n")[0]?.trim() ?? null) : null;
}

/**
 * Active OMP agent directory. Honors PI_CODING_AGENT_DIR; `omp --profile <name>` shifts it
 * to ~/.omp/profiles/<name>/agent, so never hard-code this elsewhere.
 */
export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
}

/** A CLI presence check shared by every provider module. */
export function executableStep(opts: {
	id: string;
	title: string;
	bin: string;
	versionArgs?: string[];
	install: { description: string; command: string };
}): Step {
	return {
		id: opts.id,
		title: opts.title,
		run() {
			const p = which(opts.bin);
			if (!p) return { status: "fail", detail: "not found", fix: opts.install };
			const version = sh(opts.bin, opts.versionArgs ?? ["--version"]).out;
			return { status: "ok", detail: `${version} (${p})` };
		},
	};
}
