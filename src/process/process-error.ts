/** Typed, actionable errors. Every message names the fix. See _spec/10-errors-and-security.md. */
import type { AgentName } from "../config/schema.ts";
import { redactTail } from "./redact.ts";

export type AgentErrorCode =
	| "EXECUTABLE_NOT_FOUND"
	| "AUTH_REQUIRED"
	| "PROCESS_FAILED"
	| "TIMEOUT"
	| "CANCELLED"
	| "INVALID_OUTPUT"
	| "SESSION_RESUME_FAILED"
	| "WORKSPACE_BUSY"
	| "AGENT_DISABLED"
	| "INVALID_CWD"
	| "PROVIDER_LIMIT";

export interface AgentErrorInit {
	code: AgentErrorCode;
	agent: AgentName;
	message: string;
	exitCode?: number | null;
	stderrTail?: string;
	cause?: unknown;
}

export class AgentError extends Error {
	readonly code: AgentErrorCode;
	readonly agent: AgentName;
	readonly exitCode: number | null | undefined;
	readonly stderrTail: string | undefined;

	constructor(init: AgentErrorInit) {
		super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
		this.name = "AgentError";
		this.code = init.code;
		this.agent = init.agent;
		this.exitCode = init.exitCode;
		this.stderrTail = init.stderrTail;
	}
}

const LOGIN_COMMAND: Record<AgentName, string> = {
	codex: "codex login",
	claude: "claude auth login",
};

const INSTALL_HINT: Record<AgentName, string> = {
	codex: "Install the Codex CLI, or set multiHarness.codex.executable to its full path.",
	claude: "Install Claude Code, or set multiHarness.claude.executable to its full path.",
};

const DISPLAY: Record<AgentName, string> = { codex: "Codex", claude: "Claude Code" };

/** Stderr signatures that mean "the user needs to log in", not "the task failed". */
const AUTH_PATTERNS = [
	/not logged in/i,
	/please (run )?`?(codex )?login/i,
	/authentication (required|failed)/i,
	/unauthorized/i,
	/invalid[_ ]api[_ ]key/i,
	/no credentials found/i,
	/session expired/i,
	/oauth token (expired|invalid)/i,
];

export function looksLikeAuthFailure(stderr: string): boolean {
	return AUTH_PATTERNS.some((p) => p.test(stderr));
}

export function executableNotFound(agent: AgentName, executable: string): AgentError {
	return new AgentError({
		code: "EXECUTABLE_NOT_FOUND",
		agent,
		message: `\`${executable}\` was not found on PATH. ${INSTALL_HINT[agent]}`,
	});
}

export function authRequired(agent: AgentName, stderrTail?: string): AgentError {
	// Redact before it ever touches `.message` or `.stderrTail` — both are user/log visible.
	const tail = stderrTail === undefined ? undefined : redactTail(stderrTail);
	return new AgentError({
		code: "AUTH_REQUIRED",
		agent,
		message:
			`${DISPLAY[agent]} is installed but not authenticated. ` +
			`Run \`${LOGIN_COMMAND[agent]}\` in a terminal and complete its normal login flow, then retry. ` +
			`This extension never logs in on your behalf.`,
		stderrTail: tail,
	});
}

export function processFailed(agent: AgentName, exitCode: number | null, stderrTail?: string): AgentError {
	const tail = stderrTail === undefined ? undefined : redactTail(stderrTail);
	return new AgentError({
		code: "PROCESS_FAILED",
		agent,
		message: `${DISPLAY[agent]} exited with code ${exitCode ?? "null"}.${tail ? ` Last output: ${tail}` : ""}`,
		exitCode,
		stderrTail: tail,
	});
}

export function timedOut(agent: AgentName, timeoutMs: number): AgentError {
	return new AgentError({
		code: "TIMEOUT",
		agent,
		message:
			`${DISPLAY[agent]} did not finish within ${Math.round(timeoutMs / 1000)}s and was terminated. ` +
			`Raise multiHarness.${agent}.timeoutMs or narrow the task.`,
	});
}

export function cancelled(agent: AgentName): AgentError {
	return new AgentError({ code: "CANCELLED", agent, message: `${DISPLAY[agent]} run was cancelled.` });
}

export function invalidOutput(agent: AgentName, detail: string): AgentError {
	return new AgentError({
		code: "INVALID_OUTPUT",
		agent,
		// `detail` often quotes a raw output fragment — redact it like any other CLI-derived text.
		message: `Could not read a final answer from ${DISPLAY[agent]}: ${redactTail(detail)}`,
	});
}

/**
 * The provider refused on quota/credits/billing. Distinct from PROCESS_FAILED because
 * retrying cannot help — observed on codex-cli 0.155.0 as
 * "Your workspace is out of credits."
 */
export function providerLimit(agent: AgentName, detail: string): AgentError {
	// `detail` is lifted straight from the CLI's failure message (spec 10) — redact it too.
	return new AgentError({
		code: "PROVIDER_LIMIT",
		agent,
		message:
			`${DISPLAY[agent]} refused the request: ${redactTail(detail)} ` +
			`This is a provider account limit, not a problem with the task — retrying will not help. ` +
			`Top up or switch accounts in ${agent === "codex" ? "your OpenAI/ChatGPT" : "your Anthropic"} plan, then retry.`,
	});
}

export function agentDisabled(agent: AgentName): AgentError {
	return new AgentError({
		code: "AGENT_DISABLED",
		agent,
		message: `${DISPLAY[agent]} is disabled in config. Set multiHarness.${agent}.enabled: true to use it.`,
	});
}

export function invalidCwd(agent: AgentName, cwd: string, reason: string): AgentError {
	return new AgentError({ code: "INVALID_CWD", agent, message: `Cannot run ${DISPLAY[agent]} in ${cwd}: ${reason}` });
}

export function workspaceBusy(agent: AgentName, holder: string): AgentError {
	return new AgentError({
		code: "WORKSPACE_BUSY",
		agent,
		message:
			`Another write-capable agent (${holder}) is working in this repository. ` +
			`Wait for it, run this read-only, or cancel it with /sessions.`,
	});
}

/** Map a spawn-level failure onto a typed error. */
export function fromSpawnError(agent: AgentName, executable: string, err: NodeJS.ErrnoException): AgentError {
	if (err.code === "ENOENT") return executableNotFound(agent, executable);
	if (err.code === "EACCES") {
		return new AgentError({
			code: "EXECUTABLE_NOT_FOUND",
			agent,
			message: `\`${executable}\` is not executable (EACCES). Check its permissions.`,
			cause: err,
		});
	}
	return new AgentError({ code: "PROCESS_FAILED", agent, message: `Failed to start ${executable}: ${redactTail(err.message)}`, cause: err });
}
