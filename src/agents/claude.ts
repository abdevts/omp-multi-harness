/**
 * Claude Code adapter. Every Claude flag in this project lives in this file.
 * Verified against Claude Code 2.1.274 (_spec/04-claude-adapter.md).
 */
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "../config/schema.ts";
import { JsonlReader } from "../process/jsonl.ts";
import {
	AgentError,
	authRequired,
	cancelled,
	invalidCwd,
	invalidOutput,
	looksLikeAuthFailure,
	processFailed,
	providerLimit,
	timedOut,
} from "../process/process-error.ts";
import { resolveExecutable } from "../process/executable.ts";
import { SpawnCwdError, spawnAgent } from "../process/spawn-agent.ts";
import { detect } from "./availability.ts";
import { isQuotaFailure } from "./codex-events.ts";
import { applyClaudeEvent, newClaudeStreamState } from "./claude-events.ts";
import { MODE_DEFAULT_READ_ONLY, type AgentRequest, type AgentResult, type AgentRunOptions, type ExternalAgent } from "./types.ts";

/** Tools a read-only run may use. Anything that writes is simply absent. */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

export interface ClaudeCapabilities {
	supportsStreamJson: boolean;
	requiresVerboseWithStreamJson: boolean;
	supportsSessionId: boolean;
	supportsPermissionMode: boolean;
}

/** Unknown or newer versions get the newest known capability set. */
export function claudeCapabilities(_version: string | undefined): ClaudeCapabilities {
	return {
		supportsStreamJson: true,
		// Verified on 2.1.274: stream-json under -p needs --verbose.
		requiresVerboseWithStreamJson: true,
		supportsSessionId: true,
		supportsPermissionMode: true,
	};
}

export interface BuildClaudeArgsInput {
	request: AgentRequest;
	config: AgentConfig;
	capabilities: ClaudeCapabilities;
	readOnly: boolean;
	/** Caller-generated UUID used for a new session. */
	sessionId: string;
	/** Branch instead of continuing when resuming. */
	fork?: boolean;
}

/**
 * Build argv for `claude -p`. Two things are deliberately absent:
 * the prompt (stdin) and the working directory (Claude Code has no -C; the spawn cwd
 * carries it).
 */
export function buildClaudeArgs(input: BuildClaudeArgsInput): string[] {
	const { request, config, capabilities, readOnly, sessionId, fork } = input;
	const args: string[] = ["-p"];

	if (capabilities.supportsStreamJson) {
		args.push("--output-format", "stream-json");
		if (capabilities.requiresVerboseWithStreamJson) args.push("--verbose");
	} else {
		args.push("--output-format", "json");
	}

	if (request.sessionId) {
		args.push("--resume", request.sessionId);
		if (fork) args.push("--fork-session");
	} else if (capabilities.supportsSessionId) {
		// Generating the id ourselves makes the OMP↔worker mapping known before the process
		// starts, and survives a crash mid-run.
		args.push("--session-id", sessionId);
	}

	if (readOnly && capabilities.supportsPermissionMode) {
		args.push("--permission-mode", "plan");
		args.push("--tools", READ_ONLY_TOOLS.join(","));
	} else if (!readOnly && config.acceptEdits && capabilities.supportsPermissionMode) {
		args.push("--permission-mode", "acceptEdits");
	}
	// else: readOnly was requested but this capability set cannot enforce it — no flag is
	// emitted, and claudeReadOnlyEnforcement() below will honestly report `false` for it.

	const model = request.model ?? config.model;
	if (model) args.push("--model", model);

	for (const dir of config.additionalDirs) args.push("--add-dir", dir);

	return args;
}

/**
 * Honest read-only enforcement (T-602): derived from the argv we actually built, never
 * from what was merely requested. `--permission-mode plan` plus a read-only `--tools`
 * allowlist is real enforcement — Claude cannot invoke a tool outside the allowlist,
 * confirmed via `claude --help` (both flags exist exactly as spelled here on 2.1.277). If
 * `capabilities.supportsPermissionMode` was false, neither flag was emitted and this
 * correctly reports `false`.
 */
