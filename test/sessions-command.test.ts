import { describe, expect, test } from "bun:test";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
	createFocusController,
	formatElapsed,
	handleSessionsArgs,
	renderRunTable,
	renderStatusLine,
} from "../src/commands/sessions.ts";
import type { RunRegistry, RunStatus, RunView } from "../src/runs/types.ts";

function view(over: Partial<RunView> & { id: string }): RunView {
	return {
		agent: "codex",
		mode: "implement",
		summary: "do the thing",
		task: "do the thing",
		cwd: "/repo",
		readOnly: false,
		status: "running" as RunStatus,
		startedAt: 0,
		elapsedMs: 134_000,
		phase: "running tests",
		background: false,
		...over,
	};
}

interface FakeCtx {
	ctx: ExtensionCommandContext;
	notices: { message: string; type?: string }[];
	widgets: unknown[];
	statuses: (string | undefined)[];
	intervals: number;
	cleared: number;
	tick: () => void;
}

function fakeCtx(): FakeCtx {
	const notices: { message: string; type?: string }[] = [];
	const widgets: unknown[] = [];
	const statuses: (string | undefined)[] = [];
	const state = { intervals: 0, cleared: 0, cb: undefined as (() => void) | undefined };
	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: "/repo",
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, type }),
			setWidget: (_key: string, content: unknown) => widgets.push(content),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			confirm: async () => true,
		},
		setInterval: (cb: () => void) => {
			state.intervals++;
			state.cb = cb;
			return { id: state.intervals } as unknown as Timer;
		},
		clearTimer: () => {
			state.cleared++;
		},
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notices,
		widgets,
		statuses,
		get intervals() {
			return state.intervals;
		},
		get cleared() {
			return state.cleared;
		},
		tick: () => state.cb?.(),
	} as FakeCtx;
}

function fakeRegistry(runs: RunView[]) {
	let focused: string | undefined;
	const cancelled: string[] = [];
	const registry: RunRegistry = {
		start: () => runs[0]!,
		list: () => runs,
		get: (id) => runs.find((r) => r.id === id),
		cancel: async (id) => {
			cancelled.push(id);
			const run = runs.find((r) => r.id === id);
			return run ? run.status === "running" || run.status === "queued" : false;
		},
		wait: async (id) => runs.find((r) => r.id === id),
		focus: (id) => {
			focused = id;
		},
		focused: () => focused,
		clearFinished: () => 2,
		tail: () => ["line one", "line two"],
		subscribe: () => () => {},
		shutdown: async () => {},
	};
	return { registry, cancelled, focusedNow: () => focused };
}

describe("formatElapsed", () => {
	test("renders the spec's m/s form with a padded seconds field", () => {
		expect(formatElapsed(134_000)).toBe("2m14s");
		expect(formatElapsed(48_000)).toBe("0m48s");
		expect(formatElapsed(242_000)).toBe("4m02s");
	});

	test("clamps nonsense and grows an hours field", () => {
		expect(formatElapsed(-5)).toBe("0m00s");
		expect(formatElapsed(3_734_000)).toBe("1h02m14s");
	});
});

describe("renderRunTable", () => {
	const runs = [
		view({ id: "r7c1", agent: "codex", mode: "implement", summary: "fix failing transaction tests" }),
		view({ id: "r7b9", agent: "claude", mode: "review", status: "done", elapsedMs: 48_000, summary: "review auth" }),
		view({ id: "r7a4", agent: "claude", mode: "plan", status: "failed", elapsedMs: 11_000, summary: "resume failed" }),
		view({ id: "r7a1", agent: "codex", mode: "test", status: "cancelled", elapsedMs: 90_000, summary: "suite" }),
		view({ id: "r7d0", agent: "codex", mode: "debug", status: "queued", elapsedMs: 0, summary: "waiting on lock" }),
	];

	test("one row per run with the status glyph and a focus marker", () => {
		const lines = renderRunTable(runs, "r7b9").split("\n");
		expect(lines).toHaveLength(5);
		expect(lines[0]).toContain("●");
		expect(lines[0]!.startsWith("   ")).toBe(true);
		expect(lines[1]!.startsWith(" ▸ ")).toBe(true);
		expect(lines[1]).toContain("✓");
		expect(lines[2]).toContain("✗");
		expect(lines[3]).toContain("⊘");
		expect(lines[4]).toContain("·");
	});

	test("columns line up across rows", () => {
		const lines = renderRunTable(runs).split("\n");
		const agentColumn = lines.map((l) => l.indexOf("codex") >= 0 ? l.indexOf("codex") : l.indexOf("claude"));
		expect(new Set(agentColumn).size).toBe(1);
	});

	test("elapsed and summary survive to the row", () => {
		expect(renderRunTable([runs[0]!])).toContain("2m14s");
		expect(renderRunTable([runs[0]!])).toContain("fix failing transaction tests");
	});

	test("the empty case names the commands that create runs", () => {
		const text = renderRunTable([]);
		expect(text).toContain("No delegated runs yet");
		expect(text).toContain("/codex");
		expect(text).toContain("/claude");
	});
});

