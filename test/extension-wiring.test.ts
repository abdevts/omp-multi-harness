/**
 * `src/index.ts` — the extension's wiring — has zero coverage on its own (it was hand-written
 * and only typechecked). This exercises the load phase, registration completeness, the
 * session-id bridge between the (sync) registry and the (async) session store, registry
 * lifecycle across session_start/session_shutdown, config gating, and `deliverBackgroundResult`.
 *
 * `agentFor` inside `multiHarness` is a private closure (`new CodexAgent(...)` / `new
 * ClaudeAgent(...)`), so it cannot be injected from outside. Instead of spawning a real CLI,
 * tests that need to reach a run monkeypatch `CodexAgent.prototype.run` / `ClaudeAgent.prototype.run`
 * for the duration of the test — the same technique as stubbing any other class method — and
 * restore it afterward. This is the only way to observe what the registry actually hands the
 * adapter (e.g. the resumed session id) through the public extension surface.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ClaudeAgent } from "../src/agents/claude.ts";
import { CodexAgent } from "../src/agents/codex.ts";
import type { AgentName, AgentRequest, AgentResult, AgentRunOptions } from "../src/agents/types.ts";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import { cancelled } from "../src/process/process-error.ts";
import type { RunView } from "../src/runs/types.ts";
import { createSessionStore, resetAgentDirCache } from "../src/sessions/store.ts";
import { deliverBackgroundResult } from "../src/tools/ask-agent.ts";
import multiHarness from "../src/index.ts";

function tick(times = 5): Promise<void> {
	let p = Promise.resolve();
	for (let i = 0; i < times; i++) p = p.then(() => undefined);
	return p;
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/** Minimal zod stand-in: the extension only builds schemas from it, never validates. Matches
 *  the pattern already used in test/agent-runs.test.ts. */
function fakeZod() {
	const node = (): unknown => {
		const self = { optional: () => self, describe: () => self, default: () => self };
		return self;
	};
	return { object: node, string: node, number: node, boolean: node, enum: node };
}

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: ExtensionContext,
	) => Promise<{ content: { type: "text"; text: string }[]; details?: Record<string, unknown>; isError?: boolean }>;
}

