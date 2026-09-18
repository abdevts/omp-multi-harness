import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULTS, type MultiHarnessConfig } from "../src/config/schema.ts";
import type { RunRegistry, RunStatus, RunView, StartRunInput } from "../src/runs/types.ts";
import { registerAgentRunsTool } from "../src/tools/agent-runs.ts";
import { registerDelegateTool } from "../src/tools/delegate.ts";

/** Minimal stand-in for `pi.zod`: the tools only build schemas, they never validate with them. */
function fakePi(): { pi: ExtensionAPI; tools: Map<string, ToolDef> } {
	const tools = new Map<string, ToolDef>();
	const node = (): unknown => {
		const self = { optional: () => self, describe: () => self };
		return self;
	};
	const zod = { object: node, string: node, number: node, boolean: node, enum: node };
	const pi = {
		zod,
		logger: { warn: () => {}, info: () => {} },
		registerTool: (def: ToolDef) => tools.set(def.name, def),
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

interface ToolResult {
	content: { type: "text"; text: string }[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

interface ToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: ExtensionContext,
	) => Promise<ToolResult>;
}

const ctx = { cwd: "/repo", ui: { setStatus: () => {} } } as unknown as ExtensionContext;

function view(over: Partial<RunView> & { id: string }): RunView {
	return {
		agent: "codex",
		summary: "do the thing",
		task: "do the thing",
		cwd: "/repo",
		readOnly: false,
		status: "running" as RunStatus,
		startedAt: Date.now(),
		elapsedMs: 1_500,
		phase: "working",
		background: true,
		...over,
	};
}

/** In-memory registry. Deterministic, never spawns anything. */
class FakeRegistry implements RunRegistry {
	runs: RunView[] = [];
	started: StartRunInput[] = [];
	cancelled: string[] = [];
	/** What `start` should hand back, and what `wait` should resolve to. */
	nextView: (input: StartRunInput, id: string) => RunView = (input, id) =>
		view({ id, agent: input.agent, mode: input.mode, readOnly: input.readOnly, background: input.background === true });
	waitResult: (id: string) => RunView | undefined = (id) => this.get(id);

	start(input: StartRunInput): RunView {
		this.started.push(input);
		const v = this.nextView(input, `run-${this.started.length}`);
		this.runs.push(v);
		return v;
	}
	list(): RunView[] {
		return this.runs;
	}
	get(id: string): RunView | undefined {
		return this.runs.find((r) => r.id === id);
	}
	async cancel(id: string): Promise<boolean> {
		this.cancelled.push(id);
		const run = this.get(id);
		if (!run || run.status !== "running") return false;
		Object.assign(run, { status: "cancelled" satisfies RunStatus });
		return true;
	}
	async wait(id: string): Promise<RunView | undefined> {
		return this.waitResult(id);
	}
	focus(): void {}
	focused(): string | undefined {
		return undefined;
	}
	clearFinished(): number {
		return 0;
	}
	tail(): string[] {
		return [];
	}
	subscribe(): () => void {
		return () => {};
	}
	async shutdown(): Promise<void> {}
}

function agentRuns(registry: RunRegistry, config: MultiHarnessConfig = DEFAULTS) {
	const { pi, tools } = fakePi();
	registerAgentRunsTool({ pi, getConfig: () => config, getRegistry: () => registry });
	const tool = tools.get("agent_runs");
	if (!tool) throw new Error("agent_runs was not registered");
	return (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx);
}

describe("agent_runs", () => {
	test("list: one compact line per run, and a plain sentence when there are none", async () => {
		const registry = new FakeRegistry();
		expect((await agentRuns(registry)({ action: "list" })).content[0]?.text).toBe("No agent runs in this session.");

		registry.runs.push(view({ id: "r1", mode: "implement" }), view({ id: "r2", agent: "claude", status: "done", summary: "review auth" }));
		const result = await agentRuns(registry)({ action: "list" });
		const lines = result.content[0]?.text.split("\n") ?? [];
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("r1 · codex · implement · running");
		expect(lines[1]).toContain("review auth");
		expect(result.details).toMatchObject({ count: 2 });
	});

	test("status: no output body, just where the run is", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1", output: "SECRET BODY", phase: "running tests" }));
		const result = await agentRuns(registry)({ action: "status", runId: "r1" });
		expect(result.content[0]?.text).toContain("running tests");
		expect(result.content[0]?.text).not.toContain("SECRET BODY");
		expect(result.isError).toBeFalsy();
	});

	test("result: returns the output of a finished run and refuses politely while it runs", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1", status: "done", output: "all green" }), view({ id: "r2" }));

		const done = await agentRuns(registry)({ action: "result", runId: "r1" });
		expect(done.content[0]?.text).toContain("all green");
		expect(done.isError).toBeFalsy();

		const running = await agentRuns(registry)({ action: "result", runId: "r2" });
		expect(running.content[0]?.text).toContain("still running");
		expect(running.isError).toBeFalsy();
	});

	test("result: a failed run is a tool error carrying its error code", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1", status: "failed", errorCode: "AGENT_TIMEOUT", errorMessage: "took too long" }));
		const result = await agentRuns(registry)({ action: "result", runId: "r1" });
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("AGENT_TIMEOUT: took too long");
	});

	test("result: long output is truncated from the middle at limits.maxOutputChars", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1", status: "done", output: `HEAD${"x".repeat(50_000)}TAIL` }));
		const config: MultiHarnessConfig = { ...DEFAULTS, limits: { ...DEFAULTS.limits, maxOutputChars: 1_000 } };
		const result = await agentRuns(registry, config)({ action: "result", runId: "r1" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("HEAD");
		expect(text).toContain("TAIL");
		expect(text).toContain("characters omitted");
		expect(result.details).toMatchObject({ truncated: true });
	});

	test("cancel: idempotent — a terminal run reports rather than throwing", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1" }), view({ id: "r2", status: "done" }));

		const first = await agentRuns(registry)({ action: "cancel", runId: "r1" });
		expect(first.content[0]?.text).toContain("Cancelled r1");
		expect(first.details).toMatchObject({ cancelled: true, status: "cancelled" });

		const again = await agentRuns(registry)({ action: "cancel", runId: "r2" });
		expect(again.content[0]?.text).toContain("already done");
		expect(again.isError).toBeFalsy();
	});

	test("wait: returns the result when terminal, and says so when the cap elapses first", async () => {
		const registry = new FakeRegistry();
		registry.runs.push(view({ id: "r1", status: "done", output: "joined" }), view({ id: "r2" }));

		const joined = await agentRuns(registry)({ action: "wait", runId: "r1" });
		expect(joined.content[0]?.text).toContain("joined");

		const timedOut = await agentRuns(registry)({ action: "wait", runId: "r2", waitMs: 10 });
		expect(timedOut.details).toMatchObject({ timedOut: true });
		expect(timedOut.content[0]?.text).toContain("still running");
	});

	test("an unknown run id and a missing run id are ordinary results, never throws", async () => {
		const registry = new FakeRegistry();
		for (const action of ["status", "result", "cancel", "wait"] as const) {
			const unknown = await agentRuns(registry)({ action, runId: "nope" });
			expect(unknown.content[0]?.text).toContain("No run with id nope");
			expect(unknown.isError).toBeFalsy();

			const bare = await agentRuns(registry)({ action });
			expect(bare.content[0]?.text).toContain("runId is required");
		}
	});
});