describe("renderStatusLine", () => {
	test("agent · mode · elapsed · phase", () => {
		expect(renderStatusLine(view({ id: "r1" }))).toBe("codex · implement · 2m14s · running tests");
	});

	test("falls back to the status when no phase is known and skips a missing mode", () => {
		expect(renderStatusLine(view({ id: "r1", mode: undefined, phase: "", status: "queued" }))).toBe(
			"codex · 2m14s · queued",
		);
	});
});

describe("/sessions subcommands", () => {
	test("bare args list the runs", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([view({ id: "r7c1" })]);
		await handleSessionsArgs("", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.type).toBe("info");
		expect(f.notices[0]!.message).toContain("r7c1");
	});

	test("attach sets focus and paints widget + status", async () => {
		const f = fakeCtx();
		const { registry, focusedNow } = fakeRegistry([view({ id: "r7c1" })]);
		await handleSessionsArgs("attach r7c1", f.ctx, registry, createFocusController(() => registry));
		expect(focusedNow()).toBe("r7c1");
		expect(f.statuses[0]).toBe("codex · implement · 2m14s · running tests");
		expect(f.widgets[0]).toEqual([
			"r7c1 codex · implement — do the thing",
			"line one",
			"line two",
		]);
	});

	test("attach schedules the refresh through ctx.setInterval, never a raw timer", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([view({ id: "r7c1" })]);
		const focus = createFocusController(() => registry);
		await handleSessionsArgs("attach r7c1", f.ctx, registry, focus);
		expect(f.intervals).toBe(1);

		f.tick();
		expect(f.statuses).toHaveLength(2);

		focus.detach(f.ctx);
		expect(f.cleared).toBe(1);
		expect(f.widgets.at(-1)).toBeUndefined();
		expect(f.statuses.at(-1)).toBeUndefined();
	});

	test("a terminal run stops the tick but keeps the widget until detach", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([view({ id: "r7b9", status: "done" })]);
		const focus = createFocusController(() => registry);
		await handleSessionsArgs("attach r7b9", f.ctx, registry, focus);
		expect(f.cleared).toBe(1); // cleared from inside the first paint
		expect(f.widgets[0]).not.toBeUndefined();
	});

	test("detach clears focus without touching the runs", async () => {
		const f = fakeCtx();
		const { registry, focusedNow } = fakeRegistry([view({ id: "r7c1" })]);
		const focus = createFocusController(() => registry);
		await handleSessionsArgs("attach r7c1", f.ctx, registry, focus);
		await handleSessionsArgs("detach", f.ctx, registry, focus);
		expect(focusedNow()).toBeUndefined();
		expect(registry.list()).toHaveLength(1);
	});

	test("cancel cancels the named run", async () => {
		const f = fakeCtx();
		const { registry, cancelled } = fakeRegistry([view({ id: "r7c1" })]);
		await handleSessionsArgs("cancel r7c1", f.ctx, registry, createFocusController(() => registry));
		expect(cancelled).toEqual(["r7c1"]);
		expect(f.notices[0]!.message).toContain("Cancelled r7c1");
	});

	test("cancelling a finished run says so rather than pretending", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([view({ id: "r7b9", status: "done" })]);
		await handleSessionsArgs("cancel r7b9", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.message).toContain("already finished");
	});

	test("clear reports how many were dropped", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([]);
		await handleSessionsArgs("clear", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.message).toBe("Dropped 2 finished runs.");
	});

	test("unknown run id notifies, never throws", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([view({ id: "r7c1" })]);
		await handleSessionsArgs("attach nope", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.type).toBe("error");
		expect(f.notices[0]!.message).toContain("Unknown run id: nope");
	});

	test("a missing run id notifies usage", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([]);
		await handleSessionsArgs("cancel", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.message).toBe("Usage: /sessions cancel <runId>");
	});

	test("unknown subcommand notifies, never throws", async () => {
		const f = fakeCtx();
		const { registry } = fakeRegistry([]);
		await handleSessionsArgs("resume", f.ctx, registry, createFocusController(() => registry));
		expect(f.notices[0]!.type).toBe("error");
		expect(f.notices[0]!.message).toContain('Unknown subcommand "resume"');
	});
});
