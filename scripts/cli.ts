#!/usr/bin/env bun
/**
 * `omp-multi-harness` CLI — registers this package with OMP.
 *
 * Installing from npm puts the package in node_modules, which OMP does **not** scan. OMP
 * discovers extensions from its agent dir (`<agentDir>/extensions/`) and from a project's
 * `.omp/extensions/`, resolving each directory through its `package.json` `omp.extensions`
 * manifest. So the install step is a symlink from one of those directories to this package.
 *
 * Symlinks only — this never edits your OMP config, never logs in, and never installs a CLI.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINK_NAME = "multi-harness";

/** This package's root — the directory containing its package.json. */
function packageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The active OMP agent dir, resolved the same way OMP resolves it: `PI_CODING_AGENT_DIR`
 * wins, then `--profile <name>`, then the default. Never hard-coded to `~/.omp/agent`.
 */
function agentDir(profile?: string): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv) return resolve(fromEnv);
	if (profile) return join(homedir(), ".omp", "profiles", profile, "agent");
	return join(homedir(), ".omp", "agent");
}

function targetDir(scope: "global" | "project", profile?: string, cwd = process.cwd()): string {
	return scope === "global" ? join(agentDir(profile), "extensions") : join(resolve(cwd), ".omp", "extensions");
}

/** Where this package is (or would be) linked from. */
function linkPath(scope: "global" | "project", profile?: string): string {
	return join(targetDir(scope, profile), LINK_NAME);
}

function describeExisting(path: string): { kind: "absent" | "symlink" | "other"; target?: string } {
	if (!existsSync(path) && !isDanglingSymlink(path)) return { kind: "absent" };
	try {
		if (lstatSync(path).isSymbolicLink()) return { kind: "symlink", target: readlinkSync(path) };
	} catch {
		// fall through — treat an unreadable entry as "other" so we never clobber it
	}
	return { kind: "other" };
}

/** `existsSync` follows symlinks, so a broken link reads as absent without this. */
function isDanglingSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function link(scope: "global" | "project", profile?: string): number {
	const root = packageRoot();
	const dir = targetDir(scope, profile);
	const dest = linkPath(scope, profile);
	const existing = describeExisting(dest);

	if (existing.kind === "other") {
		console.error(`Refusing to replace ${dest} — it exists and is not a symlink.`);
		console.error("Move it aside yourself, then re-run. This tool only ever manages its own symlink.");
		return 1;
	}
	if (existing.kind === "symlink" && resolve(dirname(dest), existing.target ?? "") === root) {
		console.log(`Already linked: ${dest} -> ${root}`);
		return 0;
	}

	mkdirSync(dir, { recursive: true });
	if (existing.kind === "symlink") rmSync(dest);
	symlinkSync(root, dest, "dir");

	console.log(`Linked: ${dest} -> ${root}`);
	console.log("Start `omp` and run /agents to confirm it loaded.");
	return 0;
}

function unlink(scope: "global" | "project", profile?: string): number {
	const dest = linkPath(scope, profile);
	const existing = describeExisting(dest);

	if (existing.kind === "absent") {
		console.log(`Nothing to remove at ${dest}.`);
		return 0;
	}
	if (existing.kind === "other") {
		console.error(`Refusing to remove ${dest} — it is not a symlink.`);
		return 1;
	}
	rmSync(dest);
	console.log(`Unlinked: ${dest}`);
	return 0;
}

function status(profile?: string): number {
	for (const scope of ["global", "project"] as const) {
		const dest = linkPath(scope, profile);
		const existing = describeExisting(dest);
		const state =
			existing.kind === "absent"
				? "not linked"
				: existing.kind === "other"
					? "occupied by a non-symlink"
					: `-> ${existing.target}`;
		console.log(`${scope.padEnd(8)} ${dest}\n         ${state}`);
	}
	return 0;
}

const USAGE = `omp-multi-harness — register this OMP extension

Usage:
  omp-multi-harness link     [--project] [--profile <name>]   symlink into OMP's extensions dir
  omp-multi-harness unlink   [--project] [--profile <name>]   remove that symlink
  omp-multi-harness status   [--profile <name>]               show where it is linked
  omp-multi-harness doctor                                    run the full setup check

--project links into ./.omp/extensions (this repo only) instead of the agent dir.
--profile <name> targets ~/.omp/profiles/<name>/agent. PI_CODING_AGENT_DIR overrides both.`;

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const scope: "global" | "project" = args.includes("--project") ? "project" : "global";
const profileIndex = args.indexOf("--profile");
const profile = profileIndex >= 0 ? args[profileIndex + 1] : undefined;

if (profileIndex >= 0 && !profile) {
	console.error("--profile needs a name");
	process.exit(1);
}

switch (command) {
	case "link":
		process.exit(link(scope, profile));
		break;
	case "unlink":
		process.exit(unlink(scope, profile));
		break;
	case "status":
		process.exit(status(profile));
		break;
	case "doctor": {
		// setup.ts runs its checks on import via its own entrypoint, and does not export a
		// callable main — so spawn it rather than pretending it has an API it does not.
		const proc = Bun.spawn(["bun", join(packageRoot(), "scripts", "setup.ts"), "check"], {
			stdio: ["inherit", "inherit", "inherit"],
		});
		process.exit(await proc.exited);
		break;
	}
	default:
		console.log(USAGE);
		process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
}
