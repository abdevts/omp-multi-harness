/**
 * Codex CLI adapter. Every Codex flag in this project lives in this file.
 * Verified against codex-cli 0.155.0 (_spec/03-codex-adapter.md).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { applyCodexEvent, isQuotaFailure, newCodexStreamState } from "./codex-events.ts";
import { MODE_DEFAULT_READ_ONLY, type AgentRequest, type AgentResult, type AgentRunOptions, type ExternalAgent } from "./types.ts";

export interface CodexCapabilities {
	supportsJson: boolean;
	supportsOutputLastMessage: boolean;
	supportsResumeSubcommand: boolean;
}

/** Unknown or newer versions get the newest known capability set. */
export function codexCapabilities(_version: string | undefined): CodexCapabilities {
	return { supportsJson: true, supportsOutputLastMessage: true, supportsResumeSubcommand: true };
}

export interface BuildCodexArgsInput {
	request: AgentRequest;
	config: AgentConfig;
	capabilities: CodexCapabilities;
	/** Path for `-o`; omitted when the capability is unavailable. */
	lastMessageFile?: string;
	/** True when cwd is not inside a git repository. */
	skipGitRepoCheck?: boolean;
	readOnly: boolean;
}

/**
 * Build argv for `codex exec`. The prompt is NOT here: it goes over stdin (`-`), keeping
 * task text out of `ps` and clear of argv limits.
 */
export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
	const { request, config, capabilities, lastMessageFile, skipGitRepoCheck, readOnly } = input;
	const args: string[] = ["exec"];

	if (request.sessionId && capabilities.supportsResumeSubcommand) {
		args.push("resume", request.sessionId);
	}

	if (capabilities.supportsJson) args.push("--json");
	args.push("-C", request.cwd);
	args.push("-s", readOnly ? "read-only" : "workspace-write");

	if (lastMessageFile && capabilities.supportsOutputLastMessage) args.push("-o", lastMessageFile);
	if (skipGitRepoCheck) args.push("--skip-git-repo-check");

	const model = request.model ?? config.model;
	if (model) args.push("-m", model);

	for (const dir of config.additionalDirs) args.push("--add-dir", dir);

	// `-` = read the prompt from stdin. Always last.
	args.push("-");
	return args;
}

function isGitRepo(cwd: string): boolean {
	try {
		return Bun.spawnSync({ cmd: ["git", "rev-parse", "--is-inside-work-tree"], cwd, stdout: "ignore", stderr: "ignore" })
			.exitCode === 0;
	} catch {
		return false;
	}
}

export class CodexAgent implements ExternalAgent {
	readonly name = "codex" as const;

	constructor(private readonly config: AgentConfig) {}

	async isAvailable(force = false) {
		return detect("codex", this.config, { cwd: process.cwd(), force });
	}

	async run(request: AgentRequest, options: AgentRunOptions): Promise<AgentResult> {
		const started = Date.now();
		const executable = resolveExecutable(this.config.executable);
		if (!executable) {
			throw new AgentError({
				code: "EXECUTABLE_NOT_FOUND",
				agent: "codex",
				message: `\`${this.config.executable}\` was not found on PATH. Install the Codex CLI, or set multiHarness.codex.executable to its full path.`,
			});
		}

		const availability = await detect("codex", this.config, { cwd: request.cwd });
		const capabilities = codexCapabilities(availability.version);

		const readOnly = request.readOnly ?? (request.mode ? MODE_DEFAULT_READ_ONLY[request.mode] : false);
		const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;

		const tempDir = mkdtempSync(join(tmpdir(), "multi-harness-"));
		const lastMessageFile = join(tempDir, "last-message.txt");

		const args = buildCodexArgs({
			request,
			config: this.config,
			capabilities,
			lastMessageFile,
			skipGitRepoCheck: !isGitRepo(request.cwd),
			readOnly,
		});

		const state = newCodexStreamState();
		const reader = new JsonlReader((value) => {
			if (value === undefined) return;
			const progress = applyCodexEvent(state, value);
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

			if (result.cancelled) throw cancelled("codex");
			if (result.timedOut) throw timedOut("codex", timeoutMs);

			const failure = state.failure;
			if (failure) {
				if (isQuotaFailure(failure)) throw providerLimit("codex", failure);
				if (looksLikeAuthFailure(failure)) throw authRequired("codex", failure);
				throw processFailed("codex", result.exitCode, failure);
			}

			// Codex logs unrelated warnings to stderr, so stderr alone never decides failure.
			if (result.exitCode !== 0) {
				const tail = result.stderr.trim().split("\n").slice(-3).join("\n");
				if (looksLikeAuthFailure(result.stderr)) throw authRequired("codex", tail);
				throw processFailed("codex", result.exitCode, tail);
			}

			let output = "";
			try {
				output = readFileSync(lastMessageFile, "utf8").trim();
			} catch {
				/* the file is absent when the CLI had nothing to write */
			}
			if (!output) output = state.lastAgentMessage?.trim() ?? "";
			if (!output) {
				throw invalidOutput(
					"codex",
					reader.stats.parsed === 0
						? `no JSON events were produced (${reader.stats.lines} output lines) — does this codex version support --json?`
						: "the run finished without a final message",
				);
			}

			return {
				agent: "codex",
				success: true,
				output,
				sessionId: state.sessionId,
				exitCode: result.exitCode,
				durationMs: Date.now() - started,
				metadata: {
					readOnlyEnforced: readOnly,
					cliVersion: availability.version,
					items: state.itemCount,
					parseErrors: reader.stats.parseErrors,
					model: request.model ?? this.config.model ?? null,
				},
			};
		} catch (e) {
			if (e instanceof SpawnCwdError) throw invalidCwd("codex", request.cwd, e.message);
			throw e;
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	}
}