interface CommandDef {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface FakePi {
	pi: ExtensionAPI;
	commands: Map<string, CommandDef>;
	tools: Map<string, ToolDef>;
	events: Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>;
	labels: { entryIdOrLabel: string; label?: string }[];
	appendEntries: { customType: string; data: unknown }[];
	sendUserMessages: { content: unknown; options?: unknown }[];
	warnings: string[];
	infos: string[];
}

/** Records every registration and action call; never throws — actions must be observable. */
function fakePi(): FakePi {
	const commands = new Map<string, CommandDef>();
	const tools = new Map<string, ToolDef>();
	const events = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const labels: { entryIdOrLabel: string; label?: string }[] = [];
	const appendEntries: { customType: string; data: unknown }[] = [];
	const sendUserMessages: { content: unknown; options?: unknown }[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];

	const pi = {
		zod: fakeZod(),
		logger: {
			warn: (msg: string) => warnings.push(msg),
			info: (msg: string) => infos.push(msg),
			error: () => {},
			debug: () => {},
		},
		setLabel: (entryIdOrLabel: string, label?: string) => labels.push({ entryIdOrLabel, label }),
		registerCommand: (name: string, options: CommandDef) => commands.set(name, options),
		registerTool: (def: ToolDef) => tools.set(def.name, def),
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
		appendEntry: (customType: string, data?: unknown) => appendEntries.push({ customType, data }),
		sendUserMessage: (content: unknown, options?: unknown) => {
			sendUserMessages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	return { pi, commands, tools, events, labels, appendEntries, sendUserMessages, warnings, infos };
}

/** `sessionId` is a getter so a test can flip it between calls into `ctx`. */
function fakeCtx(cwd: string, sessionId: () => string | undefined) {
	const notices: { message: string; type?: string }[] = [];
	const statuses: (string | undefined)[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			setWidget: () => {},
			confirm: async () => true,
			select: async () => undefined,
			input: async () => undefined,
		},
		setInterval: ((cb: (...args: unknown[]) => void, ms?: number) => setInterval(cb, ms) as unknown as Timer) as ExtensionContext["setInterval"],
		setTimeout: ((cb: (...args: unknown[]) => void, ms?: number) => setTimeout(cb, ms) as unknown as Timer) as ExtensionContext["setTimeout"],
		clearTimer: (timer: Timer) => {
			clearInterval(timer as unknown as ReturnType<typeof setInterval>);
			clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
		},
		sessionManager: { getSessionId: () => sessionId() },
		models: { list: () => [], current: () => undefined, resolve: () => undefined, family: () => "" },
	} as unknown as ExtensionContext;
	return { ctx, notices, statuses };
}

async function fireSessionStart(fp: FakePi, ctx: ExtensionContext): Promise<void> {
	const handlers = fp.events.get("session_start") ?? [];
	for (const h of handlers) await h({ type: "session_start" }, ctx);
}

async function fireSessionShutdown(fp: FakePi): Promise<void> {
	const handlers = fp.events.get("session_shutdown") ?? [];
	for (const h of handlers) await h({ type: "session_shutdown" }, undefined as unknown as ExtensionContext);
}

/** One captured call to a monkeypatched adapter. `resolve` settles it; abort rejects it with
 *  CANCELLED, mirroring how a real adapter honors the signal (see test/run-registry.test.ts). */
interface PatchedCall {
	request: AgentRequest;
	options: AgentRunOptions;
	resolve: (result?: Partial<AgentResult>) => void;
}

/** Replaces `AgentClass.prototype.run` for the duration of a test so runs never spawn a real
 *  CLI, while everything else about the extension (registry, lock, store wiring) is real. */
function patchAgentRun(AgentClass: typeof CodexAgent | typeof ClaudeAgent, name: AgentName) {
	const proto = AgentClass.prototype as unknown as { run: (request: AgentRequest, options: AgentRunOptions) => Promise<AgentResult> };
	const original = proto.run;
	const calls: PatchedCall[] = [];
	proto.run = (request: AgentRequest, options: AgentRunOptions): Promise<AgentResult> =>
		new Promise<AgentResult>((resolve, reject) => {
			options.signal.addEventListener("abort", () => reject(cancelled(name)), { once: true });
			calls.push({
				request,
				options,
				resolve: (result) => resolve({ agent: name, success: true, output: "ok", exitCode: 0, durationMs: 1, ...result }),
			});
		});
	return {
		calls,
		restore: () => {
			proto.run = original;
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Isolated agent dir + cwd per test, so the session store never touches the user's real
// ~/.omp/agent or a real project's .omp/config.yml. `resolveAgentDir` prefers OMP's own
// `getAgentDir()`, which itself honors PI_CODING_AGENT_DIR (verified against the installed
// package) but memoizes its result — both the env var and the cache must be reset.
// ---------------------------------------------------------------------------------------------

let prevAgentDirEnv: string | undefined;
let agentDir: string;
let cwdDir: string;

beforeEach(() => {
	prevAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "mh-wiring-agent-"));
	cwdDir = mkdtempSync(join(tmpdir(), "mh-wiring-cwd-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetAgentDirCache();
});

afterEach(() => {
	if (prevAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevAgentDirEnv;
	resetAgentDirCache();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwdDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------

describe("registration completeness", () => {
	test("every command, tool, and lifecycle event handler is registered on load", () => {
		const fp = fakePi();
		multiHarness(fp.pi);

		expect([...fp.commands.keys()].sort()).toEqual(["agents", "claude", "codex", "harness-setup", "sessions"]);
		expect([...fp.tools.keys()].sort()).toEqual(["agent_runs", "ask_claude", "ask_codex", "delegate"]);
		expect(fp.events.get("session_start")?.length).toBe(1);
		expect(fp.events.get("session_shutdown")?.length).toBe(1);
		expect(fp.labels).toEqual([{ entryIdOrLabel: "Multi-Harness", label: undefined }]);
	});
});

describe("load phase is registration-only", () => {
	test("constructing the extension never calls an action method (_spec/01 §2)", () => {
		const fp = fakePi();
		multiHarness(fp.pi);

		// Only registration + setLabel may fire during `multiHarness(pi)` itself. Any of these
		// firing at load time would throw ExtensionRuntimeNotInitializedError against a real host.
		expect(fp.appendEntries).toEqual([]);
		expect(fp.sendUserMessages).toEqual([]);
		expect(fp.warnings).toEqual([]);
		expect(fp.infos).toEqual([]);
	});
});

describe("config gating", () => {
	test("multiHarness.enabled: false makes session_start return early without building session state", async () => {
		writeFileSync(join(agentDir, "config.yml"), "multiHarness:\n  enabled: false\n");
		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx } = fakeCtx(cwdDir, () => "omp-session-1");

		await fireSessionStart(fp, ctx);

		expect(fp.infos.some((m) => m.includes("disabled via multiHarness.enabled"))).toBe(true);

		// Proof it never touched the registry/session machinery: a run started right after still
		// goes through *some* registry (index.ts always has one from load), but disabled config
		// means the tool itself refuses before ever calling `registry.start`.
		const askCodex = fp.tools.get("ask_codex");
		if (!askCodex) throw new Error("ask_codex was not registered");
		const result = await askCodex.execute("call-1", { task: "anything" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("disabled");
	});
});

describe("the session-id bridge", () => {
	test("a stored session id is warmed into the cache and handed to a run for the same (agent, cwd); a different cwd does not get it", async () => {
		const store = createSessionStore({ baseDir: agentDir });
		await store.record("omp-session-1", cwdDir, "codex", "resume-me");

		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx: mainCtx } = fakeCtx(cwdDir, () => "omp-session-1");
		await fireSessionStart(fp, mainCtx);

		const patched = patchAgentRun(CodexAgent, "codex");
		try {
			const askCodex = fp.tools.get("ask_codex");
			if (!askCodex) throw new Error("ask_codex was not registered");

			// Same (agent, cwd) as the warmed mapping: must resume it.
			const sameCwdCall = askCodex.execute("call-1", { task: "same cwd" }, undefined, undefined, mainCtx);
			await tick();
			expect(patched.calls).toHaveLength(1);
			expect(patched.calls[0]!.request.sessionId).toBe("resume-me");
			patched.calls[0]!.resolve({ sessionId: "resume-me" });
			await sameCwdCall;

			// A different cwd was never warmed for this (agent, cwd) pair, mapping or not.
			const otherCwd = mkdtempSync(join(tmpdir(), "mh-wiring-other-"));
			try {
				const { ctx: otherCtx } = fakeCtx(otherCwd, () => "omp-session-1");
				const otherCwdCall = askCodex.execute("call-2", { task: "other cwd" }, undefined, undefined, otherCtx);
				await tick();
				expect(patched.calls).toHaveLength(2);
				expect(patched.calls[1]!.request.sessionId).toBeUndefined();
				patched.calls[1]!.resolve({ sessionId: "unrelated" });
				await otherCwdCall;
			} finally {
				rmSync(otherCwd, { recursive: true, force: true });
			}
		} finally {
			patched.restore();
		}
	});

	test("onWorkerSession updates the warm cache synchronously even though the store write is detached", async () => {
		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx } = fakeCtx(cwdDir, () => "omp-session-1");
		await fireSessionStart(fp, ctx); // no prior mapping — cache starts empty

		const patched = patchAgentRun(CodexAgent, "codex");
		try {
			const askCodex = fp.tools.get("ask_codex");
			if (!askCodex) throw new Error("ask_codex was not registered");

			const first = askCodex.execute("call-1", { task: "first" }, undefined, undefined, ctx);
			await tick();
			expect(patched.calls).toHaveLength(1);
			expect(patched.calls[0]!.request.sessionId).toBeUndefined(); // nothing to resume yet
			// The adapter reports a brand new worker session id when it finishes.
			patched.calls[0]!.resolve({ sessionId: "brand-new-id" });
			await first; // by the time this resolves, onWorkerSession has already run (registry.ts)

			// A second call for the same (agent, cwd), still within the same OMP session, must see
			// the cache update immediately — the store write to disk is fire-and-forget and was
			// never awaited here, so this can only pass if the in-memory cache updated synchronously.
			const second = askCodex.execute("call-2", { task: "second" }, undefined, undefined, ctx);
			await tick();
			expect(patched.calls).toHaveLength(2);
			expect(patched.calls[1]!.request.sessionId).toBe("brand-new-id");
			patched.calls[1]!.resolve({ sessionId: "brand-new-id" });
			await second;
		} finally {
			patched.restore();
		}
	});
});

describe("sessions.persist: false", () => {
	test("skips the store entirely — no read on start and no write on completion", async () => {
		writeFileSync(join(agentDir, "config.yml"), "multiHarness:\n  sessions:\n    persist: false\n");

		// Pre-populate, then corrupt, a mapping file. If session_start reads the store despite
		// persist:false, `store.get` would warn "corrupt JSON"; the absence of that warning is
		// direct evidence the read never happened.
		const store = createSessionStore({ baseDir: agentDir });
		await store.record("omp-session-1", cwdDir, "codex", "should-not-be-read");
		const file = await store.path("omp-session-1", cwdDir);
		writeFileSync(file, "{not json");

		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx } = fakeCtx(cwdDir, () => "omp-session-1");
		await fireSessionStart(fp, ctx);
		expect(fp.warnings.some((w) => w.includes("corrupt"))).toBe(false);

		// Now prove completion doesn't write either: run one call to a terminal state and confirm
		// the on-disk (corrupt) file is untouched — a real write would replace it with valid JSON.
		const patched = patchAgentRun(CodexAgent, "codex");
		try {
			const askCodex = fp.tools.get("ask_codex");
			if (!askCodex) throw new Error("ask_codex was not registered");
			const call = askCodex.execute("call-1", { task: "no persistence" }, undefined, undefined, ctx);
			await tick();
			patched.calls[0]!.resolve({ sessionId: "some-session" });
			await call;
			await tick();
			expect(readFileSync(file, "utf8")).toBe("{not json");
		} finally {
			patched.restore();
		}
	});
});

describe("registry lifecycle", () => {
	test("session_start drains a previous registry (cancels a non-terminal run) before replacing it", async () => {
		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx } = fakeCtx(cwdDir, () => "omp-session-1");
		await fireSessionStart(fp, ctx);

		const patched = patchAgentRun(CodexAgent, "codex");
		try {
			const askCodex = fp.tools.get("ask_codex");
			const agentRuns = fp.tools.get("agent_runs");
			if (!askCodex || !agentRuns) throw new Error("tools missing");

			// Background so the tool call returns immediately with a run id while the (patched,
			// never-resolving-until-told) adapter call is still in flight.
			const started = await askCodex.execute("call-1", { task: "long running", background: true }, undefined, undefined, ctx);
			const runId = started.details?.runId as string;
			expect(typeof runId).toBe("string");
			await tick();
			expect(patched.calls).toHaveLength(1);

			const before = await agentRuns.execute("call-2", { action: "status", runId }, undefined, undefined, ctx);
			expect(before.details?.status).toBe("running");

			// A fresh session_start must drain (abort + wait out) the OLD registry's runs before
			// swapping in a new one — a leaked child must never survive into the next session.
			await fireSessionStart(fp, ctx);

			const after = await agentRuns.execute("call-3", { action: "status", runId }, undefined, undefined, ctx);
			// The run id from the old registry does not exist in the replacement registry at all.
			expect(after.content[0]?.text).toContain(`No run with id ${runId}`);
		} finally {
			patched.restore();
		}
	});

	test("session_shutdown cancels a non-terminal run", async () => {
		const fp = fakePi();
		multiHarness(fp.pi);
		const { ctx } = fakeCtx(cwdDir, () => "omp-session-1");
		await fireSessionStart(fp, ctx);

		const patched = patchAgentRun(CodexAgent, "codex");
		try {
			const askCodex = fp.tools.get("ask_codex");
			const agentRuns = fp.tools.get("agent_runs");
			if (!askCodex || !agentRuns) throw new Error("tools missing");

			const started = await askCodex.execute("call-1", { task: "will be cancelled", background: true }, undefined, undefined, ctx);
			const runId = started.details?.runId as string;
			await tick();
			expect(patched.calls).toHaveLength(1);

			await fireSessionShutdown(fp);

			// Same registry instance (shutdown does not replace it), so the run is still findable —
			// but it must now be terminal-and-cancelled, never left running.
			const after = await agentRuns.execute("call-2", { action: "status", runId }, undefined, undefined, ctx);
			expect(after.details?.status).toBe("cancelled");
		} finally {
			patched.restore();
		}
	});
});

describe("deliverBackgroundResult", () => {
	function baseConfig(): MultiHarnessConfig {
		return DEFAULTS;
	}

	function run(over: Partial<RunView> & { id: string; status: RunView["status"] }): RunView {
		return {
			agent: "codex",
			summary: "did the thing",
			task: "do the thing",
			cwd: "/repo",
			readOnly: false,
			startedAt: Date.now(),
			elapsedMs: 1200,
			phase: "completed",
			background: true,
			...over,
		};
	}

	test("always appends a durable entry regardless of status", () => {
		for (const status of ["done", "failed", "cancelled"] as const) {
			const fp = fakePi();
			const { ctx } = fakeCtx("/repo", () => "s1");
			deliverBackgroundResult({ pi: fp.pi, ctx, run: run({ id: `r-${status}`, status, output: "x" }), config: baseConfig() });
			expect(fp.appendEntries).toHaveLength(1);
			expect(fp.appendEntries[0]?.customType).toBe("multi-harness-run");
			expect((fp.appendEntries[0]?.data as { status: string }).status).toBe(status);
		}
	});

	test("notifies info on done, error on failed/cancelled", () => {
		const fp = fakePi();
		const { ctx, notices } = fakeCtx("/repo", () => "s1");

		deliverBackgroundResult({ pi: fp.pi, ctx, run: run({ id: "r1", status: "done", output: "all good" }), config: baseConfig() });
		deliverBackgroundResult({
			pi: fp.pi,
			ctx,
			run: run({ id: "r2", status: "failed", errorMessage: "boom", errorCode: "PROCESS_FAILED" }),
			config: baseConfig(),
		});
		deliverBackgroundResult({ pi: fp.pi, ctx, run: run({ id: "r3", status: "cancelled", errorMessage: "cancelled" }), config: baseConfig() });

		expect(notices).toHaveLength(3);
		expect(notices[0]?.type).toBe("info");
		expect(notices[1]?.type).toBe("error");
		expect(notices[2]?.type).toBe("error");
	});

	test("never calls pi.sendUserMessage — a background finish must not derail the current turn", () => {
		const fp = fakePi();
		const { ctx } = fakeCtx("/repo", () => "s1");
		for (const status of ["done", "failed", "cancelled"] as const) {
			deliverBackgroundResult({ pi: fp.pi, ctx, run: run({ id: `r-${status}`, status }), config: baseConfig() });
		}
		expect(fp.sendUserMessages).toEqual([]);
	});
});