function delegate(registry: RunRegistry, config: MultiHarnessConfig = { ...DEFAULTS, routing: { ...DEFAULTS.routing, mode: "rules" } }) {
	const { pi, tools } = fakePi();
	registerDelegateTool({
		pi,
		getConfig: () => config,
		getRegistry: () => registry,
		// Both injected so the tool never spawns a detector or calls a model.
		getAvailability: async (agent) => ({ agent, available: true, auth: "ok", authDetail: "test" }),
		createRouter: () => undefined,
	});
	const tool = tools.get("delegate");
	if (!tool) throw new Error("delegate was not registered");
	return (params: Record<string, unknown>) => tool.execute("call-1", params, undefined, undefined, ctx);
}

describe("delegate", () => {
	test("auto routing is reported in the result, so it is auditable", async () => {
		const registry = new FakeRegistry();
		registry.waitResult = (id) => view({ id, status: "done", output: "done and dusted" });
		const result = await delegate(registry)({ task: "Implement this endpoint.", agent: "auto" });
		expect(registry.started[0]?.agent).toBe("codex");
		expect(result.details).toMatchObject({ routedBy: "rules" });
		expect(result.content[0]?.text).toContain("routed by rules");
		expect(result.content[0]?.text).toContain("done and dusted");
	});

	test("an explicit agent is passed straight through", async () => {
		const registry = new FakeRegistry();
		registry.waitResult = (id) => view({ id, agent: "claude", status: "done", output: "ok" });
		const result = await delegate(registry)({ task: "Implement this endpoint.", agent: "claude" });
		expect(registry.started[0]?.agent).toBe("claude");
		expect(result.details).toMatchObject({ routedBy: "explicit" });
	});

	test("background returns a run id immediately without waiting", async () => {
		const registry = new FakeRegistry();
		registry.waitResult = () => {
			throw new Error("background must not wait");
		};
		const result = await delegate(registry)({ task: "Run the test suite.", background: true });
		expect(result.details).toMatchObject({ status: "running", runId: "run-1" });
		expect(result.content[0]?.text).toContain("agent_runs");
	});

	test("the mode's read-only default and the model precedence reach the registry", async () => {
		const registry = new FakeRegistry();
		registry.waitResult = (id) => view({ id, status: "done", output: "ok" });
		const config: MultiHarnessConfig = {
			...DEFAULTS,
			routing: { ...DEFAULTS.routing, mode: "rules" },
			claude: { ...DEFAULTS.claude, model: "configured-model" },
		};
		await delegate(registry, config)({ task: "look at auth", mode: "review" });
		expect(registry.started[0]).toMatchObject({ agent: "claude", readOnly: true, model: "configured-model" });

		await delegate(registry, config)({ task: "look at auth", mode: "review", model: "per-call-model" });
		expect(registry.started[1]?.model).toBe("per-call-model");

		await delegate(registry, { ...config, claude: { ...config.claude, model: null } })({ task: "look at auth", mode: "review" });
		// No model anywhere → the flag is omitted and the CLI's own config decides.
		expect(registry.started[2]?.model).toBeUndefined();
	});

	test("no available agent is a tool error with an actionable message, not a throw", async () => {
		const registry = new FakeRegistry();
		const { pi, tools } = fakePi();
		registerDelegateTool({
			pi,
			getConfig: () => ({ ...DEFAULTS, routing: { ...DEFAULTS.routing, mode: "rules" } }),
			getRegistry: () => registry,
			getAvailability: async (agent) => ({ agent, available: false, auth: "unknown", authDetail: "-", reason: "not on PATH" }),
			createRouter: () => undefined,
		});
		const result = await tools.get("delegate")!.execute("call-1", { task: "anything" }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("No agent is available");
		expect(registry.started).toHaveLength(0);
	});

	test("one unavailable agent falls back to the other rather than failing", async () => {
		const registry = new FakeRegistry();
		registry.waitResult = (id) => view({ id, agent: "claude", status: "done", output: "ok" });
		const { pi, tools } = fakePi();
		registerDelegateTool({
			pi,
			getConfig: () => ({ ...DEFAULTS, routing: { ...DEFAULTS.routing, mode: "rules" } }),
			getRegistry: () => registry,
			getAvailability: async (agent) =>
				agent === "codex"
					? { agent, available: false, auth: "unknown", authDetail: "-", reason: "`codex` not found on PATH" }
					: { agent, available: true, auth: "ok", authDetail: "test" },
			createRouter: () => undefined,
		});
		const result = await tools.get("delegate")!.execute("call-1", { task: "Implement this endpoint." }, undefined, undefined, ctx);
		expect(registry.started[0]?.agent).toBe("claude");
		expect(result.details).toMatchObject({ routedBy: "fallback" });
		expect(result.content[0]?.text).toContain("not found on PATH");
	});
});