export function claudeReadOnlyEnforcement(args: string[], readOnly: boolean): { enforced: boolean; mechanism?: string } {
	if (!readOnly) return { enforced: false };
	const modeIdx = args.indexOf("--permission-mode");
	const hasPlanMode = modeIdx !== -1 && args[modeIdx + 1] === "plan";
	const hasToolsAllowlist = args.includes("--tools");
	const enforced = hasPlanMode && hasToolsAllowlist;
	return enforced ? { enforced: true, mechanism: `--permission-mode plan --tools ${READ_ONLY_TOOLS.join(",")}` } : { enforced: false };
}

export class ClaudeAgent implements ExternalAgent {
	readonly name = "claude" as const;

	constructor(private readonly config: AgentConfig) {}

	async isAvailable(force = false) {
		return detect("claude", this.config, { cwd: process.cwd(), force });
	}

	async run(request: AgentRequest, options: AgentRunOptions): Promise<AgentResult> {
		const started = Date.now();
		const executable = resolveExecutable(this.config.executable);
		if (!executable) {
			throw new AgentError({
				code: "EXECUTABLE_NOT_FOUND",
				agent: "claude",
				message: `\`${this.config.executable}\` was not found on PATH. Install Claude Code, or set multiHarness.claude.executable to its full path.`,
			});
		}

		const availability = await detect("claude", this.config, { cwd: request.cwd });
		const capabilities = claudeCapabilities(availability.version);

		const readOnly = request.readOnly ?? (request.mode ? MODE_DEFAULT_READ_ONLY[request.mode] : false);
		const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
		const sessionId = randomUUID();

		const args = buildClaudeArgs({ request, config: this.config, capabilities, readOnly, sessionId, fork: request.fork });

		const state = newClaudeStreamState();
		const reader = new JsonlReader((value) => {
			if (value === undefined) return;
			const progress = applyClaudeEvent(state, value);
			if (progress) options.onProgress?.(progress);
		});

		try {
			options.onProgress?.({ phase: "starting" });

			const result = await spawnAgent({
				command: executable,
				args,
				cwd: request.cwd,
				stdin: request.context ? `${request.context}\n\n${request.task}` : request.task,
				timeoutMs,
				signal: options.signal,
				onStdout: (chunk) => reader.push(chunk),
			});
			reader.end();

			if (result.cancelled) throw cancelled("claude");
			if (result.timedOut) throw timedOut("claude", timeoutMs);

			const failure = state.failure;
			if (failure) {
				if (isQuotaFailure(failure)) throw providerLimit("claude", failure);
				if (looksLikeAuthFailure(failure)) throw authRequired("claude", failure);
				throw processFailed("claude", result.exitCode, failure);
			}

			if (result.exitCode !== 0) {
				const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
				if (looksLikeAuthFailure(result.stderr)) throw authRequired("claude", tail);
				throw processFailed("claude", result.exitCode, tail);
			}

			// `??` is wrong here: a success result can carry an empty string, and that must
			// fall through to the streamed assistant text rather than count as an answer.
			const output = state.result?.trim() || state.lastAssistantText?.trim() || "";
			if (!output) {
				throw invalidOutput(
					"claude",
					state.sawResult
						? "the result event carried no text"
						: `no result event was produced (${reader.stats.lines} output lines)`,
				);
			}

			// The CLI is the authority on its own session id; ours was only a request.
			const effectiveSessionId = state.sessionId ?? sessionId;
			const enforcement = claudeReadOnlyEnforcement(args, readOnly);

			return {
				agent: "claude",
				success: true,
				output,
				sessionId: effectiveSessionId,
				exitCode: result.exitCode,
				durationMs: Date.now() - started,
				metadata: {
					readOnlyEnforced: enforcement.enforced,
					readOnlyMechanism: enforcement.mechanism,
					cliVersion: availability.version,
					turns: state.turns,
					costUsd: state.costUsd,
					permissionDenials: state.permissionDenials,
					parseErrors: reader.stats.parseErrors,
					model: request.model ?? this.config.model ?? null,
					sessionIdMismatch: state.sessionId !== undefined && state.sessionId !== sessionId && !request.sessionId,
					// `--fork-session` only applies when resuming; report the request honestly
					// either way (see buildClaudeArgs / types.ts AgentRequest.fork).
					forked: Boolean(request.fork),
				},
			};
		} catch (e) {
			if (e instanceof SpawnCwdError) throw invalidCwd("claude", request.cwd, e.message);
			throw e;
		}
	}
}
