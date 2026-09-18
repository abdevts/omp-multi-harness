import { describe, expect, test } from "bun:test";
import type { AgentName, AgentProgress, AgentRequest, AgentResult, AgentRunOptions, ExternalAgent } from "../src/agents/types.ts";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import { cancelled } from "../src/process/process-error.ts";
import { createWriteLockTable } from "../src/runs/lock.ts";
import { createRunRegistry } from "../src/runs/registry.ts";
import { createRingBuffer } from "../src/runs/ring-buffer.ts";
import type { RingBuffer } from "../src/runs/types.ts";

const CWD = "/tmp";

function tick(times = 3): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < times; i++) p = p.then(() => undefined);
	return p;
}

interface ConfigOverrides {
	maxConcurrentRuns?: number;
	writerQueue?: boolean;
	killGraceMs?: number;
}

function config(over: ConfigOverrides = {}): MultiHarnessConfig {
	return {
		...DEFAULTS,
		concurrency: { ...DEFAULTS.concurrency, ...(over.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: over.maxConcurrentRuns } : {}), ...(over.writerQueue !== undefined ? { writerQueue: over.writerQueue } : {}) },
		limits: { ...DEFAULTS.limits, killGraceMs: over.killGraceMs ?? 50 },
	};
}

interface PendingCall {
	request: AgentRequest;
	options: AgentRunOptions;
	finish: (result?: Partial<AgentResult>) => void;
	fail: (err: unknown) => void;
	/** Emit progress the way an adapter does: a throwing callback fails *this* call. */
	emit: (event: AgentProgress) => void;
}

interface FakeAgent {
	agent: ExternalAgent;
	calls: PendingCall[];
}

/** A controllable adapter: nothing is spawned, the test decides when each call settles. */
function fakeAgent(name: AgentName, opts: { rejectOnAbort?: boolean } = {}): FakeAgent {
	const calls: PendingCall[] = [];
	const agent: ExternalAgent = {
		name,
		isAvailable: async () => ({ agent: name, available: true, auth: "ok", authDetail: "ready" }),
		run: (request, options) =>
			new Promise<AgentResult>((resolve, reject) => {
				const call: PendingCall = {
					request,
					options,
					finish: (result) =>
						resolve({ agent: name, success: true, output: "done", exitCode: 0, durationMs: 1, ...result }),
					fail: reject,
					emit: (event) => {
						try {
							options.onProgress?.(event);
						} catch (err) {
							reject(err);
						}
					},
				};
				calls.push(call);
				if (opts.rejectOnAbort !== false) {
					options.signal.addEventListener("abort", () => reject(cancelled(name)), { once: true });
				}
			}),
	};
	return { agent, calls };
}

function registryWith(fake: FakeAgent, over: ConfigOverrides = {}) {
	return createRunRegistry({
		config: () => config(over),
		agentFor: () => fake.agent,
		lock: createWriteLockTable(),
	});
}

/** Adapter calls are ordered by *spawn*, not by start — writers wait on the lock first. */
function callFor(fake: FakeAgent, task: string): PendingCall {
	const call = fake.calls.find((c) => c.request.task === task);
	if (!call) throw new Error(`no adapter call for task "${task}"`);
	return call;
}

const READ = { agent: "codex" as const, cwd: CWD, readOnly: true };
const WRITE = { agent: "codex" as const, cwd: CWD, readOnly: false };

describe("run lifecycle", () => {
	test("start returns immediately and the run completes when the adapter resolves", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const view = reg.start({ ...READ, task: "summarize the test suite" });

		expect(view.id).toMatch(/^r[a-z2-9]{3,}$/);
		expect(view.status).toBe("running");
		expect(view.summary).toBe("summarize the test suite");
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]!.request.readOnly).toBe(true);

		fake.calls[0]!.finish({ output: "all green", sessionId: "sess-1" });
		const final = await reg.wait(view.id);
		expect(final?.status).toBe("done");
		expect(final?.output).toBe("all green");
		expect(final?.workerSessionId).toBe("sess-1");
		expect(final?.endedAt).toBeGreaterThan(0);
	});

	test("an adapter rejection fails the run with its typed error", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const view = reg.start({ ...READ, task: "boom" });
		fake.calls[0]!.fail(new Error("exploded"));
		const final = await reg.wait(view.id);
		expect(final?.status).toBe("failed");
		expect(final?.errorCode).toBe("PROCESS_FAILED");
		expect(final?.errorMessage).toContain("exploded");
	});

	test("an unsuccessful result is a failure, not a success", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const view = reg.start({ ...READ, task: "fails" });
		fake.calls[0]!.finish({ success: false, exitCode: 2, stderr: "exit 2" });
		const final = await reg.wait(view.id);
		expect(final?.status).toBe("failed");
		expect(final?.errorMessage).toContain("exit 2");
	});

	test("list is most-recent-first, get/tail are unknown-id safe", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const a = reg.start({ ...READ, task: "first" });
		const b = reg.start({ ...READ, task: "second" });
		expect(reg.list().map((r) => r.id)).toEqual([b.id, a.id]);
		expect(reg.get("nope")).toBeUndefined();
		expect(reg.tail("nope")).toEqual([]);
		expect(await reg.wait("nope")).toBeUndefined();
		await reg.shutdown();
	});

	test("focus is presentation-only and clearFinished drops terminal runs", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const a = reg.start({ ...READ, task: "a" });
		const b = reg.start({ ...READ, task: "b" });
		reg.focus(a.id);
		expect(reg.focused()).toBe(a.id);
		reg.focus("unknown-id");
		expect(reg.focused()).toBe(a.id);

		fake.calls[0]!.finish();
		await reg.wait(a.id);
		// Focus survives completion (spec 08).
		expect(reg.focused()).toBe(a.id);
		expect(reg.clearFinished()).toBe(1);
		expect(reg.focused()).toBeUndefined();
		expect(reg.list().map((r) => r.id)).toEqual([b.id]);
		await reg.shutdown();
	});
});

