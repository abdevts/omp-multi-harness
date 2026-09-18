/**
 * Session continuation policy (T-408). See _spec/08-sessions-and-parallelism.md.
 *
 * A pure decision module: no spawning, no registry access, no disk. The caller feeds it the
 * stored mapping and whether a sibling run is live, and gets back the session argument to
 * use. `runWithResume` wraps one `ExternalAgent.run` call with the single fresh-session
 * fallback the spec allows.
 */
import type { AgentName, AgentRequest, AgentResult, AgentRunOptions, ExternalAgent } from "../agents/types.ts";
import { AgentError, looksLikeAuthFailure } from "../process/process-error.ts";
import { buildHandoff } from "../routing/handoff.ts";

export interface ResumeContext {
	agent: AgentName;
	/** `continueSession` from the request. Default true per spec 08. */
	continueSession?: boolean;
	/** Worker session id mapped to `(ompSession, cwd)`, from the session store. */
	storedSessionId?: string;
	/** True when another run for the SAME agent in the SAME cwd is already live. */
	siblingActive?: boolean;
}

export type ResumeReason =
	/** `continueSession: false` — the caller asked for a clean slate. */
	| "fresh-requested"
	/** Nothing mapped for this (OMP session, repo) yet. */
	| "no-mapping"
	/** Normal continuation of the mapped worker session. */
	| "resume"
	/** Claude: branch off the mapped session so both runs can proceed. */
	| "forked"
	/** Codex: no fork flag exists, so the second parallel run starts clean. */
	| "fresh-parallel";

export interface SessionDecision {
	/** Put on `AgentRequest.sessionId`. Undefined means "start a fresh worker session". */
	sessionId?: string;
	/**
	 * Claude only: pass as `fork` to `buildClaudeArgs` so argv gets `--fork-session`.
	 * `ExternalAgent.run` has no fork field, so the wiring layer must forward this.
	 */
	fork: boolean;
	reason: ResumeReason;
	/** Merged into `AgentResult.metadata` by `runWithResume`. */
	metadata: { forked?: true };
}

/**
 * Decide the session argument for a run. Two parallel runs on the same agent in the same
 * cwd must never resume the same worker session — the second forks (Claude) or starts
 * fresh (Codex), and either way is marked `forked`.
 */
export function decideSession(ctx: ResumeContext): SessionDecision {
	if (ctx.continueSession === false) return { fork: false, reason: "fresh-requested", metadata: {} };
	if (!ctx.storedSessionId) return { fork: false, reason: "no-mapping", metadata: {} };
	if (ctx.siblingActive) {
		return ctx.agent === "claude"
			? { sessionId: ctx.storedSessionId, fork: true, reason: "forked", metadata: { forked: true } }
			: { fork: false, reason: "fresh-parallel", metadata: { forked: true } };
	}
	return { sessionId: ctx.storedSessionId, fork: false, reason: "resume", metadata: {} };
}

/** Failures that mean "that worker session is gone", not "the task failed". */
const RESUME_FAILURE_PATTERNS = [
	/session (id )?[^\s]* ?(was )?not found/i,
	/no (such )?session/i,
	/no (session|conversation|thread) found/i,
	/unknown session/i,
	/session .*(does not|doesn't) exist/i,
	/could not (find|resume|load) (the )?(session|conversation|thread)/i,
	/failed to resume/i,
	/resume(d)? session .*(failed|invalid)/i,
	/(conversation|thread) .*not found/i,
	/invalid session id/i,
];

/** Codes that can never be cured by starting a fresh session — never retry on these. */
const NEVER_RESUME_FALLBACK = new Set(["AUTH_REQUIRED", "PROVIDER_LIMIT", "EXECUTABLE_NOT_FOUND", "CANCELLED", "TIMEOUT", "AGENT_DISABLED", "INVALID_CWD", "WORKSPACE_BUSY"]);

/**
 * Classify a failure as "the resume failed" vs. a genuine failure. Deliberately
 * conservative: only the explicit code, or a process failure whose stderr names a missing
 * session, qualifies. An auth or provider-limit failure must never trigger a retry.
 */
export function isResumeFailure(error: unknown): boolean {
	if (!(error instanceof AgentError)) return false;
	if (error.code === "SESSION_RESUME_FAILED") return true;
	if (NEVER_RESUME_FALLBACK.has(error.code)) return false;
	if (error.code !== "PROCESS_FAILED" && error.code !== "INVALID_OUTPUT") return false;
	const text = `${error.stderrTail ?? ""}\n${error.message}`;
	if (looksLikeAuthFailure(text)) return false;
	return RESUME_FAILURE_PATTERNS.some((p) => p.test(text));
}

const FRESH_SESSION_PREAMBLE =
	"The earlier session for this repository could not be resumed, so this is a fresh session with no prior history. " +
	"Re-read whatever you need from the repository rather than assuming earlier context.";

/** The note appended to the result so the user knows history was lost. */
export function resumeFallbackNote(agent: AgentName): string {
	return `Note: the previous ${agent} session could not be resumed. This ran in a fresh session with a compact handoff instead of full history.`;
}

/**
 * Task text for the retry: the compact handoff block, never an emulation of the transcript.
 */
export function buildResumeFallbackTask(request: AgentRequest, maxHandoffChars: number): string {
	const context = [request.context?.trim(), FRESH_SESSION_PREAMBLE].filter(Boolean).join("\n\n");
	return buildHandoff({ task: request.task, mode: request.mode, context, maxChars: maxHandoffChars });
}

export interface ResumeDeps {
	decision: SessionDecision;
	/** Cap for the handoff carried into the fallback run. Defaults to spec's 4 000. */
	maxHandoffChars?: number;
	/**
	 * Runner override. Needed for Claude, whose `--fork-session` argument is not expressible
	 * on `AgentRequest`. Defaults to `agent.run`.
	 */
	run?: (request: AgentRequest, options: AgentRunOptions) => Promise<AgentResult>;
	/** Called once with the user-visible note when the fallback fires. */
	onNote?: (note: string) => void;
}

/**
 * Run `agent` with the decided session, falling back to a fresh session **exactly once**
 * when — and only when — the resume itself failed. The fallback carries the compact
 * handoff, sets `metadata.resumedFallback`, and appends a visible note to the output.
 */
export async function runWithResume(
	agent: ExternalAgent,
	request: AgentRequest,
	options: AgentRunOptions,
	deps: ResumeDeps,
): Promise<AgentResult> {
	const { decision } = deps;
	const run = deps.run ?? ((req, opts) => agent.run(req, opts));
	const first: AgentRequest = { ...request, sessionId: decision.sessionId };

	try {
		return withMetadata(await run(first, options), decision.metadata);
	} catch (e) {
		// Only a failed *resume* is recoverable, and only when we actually tried to resume.
		if (!decision.sessionId || !isResumeFailure(e)) throw e;

		const note = resumeFallbackNote(agent.name);
		deps.onNote?.(note);
		const retry: AgentRequest = {
			...request,
			sessionId: undefined,
			context: undefined,
			task: buildResumeFallbackTask(request, deps.maxHandoffChars ?? 4_000),
		};
		const result = withMetadata(await run(retry, options), { ...decision.metadata, resumedFallback: true });
		return { ...result, output: `${result.output}\n\n${note}` };
	}
}

function withMetadata(result: AgentResult, extra: Record<string, unknown>): AgentResult {
	if (Object.keys(extra).length === 0) return result;
	return { ...result, metadata: { ...result.metadata, ...extra } };
}
