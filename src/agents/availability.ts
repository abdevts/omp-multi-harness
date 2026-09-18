/**
 * Executable + authentication detection, cached per process.
 *
 * Auth state comes ONLY from each CLI's own status command. No credential file is read, no
 * token is printed, and nothing here ever attempts a login (_spec/10, _spec/14).
 */
import { spawnAgent } from "../process/spawn-agent.ts";
import { resolveExecutable } from "../process/executable.ts";
import type { AgentConfig, AgentName } from "../config/schema.ts";
import type { AgentAvailability, AuthState } from "./types.ts";

const VERSION_TIMEOUT_MS = 5_000;
const AUTH_TIMEOUT_MS = 20_000;

const cache = new Map<AgentName, AgentAvailability>();

async function capture(executable: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv) {
	try {
		const r = await spawnAgent({ command: executable, args, cwd, timeoutMs, killGraceMs: 1_000, env });
		return { ok: r.exitCode === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
	} catch {
		return { ok: false, stdout: "", stderr: "" };
	}
}

async function codexAuth(executable: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<{ auth: AuthState; authDetail: string }> {
	const r = await capture(executable, ["login", "status"], cwd, AUTH_TIMEOUT_MS, env);
	// `codex login status` prints to STDERR, not stdout — read both (_spec/14).
	const line = [r.stdout, r.stderr].join("\n").split("\n").find((l) => /logged in/i.test(l));
	if (r.ok && line) return { auth: "ok", authDetail: line.trim() };
	return { auth: "logged-out", authDetail: "not authenticated — run `codex login`" };
}

async function claudeAuth(executable: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<{ auth: AuthState; authDetail: string }> {
	const r = await capture(executable, ["auth", "status", "--json"], cwd, AUTH_TIMEOUT_MS, env);
	if (r.ok && r.stdout) {
		try {
			// The payload also carries email, org id and org name. Read only these two fields
			// and never print or persist the rest.
			const parsed = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
			if (parsed.loggedIn) return { auth: "ok", authDetail: `logged in via ${parsed.authMethod ?? "unknown method"}` };
			return { auth: "logged-out", authDetail: "not authenticated — run `claude auth login`" };
		} catch {
			return { auth: "unknown", authDetail: "unexpected `claude auth status` output" };
		}
	}
	return { auth: "logged-out", authDetail: "not authenticated — run `claude auth login`" };
}

export interface DetectOptions {
	cwd: string;
	/** Skip the auth probe (it costs a process spawn each). */
	skipAuth?: boolean;
	force?: boolean;
	env?: NodeJS.ProcessEnv;
}

export async function detect(agent: AgentName, config: AgentConfig, opts: DetectOptions): Promise<AgentAvailability> {
	if (!opts.force) {
		const hit = cache.get(agent);
		if (hit) return hit;
	}

	let result: AgentAvailability;

	if (!config.enabled) {
		result = { agent, available: false, auth: "unknown", authDetail: "-", reason: `disabled in config (multiHarness.${agent}.enabled)` };
	} else {
		const executablePath = resolveExecutable(config.executable, opts.env);
		if (!executablePath) {
			result = {
				agent,
				available: false,
				auth: "unknown",
				authDetail: "-",
				reason: `\`${config.executable}\` not found on PATH`,
			};
		} else {
			const version = await capture(executablePath, ["--version"], opts.cwd, VERSION_TIMEOUT_MS, opts.env);
			const auth = opts.skipAuth
				? { auth: "unknown" as AuthState, authDetail: "not checked" }
				: agent === "codex"
					? await codexAuth(executablePath, opts.cwd, opts.env)
					: await claudeAuth(executablePath, opts.cwd, opts.env);
			result = {
				agent,
				available: true,
				executablePath,
				version: [version.stdout, version.stderr].find((s) => s.length > 0) ?? undefined,
				...auth,
			};
		}
	}

	cache.set(agent, result);
	return result;
}

/** Ready = installed, enabled, and authenticated. */
export function isReady(a: AgentAvailability): boolean {
	return a.available && a.auth === "ok";
}

export function clearAvailabilityCache(): void {
	cache.clear();
}
