/**
 * In-memory, session-scoped run registry (T-401/T-403/T-409, _spec/08).
 *
 * Everything the registry needs from the outside world is injected, so it is host-agnostic
 * and unit-testable: no `ctx`, no real child processes, no raw timers beyond the bounded
 * ones in `wait`/`shutdown`. UI ticking belongs to the command layer (`ctx.setInterval`),
 * not here.
 */
import type { AgentName, AgentRequest, AgentResult, ExternalAgent } from "../agents/types.ts";
import type { MultiHarnessConfig } from "../config/schema.ts";
import { AgentError, cancelled } from "../process/process-error.ts";
import { summarize } from "../routing/handoff.ts";
import { createWriteLockTable, type ReleaseWriteLock, type WriteLockTable } from "./lock.ts";
import { createRingBuffer } from "./ring-buffer.ts";
import { isTerminal, type Run, type RunRegistry, type RunStatus, type RunView, type StartRunInput } from "./types.ts";

export interface RunRegistryDeps {
	/** Read on every start so a live config reload is picked up without rebuilding the registry. */
	config: () => MultiHarnessConfig;
	/** Adapter factory. Injected so tests never spawn a real CLI. */
	agentFor: (agent: AgentName) => ExternalAgent;
	/** Injectable clock; tests freeze it. Defaults to `Date.now`. */
	now?: () => number;
	/** Injectable lock table; defaults to a private one per registry. */
	lock?: WriteLockTable;
	/** Injectable output buffer factory — tests use it to simulate a failing progress path. */
	createBuffer?: (maxBytes: number) => import("./types.ts").RingBuffer;
	/**
	 * Worker session to resume for `(agent, cwd)` when `continueSession` is not false.
	 * The session store (T-407) wires this in; without it every run starts fresh.
	 */
	resolveSessionId?: (agent: AgentName, cwd: string) => string | undefined;
	/** Called when a run reports a worker session id, so the store can persist the mapping. */
	onWorkerSession?: (agent: AgentName, cwd: string, sessionId: string) => void;
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"; // no l/0/1 — these ids get retyped by hand

/** Registry-private fields; the shared `Run` contract in types.ts stays untouched. */
interface InternalRun extends Run {
	/** Worker session to resume, resolved at `start` from the injected session store. */
	sessionSeed?: string;
	/** Per-call model override. */
	model?: string;
}

/** Internal bookkeeping that must not leak into the shared `Run` shape. */
interface RunSlot {
	run: InternalRun;
	/** Monotonic insertion order; breaks `startedAt` ties under a frozen clock. */
	seq: number;
	/** Resolves when the run reaches a terminal status. Never rejects. */
	done: Promise<void>;
	settle: () => void;
	/** True once the run has taken a concurrency slot. */
	launched: boolean;
}

export function createRunRegistry(deps: RunRegistryDeps): RunRegistry {
	const now = deps.now ?? (() => Date.now());
	const lock = deps.lock ?? createWriteLockTable();
	const makeBuffer = deps.createBuffer ?? createRingBuffer;

	const slots = new Map<string, RunSlot>();
	const listeners = new Set<(run: RunView) => void>();
	/** FIFO of run ids waiting for a concurrency slot. */
	const pending: string[] = [];
	let active = 0;
	let seq = 0;
	let focusedId: string | undefined;

	function newId(): string {
		for (let length = 3; ; length++) {
			for (let attempt = 0; attempt < 32; attempt++) {
				let id = "r";
				for (let i = 0; i < length; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
				if (!slots.has(id)) return id;
			}
		}
	}

	function toView(run: Run): RunView {
		const view: RunView = {
			id: run.id,
			agent: run.agent,
			mode: run.mode,
			summary: run.summary,
			task: run.task,
			cwd: run.cwd,
			readOnly: run.readOnly,
			status: run.status,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			elapsedMs: (run.endedAt ?? now()) - run.startedAt,
			phase: run.phase,
			workerSessionId: run.workerSessionId,
			background: run.background,
		};
		if (run.result) {
			view.output = run.result.output;
			if (run.result.metadata) view.metadata = run.result.metadata;
		}
		if (run.error) {
			view.errorCode = run.error.code;
			view.errorMessage = run.error.message;
		}
		return view;
	}

	/** A listener that throws is a UI bug; it must never take a run — or the registry — down. */
	function emit(run: Run): void {
		if (listeners.size === 0) return;
		const view = toView(run);
		for (const listener of listeners) {
			try {
				listener(view);
			} catch {
				// Swallowed on purpose: presentation cannot fail execution.
			}
		}
	}

	function finish(slot: RunSlot, status: RunStatus, patch: { result?: AgentResult; error?: AgentError; phase?: string }): void {
		const { run } = slot;
		if (isTerminal(run.status)) return;
		run.status = status;
		run.endedAt = now();
		if (patch.result) run.result = patch.result;
		if (patch.error) run.error = patch.error;
		run.phase = patch.phase ?? (status === "done" ? "completed" : status);
		emit(run);
		slot.settle();
	}

	function toAgentError(agent: AgentName, err: unknown): AgentError {
		if (err instanceof AgentError) return err;
		const message = err instanceof Error ? err.message : String(err);
		return new AgentError({ code: "PROCESS_FAILED", agent, message, cause: err });
	}

	/** Start as many queued runs as `maxConcurrentRuns` allows, oldest first. */
	function pump(): void {
		const max = Math.max(1, deps.config().concurrency.maxConcurrentRuns);
		while (active < max && pending.length > 0) {
			const id = pending.shift()!;
			const slot = slots.get(id);
			if (!slot || isTerminal(slot.run.status)) continue;
			active++;
			slot.launched = true;
			// Detached by design — `execute` never rejects, but belt and braces: a rejection
			// here would otherwise be an unhandled rejection that can tear down the host.
			execute(slot).catch((err) => finish(slot, "failed", { error: toAgentError(slot.run.agent, err) }));
		}
	}

	async function execute(slot: RunSlot): Promise<void> {
		const { run } = slot;
		let release: ReleaseWriteLock | undefined;
		try {
			if (run.controller.signal.aborted) {
				finish(slot, "cancelled", { error: cancelled(run.agent) });
				return;
			}

			const config = deps.config();
			if (!run.readOnly) {
				// Writers serialize per workspace; readers never touch the lock (spec 08 table).
				run.phase = "waiting for workspace";
				emit(run);
				release = await lock.acquire(run.cwd, {
					agent: run.agent,
					queue: config.concurrency.writerQueue,
					holder: `${run.agent} ${run.id}`,
					signal: run.controller.signal,
				});
			}

			if (run.controller.signal.aborted) {
				finish(slot, "cancelled", { error: cancelled(run.agent) });
				return;
			}

			run.status = "running";
			run.spawnedAt = now();
			run.phase = "starting";
			emit(run);

			const request: AgentRequest = {
				agent: run.agent,
				task: run.task,
				cwd: run.cwd,
				mode: run.mode,
				readOnly: run.readOnly,
				timeoutMs: config[run.agent].timeoutMs,
			};
			if (run.sessionSeed) request.sessionId = run.sessionSeed;
			if (run.model) request.model = run.model;

			const result = await deps.agentFor(run.agent).run(request, {
				signal: run.controller.signal,
				onProgress: (event) => {
					run.phase = event.phase;
					run.output.push(event.detail ? `${event.phase}: ${event.detail}\n` : `${event.phase}\n`);
					emit(run);
				},
			});

			if (result.sessionId) {
				run.workerSessionId = result.sessionId;
				deps.onWorkerSession?.(run.agent, run.cwd, result.sessionId);
			}
			run.output.push(result.output.endsWith("\n") ? result.output : `${result.output}\n`);

			if (run.controller.signal.aborted && !result.success) {
				finish(slot, "cancelled", { result, error: cancelled(run.agent) });
			} else if (result.success) {
				finish(slot, "done", { result });
			} else {
				finish(slot, "failed", { result, error: toAgentError(run.agent, new Error(result.stderr || "the agent reported failure")) });
			}
		} catch (err) {
			const error = toAgentError(run.agent, err);
			finish(slot, error.code === "CANCELLED" || run.controller.signal.aborted ? "cancelled" : "failed", { error });
		} finally {
			// Always, including cancellation and throws — a leaked lock wedges the workspace.
			release?.();
			active = Math.max(0, active - 1);
			pump();
		}
	}

	return {
		start(input: StartRunInput): RunView {
			const config = deps.config();
			const id = newId();
			const run: InternalRun = {
				id,
				agent: input.agent,
				mode: input.mode,
				task: input.task,
				summary: input.summary ?? summarize(input.task),
				cwd: input.cwd,
				readOnly: input.readOnly,
				status: "queued",
				startedAt: now(),
				phase: "queued",
				controller: new AbortController(),
				output: makeBuffer(config.limits.ringBufferBytes),
				background: input.background ?? false,
			};
			if (input.model) run.model = input.model;
			if (input.continueSession !== false) {
				run.sessionSeed = deps.resolveSessionId?.(input.agent, input.cwd);
			}

			let settle!: () => void;
			const done = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const slot: RunSlot = { run, seq: seq++, done, settle, launched: false };
			slots.set(id, slot);
			pending.push(id);
			emit(run);
			// Kicks off execution; `start` itself never waits for the worker.
			pump();
			return toView(run);
		},

		list(): RunView[] {
			return [...slots.values()]
				.sort((a, b) => b.run.startedAt - a.run.startedAt || b.seq - a.seq)
				.map((s) => toView(s.run));
		},

		get(id: string): RunView | undefined {
			const slot = slots.get(id);
			return slot ? toView(slot.run) : undefined;
		},

		async cancel(id: string): Promise<boolean> {
			const slot = slots.get(id);
			if (!slot || isTerminal(slot.run.status)) return false;
			slot.run.controller.abort();
			if (!slot.launched) {
				// Never spawned: settle it here, the pump would otherwise skip it silently.
				const i = pending.indexOf(id);
				if (i >= 0) pending.splice(i, 1);
				finish(slot, "cancelled", { error: cancelled(slot.run.agent) });
				return true;
			}
			await withDeadline(slot.done, deps.config().limits.killGraceMs);
			// The child ignored the grace period; the registry still tells the truth.
			finish(slot, "cancelled", { error: cancelled(slot.run.agent) });
			return true;
		},

		async wait(id: string, timeoutMs?: number): Promise<RunView | undefined> {
			const slot = slots.get(id);
			if (!slot) return undefined;
			if (isTerminal(slot.run.status)) return toView(slot.run);
			if (timeoutMs === undefined) {
				await slot.done;
			} else {
				await withDeadline(slot.done, timeoutMs);
			}
			// On timeout this is deliberately the *live* view — callers poll or re-wait.
			return toView(slot.run);
		},

		focus(id: string | undefined): void {
			if (id !== undefined && !slots.has(id)) return;
			focusedId = id;
		},

		focused(): string | undefined {
			return focusedId;
		},

		clearFinished(): number {
			let dropped = 0;
			for (const [id, slot] of [...slots]) {
				if (!isTerminal(slot.run.status)) continue;
				slots.delete(id);
				if (focusedId === id) focusedId = undefined;
				dropped++;
			}
			return dropped;
		},

		tail(id: string, lines?: number): string[] {
			return slots.get(id)?.run.output.lines(lines) ?? [];
		},

		subscribe(listener: (run: RunView) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		async shutdown(): Promise<void> {
			const live = [...slots.values()].filter((s) => !isTerminal(s.run.status));
			for (const slot of live) {
				slot.run.controller.abort();
				if (!slot.launched) {
					const i = pending.indexOf(slot.run.id);
					if (i >= 0) pending.splice(i, 1);
					finish(slot, "cancelled", { error: cancelled(slot.run.agent) });
				}
			}
			await withDeadline(
				Promise.all(live.map((s) => s.done)).then(() => undefined),
				deps.config().limits.killGraceMs,
			);
			// Anything still alive after the grace period is recorded as cancelled anyway: no
			// child may outlive the OMP session, and the registry must not lie about it either.
			for (const slot of live) finish(slot, "cancelled", { error: cancelled(slot.run.agent) });
		},
	};
}

/** Resolve when `promise` settles or `ms` elapses, whichever comes first. Never rejects. */
function withDeadline(promise: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, Math.max(0, ms));
		// `unref` keeps a pending deadline from holding the process open in tests/CLIs.
		(timer as unknown as { unref?: () => void }).unref?.();
		promise.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			() => {
				clearTimeout(timer);
				resolve();
			},
		);
	});
}