describe("concurrency", () => {
	test("maxConcurrentRuns caps live children; the rest sit queued", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake, { maxConcurrentRuns: 1 });
		const a = reg.start({ ...READ, task: "a" });
		const b = reg.start({ ...READ, task: "b" });

		expect(fake.calls).toHaveLength(1);
		expect(reg.get(a.id)?.status).toBe("running");
		expect(reg.get(b.id)?.status).toBe("queued");

		fake.calls[0]!.finish();
		await reg.wait(a.id);
		await tick();
		expect(fake.calls).toHaveLength(2);
		expect(reg.get(b.id)?.status).toBe("running");
		fake.calls[1]!.finish();
		expect((await reg.wait(b.id))?.status).toBe("done");
	});

	test("two writers in one workspace serialize; readers are unaffected", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake, { maxConcurrentRuns: 4 });
		const w1 = reg.start({ ...WRITE, task: "write one" });
		const w2 = reg.start({ ...WRITE, task: "write two" });
		const r1 = reg.start({ ...READ, task: "read one" });
		await tick();

		// One writer plus the reader are live; the second writer waits on the lock.
		expect(fake.calls).toHaveLength(2);
		expect(reg.get(w2.id)?.phase).toBe("waiting for workspace");
		expect(reg.get(r1.id)?.status).toBe("running");

		callFor(fake, "write one").finish();
		await reg.wait(w1.id);
		await tick();
		expect(fake.calls).toHaveLength(3);
		expect(reg.get(w2.id)?.status).toBe("running");
		callFor(fake, "write two").finish();
		callFor(fake, "read one").finish();
		await reg.shutdown();
	});

	test("writerQueue:false fails the second writer with WORKSPACE_BUSY", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake, { writerQueue: false });
		reg.start({ ...WRITE, task: "holder" });
		const w2 = reg.start({ ...WRITE, task: "loser" });
		await tick();
		const view = reg.get(w2.id);
		expect(view?.status).toBe("failed");
		expect(view?.errorCode).toBe("WORKSPACE_BUSY");
		fake.calls[0]!.finish();
		await reg.shutdown();
	});
});

describe("cancel and shutdown", () => {
	test("cancelling a queued run settles it without ever spawning", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake, { maxConcurrentRuns: 1 });
		reg.start({ ...READ, task: "a" });
		const b = reg.start({ ...READ, task: "b" });

		expect(await reg.cancel(b.id)).toBe(true);
		expect(reg.get(b.id)?.status).toBe("cancelled");
		expect(fake.calls).toHaveLength(1);
		// Idempotent: a terminal run cannot be cancelled again.
		expect(await reg.cancel(b.id)).toBe(false);
		expect(await reg.cancel("nope")).toBe(false);
		fake.calls[0]!.finish();
		await reg.shutdown();
	});

	test("cancelling a running run aborts it and marks it cancelled", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const a = reg.start({ ...READ, task: "a" });
		expect(await reg.cancel(a.id)).toBe(true);
		expect(fake.calls[0]!.options.signal.aborted).toBe(true);
		expect(reg.get(a.id)?.status).toBe("cancelled");
		expect(await reg.cancel(a.id)).toBe(false);
	});

	test("cancel is bounded by killGraceMs even when the adapter ignores the abort", async () => {
		const fake = fakeAgent("codex", { rejectOnAbort: false });
		const reg = registryWith(fake, { killGraceMs: 20 });
		const a = reg.start({ ...READ, task: "stubborn" });
		const started = Date.now();
		expect(await reg.cancel(a.id)).toBe(true);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(reg.get(a.id)?.status).toBe("cancelled");
		// A late result cannot resurrect a terminal run.
		fake.calls[0]!.finish();
		await tick();
		expect(reg.get(a.id)?.status).toBe("cancelled");
	});

	test("shutdown cancels every non-terminal run, queued ones included", async () => {
		const fake = fakeAgent("codex", { rejectOnAbort: false });
		const reg = registryWith(fake, { maxConcurrentRuns: 1, killGraceMs: 20 });
		const a = reg.start({ ...READ, task: "a" });
		const b = reg.start({ ...READ, task: "b" });
		const c = reg.start({ ...READ, task: "c" });
		fake.calls[0]!.finish();
		await reg.wait(a.id);

		await reg.shutdown();
		expect(reg.get(a.id)?.status).toBe("done");
		expect(reg.get(b.id)?.status).toBe("cancelled");
		expect(reg.get(c.id)?.status).toBe("cancelled");
		expect(reg.list().every((r) => r.endedAt !== undefined)).toBe(true);
	});
});

