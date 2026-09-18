/**
 * Run registry contract. See _spec/08-sessions-and-parallelism.md.
 *
 * A *run* is one invocation of one external agent (one child process). Many may be alive
 * at once. This file is the shared contract between the registry, the `/sessions` command,
 * the `ask_*` tools, and the `agent_runs` tool — change it deliberately.
 */
import type { AgentMode, AgentName, AgentResult } from "../agents/types.ts";
import type { AgentError } from "../process/process-error.ts";

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** A run is terminal once it can never produce more output. */
export const TERMINAL_STATUSES: readonly RunStatus[] = ["done", "failed", "cancelled"];

export function isTerminal(status: RunStatus): boolean {
	return status === "done" || status === "failed" || status === "cancelled";
}

/** Byte-capped, line-aware live output buffer (T-402). */
export interface RingBuffer {
	/** Append raw output. Never throws; over-cap content is dropped from the front. */
	push(chunk: string): void;
	/** Most recent `limit` complete lines, oldest first. */
	lines(limit?: number): string[];
	/** Everything currently retained, joined. */
	text(): string;
	/** Bytes currently retained. */
	readonly bytes: number;
	/** Bytes discarded to stay under the cap — surfaced so the UI can say so. */
	readonly droppedBytes: number;
}

/** Live run. Held only inside the registry; everything else consumes `RunView`. */
export interface Run {
	id: string;
	agent: AgentName;
	mode?: AgentMode;
	/** Full task text as handed to the worker. */
	task: string;
	/** One line, for lists. */
	summary: string;
	cwd: string;
	readOnly: boolean;
	status: RunStatus;
	/** Wall clock at `start()`, including any time spent `queued`. */
	startedAt: number;
	/** Wall clock when the child process actually began. */
	spawnedAt?: number;
	endedAt?: number;
	/** Latest progress phase, e.g. "running tests". */
	phase: string;
	workerSessionId?: string;
	/** Resolved per-call model override, if any. Surfaced so `/sessions` can show it. */
	model?: string;
	result?: AgentResult;
	error?: AgentError;
	controller: AbortController;
	output: RingBuffer;
	/** True when this run is the supervisor's foreground call rather than a background run. */
	background: boolean;
}

/** Immutable snapshot handed to UI and tools. Never exposes the controller or buffer. */
export interface RunView {
	id: string;
	agent: AgentName;
	mode?: AgentMode;
	summary: string;
	task: string;
	cwd: string;
	readOnly: boolean;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	elapsedMs: number;
	phase: string;
	workerSessionId?: string;
	model?: string;
	background: boolean;
	/** Present once the run finished successfully. */
	output?: string;
	/** Present once the run failed. `code` is an `AgentErrorCode`. */
	errorCode?: string;
	errorMessage?: string;
	/**
	 * The adapter's own `AgentResult.metadata`, verbatim. Carries claims only the adapter can
	 * make honestly — notably `readOnlyEnforced`, which reflects the argv actually built rather
	 * than what the caller asked for.
	 */
	metadata?: Record<string, unknown>;
}

export interface StartRunInput {
	agent: AgentName;
	/** Final worker-facing text (already run through `buildHandoff`). */
	task: string;
	/** Short display summary; defaults to `summarize(task)`. */
	summary?: string;
	cwd: string;
	mode?: AgentMode;
	readOnly: boolean;
	model?: string;
	/** Resume the mapped worker session for (OMP session, cwd). Default true. */
	continueSession?: boolean;
	/**
	 * Explicit worker session id to resume. Supplied by the session store; when absent the
	 * registry asks its `resolveSessionId` dep. `continueSession` says *whether* to resume,
	 * this says *which* — the two are not interchangeable.
	 */
	resumeSessionId?: string;
	/** Fork rather than continue the resumed session (parallel same-agent, same-cwd). */
	fork?: boolean;
	/** Background runs are not awaited by their caller. */
	background?: boolean;
}

export interface RunRegistry {
	/**
	 * Accept a run and return it immediately (status `queued` or `running`). Returns
	 * synchronously and does NOT wait for the worker — await `wait(id)` for the result.
	 */
	start(input: StartRunInput): RunView;
	list(): RunView[];
	get(id: string): RunView | undefined;
	/** Idempotent: cancelling an already-terminal run is a no-op returning false. */
	cancel(id: string): Promise<boolean>;
	/** Resolve when the run reaches a terminal status, or after `timeoutMs` with the live view. */
	wait(id: string, timeoutMs?: number): Promise<RunView | undefined>;
	/** Presentation only — never pauses, throttles, or reorders any run. */
	focus(id: string | undefined): void;
	focused(): string | undefined;
	/** Drop terminal runs from the list. Returns how many were dropped. */
	clearFinished(): number;
	/** Live tail of a run's output. */
	tail(id: string, lines?: number): string[];
	/** Subscribe to any change (status, phase, output). Returns an unsubscribe function. */
	subscribe(listener: (run: RunView) => void): () => void;
	/** Cancel every non-terminal run and await termination. Bounded by `killGraceMs`. */
	shutdown(): Promise<void>;
}