describe("wait", () => {
	test("returns the live view at the timeout and the final view after it settles", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const a = reg.start({ ...READ, task: "slow" });

		const timedOut = await reg.wait(a.id, 10);
		expect(timedOut?.status).toBe("running");
		expect(timedOut?.endedAt).toBeUndefined();

		fake.calls[0]!.finish({ output: "eventually" });
		const final = await reg.wait(a.id, 1_000);
		expect(final?.status).toBe("done");
		// A terminal run answers immediately, timeout or not.
		expect((await reg.wait(a.id, 0))?.status).toBe("done");
	});
});

describe("progress", () => {
	test("progress updates the phase, fills the buffer, and notifies subscribers", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		const seen: string[] = [];
		const unsubscribe = reg.subscribe((r) => seen.push(`${r.id}:${r.phase}`));
		const a = reg.start({ ...READ, task: "a" });

		fake.calls[0]!.emit({ phase: "running tests", detail: "3 files" });
		expect(reg.get(a.id)?.phase).toBe("running tests");
		expect(reg.tail(a.id)).toContain("running tests: 3 files");
		expect(seen.some((s) => s.endsWith(":running tests"))).toBe(true);

		unsubscribe();
		fake.calls[0]!.emit({ phase: "wrapping up" });
		expect(seen.some((s) => s.endsWith(":wrapping up"))).toBe(false);
		fake.calls[0]!.finish({ output: "final answer" });
		await reg.wait(a.id);
		expect(reg.tail(a.id).at(-1)).toBe("final answer");
	});

	test("a throwing subscriber is swallowed — presentation cannot fail a run", async () => {
		const fake = fakeAgent("codex");
		const reg = registryWith(fake);
		reg.subscribe(() => {
			throw new Error("bad widget");
		});
		const a = reg.start({ ...READ, task: "a" });
		fake.calls[0]!.emit({ phase: "working" });
		fake.calls[0]!.finish();
		expect((await reg.wait(a.id))?.status).toBe("done");
	});

	test("a throwing progress callback fails only its own run", async () => {
		const fake = fakeAgent("codex");
		// The first run's output buffer explodes on write; every later run gets a real one.
		let created = 0;
		const reg = createRunRegistry({
			config: () => config(),
			agentFor: () => fake.agent,
			lock: createWriteLockTable(),
			createBuffer: (maxBytes): RingBuffer => {
				created++;
				if (created > 1) return createRingBuffer(maxBytes);
				const inner = createRingBuffer(maxBytes);
				return {
					push: () => {
						throw new Error("buffer exploded");
					},
					lines: (limit?: number) => inner.lines(limit),
					text: () => inner.text(),
					get bytes() {
						return inner.bytes;
					},
					get droppedBytes() {
						return inner.droppedBytes;
					},
				};
			},
		});

		const bad = reg.start({ ...READ, task: "poisoned" });
		const good = reg.start({ ...READ, task: "healthy" });

		fake.calls[0]!.emit({ phase: "boom" });
		const badFinal = await reg.wait(bad.id, 1_000);
		expect(badFinal?.status).toBe("failed");
		expect(badFinal?.errorMessage).toContain("buffer exploded");

		// The sibling is untouched and the registry still works.
		expect(reg.get(good.id)?.status).toBe("running");
		fake.calls[1]!.emit({ phase: "still fine" });
		fake.calls[1]!.finish({ output: "ok" });
		expect((await reg.wait(good.id, 1_000))?.status).toBe("done");

		const after = reg.start({ ...READ, task: "later" });
		fake.calls[2]!.finish();
		expect((await reg.wait(after.id, 1_000))?.status).toBe("done");
	});
});

describe("session continuation", () => {
	test("resolves a worker session to resume and reports the one the worker returned", async () => {
		const fake = fakeAgent("codex");
		const seen: string[] = [];
		const reg = createRunRegistry({
			config: () => config(),
			agentFor: () => fake.agent,
			lock: createWriteLockTable(),
			resolveSessionId: () => "prior-session",
			onWorkerSession: (_agent, _cwd, id) => seen.push(id),
		});

		const a = reg.start({ ...READ, task: "resume me" });
		expect(fake.calls[0]!.request.sessionId).toBe("prior-session");
		fake.calls[0]!.finish({ sessionId: "new-session" });
		await reg.wait(a.id);
		expect(seen).toEqual(["new-session"]);

		const b = reg.start({ ...READ, task: "fresh", continueSession: false });
		expect(fake.calls[1]!.request.sessionId).toBeUndefined();
		fake.calls[1]!.finish();
		await reg.wait(b.id);
	});
});
